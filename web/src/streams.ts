import type { RunEvent } from '../../shared/types';
import { ApiError, api, eventsUrl } from './api';
import { markOpenConversationMissing, refreshConversations, replaceOpenConversation } from './actions';
import { parseRunEvent } from './lib/events';
import { applyRunEvents } from './lib/reducer';
import { getState, runningTurnIds, setState, useStore, withOpenTurn, type AppState, type StreamState } from './store';

/**
 * Event streams for running turns of the open conversation.
 *
 * Driven by a store subscription rather than React effects, so there is exactly one
 * EventSource per running turn regardless of how components mount (StrictMode double effects
 * included). Leaving the conversation closes its streams; returning re-subscribes, and every
 * (re)connection starts with a fresh snapshot from the server.
 */

interface Entry {
  conversationId: string;
  turnId: string;
  source: EventSource | null;
  /** Set once turn.end arrives, so the closed connection is not treated as a failure. */
  ended: boolean;
  attempt: number;
  retryTimer: number | null;
}

const entries = new Map<string, Entry>();

interface Queued {
  conversationId: string;
  turnId: string;
  event: RunEvent;
}

let queue: Queued[] = [];
let frame: number | null = null;
let fallbackTimer: number | null = null;

function setStreamState(turnId: string, value: StreamState | null): void {
  setState((s) => {
    if (value === null) {
      if (!(turnId in s.streams)) return {};
      const next = { ...s.streams };
      delete next[turnId];
      return { streams: next };
    }
    return s.streams[turnId] === value ? {} : { streams: { ...s.streams, [turnId]: value } };
  });
}

function scheduleFlush(): void {
  if (frame === null) frame = window.requestAnimationFrame(flush);
  // Animation frames pause in background tabs; keep applying events at a slower pace there.
  if (fallbackTimer === null) fallbackTimer = window.setTimeout(flush, 250);
}

/** Applies every queued event in one store update, at most once per animation frame. */
function flush(): void {
  if (frame !== null) window.cancelAnimationFrame(frame);
  if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
  frame = null;
  fallbackTimer = null;
  const batch = queue;
  queue = [];
  if (batch.length === 0) return;

  const groups = new Map<string, { conversationId: string; turnId: string; events: RunEvent[] }>();
  let turnEnded = false;
  for (const item of batch) {
    if (item.event.type === 'turn.end') turnEnded = true;
    const key = `${item.conversationId}/${item.turnId}`;
    const group = groups.get(key);
    if (group) group.events.push(item.event);
    else groups.set(key, { conversationId: item.conversationId, turnId: item.turnId, events: [item.event] });
  }

  setState((state) => {
    let next: AppState = state;
    for (const g of groups.values()) {
      next = { ...next, ...withOpenTurn(next, g.conversationId, g.turnId, (turn) => applyRunEvents(turn, g.events)) };
    }
    return next === state ? {} : { open: next.open };
  });

  if (turnEnded) void refreshConversations();
}

function connect(entry: Entry): void {
  setStreamState(entry.turnId, entry.attempt > 0 ? 'reconnecting' : 'connecting');
  const source = new EventSource(eventsUrl(entry.conversationId, entry.turnId));
  entry.source = source;

  source.onopen = () => {
    if (entries.get(entry.turnId) !== entry) return;
    entry.attempt = 0;
    setStreamState(entry.turnId, 'live');
  };

  source.onmessage = (message: MessageEvent<string>) => {
    if (entries.get(entry.turnId) !== entry) return;
    const event = parseRunEvent(message.data);
    if (!event) return;
    if (event.type === 'turn.end') {
      // The server ends the response after turn.end; close first so EventSource does not
      // reconnect to a finished turn.
      entry.ended = true;
      source.close();
      entry.source = null;
    }
    queue.push({ conversationId: entry.conversationId, turnId: entry.turnId, event });
    scheduleFlush();
  };

  source.onerror = () => {
    if (entries.get(entry.turnId) !== entry || entry.ended) return;
    if (source.readyState === EventSource.CLOSED) {
      // The browser gave up (HTTP error or proxy failure); retry ourselves with backoff.
      entry.source = null;
      scheduleRetry(entry);
    } else {
      // The browser reconnects by itself; the new connection begins with a snapshot.
      setStreamState(entry.turnId, 'reconnecting');
    }
  };
}

function scheduleRetry(entry: Entry): void {
  entry.attempt += 1;
  setStreamState(entry.turnId, 'reconnecting');
  const delay = Math.min(15_000, 1000 * 2 ** (entry.attempt - 1));
  entry.retryTimer = window.setTimeout(() => {
    entry.retryTimer = null;
    void retry(entry);
  }, delay);
}

/** Checks the turn is still running before reconnecting, so a gone turn is not polled forever. */
async function retry(entry: Entry): Promise<void> {
  try {
    const conversation = await api.conversation(entry.conversationId);
    if (entries.get(entry.turnId) !== entry) return;
    const turn = conversation.turns.find((t) => t.id === entry.turnId);
    if (!turn || turn.status !== 'running') {
      // Fresh data shows the turn finished; the store subscription closes this entry.
      replaceOpenConversation(conversation);
      void refreshConversations();
      return;
    }
    connect(entry);
  } catch (err) {
    if (entries.get(entry.turnId) !== entry) return;
    if (err instanceof ApiError && err.status === 404) {
      markOpenConversationMissing(entry.conversationId);
      return;
    }
    scheduleRetry(entry);
  }
}

function open(conversationId: string, turnId: string): void {
  const entry: Entry = { conversationId, turnId, source: null, ended: false, attempt: 0, retryTimer: null };
  entries.set(turnId, entry);
  connect(entry);
}

function close(turnId: string): void {
  const entry = entries.get(turnId);
  if (!entry) return;
  entries.delete(turnId);
  entry.source?.close();
  if (entry.retryTimer !== null) window.clearTimeout(entry.retryTimer);
  setStreamState(turnId, null);
}

function sync(conversationId: string | null, turnIds: string[]): void {
  for (const [turnId, entry] of [...entries]) {
    if (entry.conversationId !== conversationId || !turnIds.includes(turnId)) close(turnId);
  }
  if (!conversationId) return;
  for (const turnId of turnIds) if (!entries.has(turnId)) open(conversationId, turnId);
}

/** Starts keeping streams in line with the store. Returns a function that closes everything. */
export function startStreamSync(): () => void {
  let lastKey = '';
  const update = (state: AppState) => {
    const conversationId = state.open?.status === 'ready' ? state.open.id : null;
    const turnIds = conversationId ? runningTurnIds(state) : [];
    const key = conversationId ? `${conversationId}|${turnIds.join(',')}` : '';
    if (key === lastKey) return;
    lastKey = key;
    sync(conversationId, turnIds);
  };
  update(getState());
  const unsubscribe = useStore.subscribe(update);
  return () => {
    unsubscribe();
    lastKey = '';
    sync(null, []);
  };
}
