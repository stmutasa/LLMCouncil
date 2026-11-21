import type { Conversation, ConversationSummary, SendTurnResponse, Settings, Turn } from '../../shared/types';
import { ApiError, api, errorMessage } from './api';
import { parsePath, pathFor } from './lib/routes';
import { writeStorage } from './lib/storage';
import {
  STORAGE_KEYS,
  conversationKey,
  getState,
  nextToastId,
  setState,
  type AppState,
  type ConversationKey,
  type Route,
  type SettingsTab,
  type ThemePreference,
} from './store';

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

const TOAST_MS = 9000;

export function showToast(message: string): void {
  const id = nextToastId();
  setState((s) => ({ toasts: [...s.toasts.filter((t) => t.message !== message), { id, message }].slice(-4) }));
  window.setTimeout(() => dismissToast(id), TOAST_MS);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

let confirmedSettings: Settings | null = null;

export async function boot(): Promise<void> {
  setState({ boot: { status: 'loading', error: null } });
  try {
    const [meta, settings, conversations] = await Promise.all([api.meta(), api.settings(), api.conversations()]);
    confirmedSettings = settings;
    setState({ meta, settings, conversations: sortSummaries(conversations), boot: { status: 'ready', error: null } });
  } catch (err) {
    setState({ boot: { status: 'error', error: errorMessage(err) } });
    return;
  }
  void loadProviders(false);
  applyRoute(parseLocation(), true);
}

export async function loadProviders(refresh: boolean): Promise<void> {
  setState((s) => ({ providers: { ...s.providers, loading: true, error: null } }));
  try {
    const list = await api.providers(refresh);
    setState({ providers: { list, loading: false, error: null } });
  } catch (err) {
    setState((s) => ({ providers: { list: s.providers.list, loading: false, error: errorMessage(err) } }));
  }
}

// ---------------------------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------------------------

function sortSummaries(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

function upsertSummary(list: ConversationSummary[], summary: ConversationSummary): ConversationSummary[] {
  return sortSummaries([summary, ...list.filter((c) => c.id !== summary.id)]);
}

let listErrorShown = false;
let listRequest: Promise<void> | null = null;
let listRequestAgain = false;

/** Re-reads the conversation list. Concurrent calls collapse into one follow-up request. */
export function refreshConversations(): Promise<void> {
  if (listRequest) {
    listRequestAgain = true;
    return listRequest;
  }
  listRequest = (async () => {
    try {
      const list = await api.conversations();
      listErrorShown = false;
      setState({ conversations: sortSummaries(list) });
    } catch (err) {
      // Background refreshes repeat; report a failure once until a refresh succeeds again.
      if (!listErrorShown) showToast(`Could not refresh the conversation list: ${errorMessage(err)}`);
      listErrorShown = true;
    } finally {
      listRequest = null;
      if (listRequestAgain) {
        listRequestAgain = false;
        void refreshConversations();
      }
    }
  })();
  return listRequest;
}

const POLL_MS = 5000;

/**
 * Conversations running in the background (started, then left) only change their sidebar
 * spinner when the list is re-read, so poll while any is marked running.
 */
export function startListPolling(): () => void {
  const id = window.setInterval(() => {
    const s = getState();
    if (s.boot.status !== 'ready' || document.hidden) return;
    if (s.conversations.some((c) => c.running)) void refreshConversations();
  }, POLL_MS);
  return () => window.clearInterval(id);
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

function parseLocation(): Route {
  return parsePath(window.location.pathname);
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path = pathFor(route);
  if (window.location.pathname !== path) {
    if (options.replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
  }
  applyRoute(route, false);
}

export function handlePopState(): void {
  applyRoute(parseLocation(), false);
}

function applyRoute(route: Route, initial: boolean): void {
  const canonical = pathFor(route);
  if (initial && window.location.pathname !== canonical) window.history.replaceState(null, '', canonical);
  setState({ route, mobileSidebarOpen: false });
  if (route.kind === 'home') {
    setState({ open: null });
    return;
  }
  const open = getState().open;
  if (open && open.id === route.id && (open.status === 'ready' || open.status === 'loading')) return;
  void loadConversation(route.id);
}

let loadSeq = 0;

export async function loadConversation(id: string): Promise<void> {
  // Only the latest request may fill the view (A → B → A must not show A's older response).
  const seq = ++loadSeq;
  const current = () => seq === loadSeq && getState().open?.id === id;
  setState({ open: { id, status: 'loading', conversation: null, error: null } });
  try {
    const conversation = await api.conversation(id);
    if (!current()) return;
    setState({ open: { id, status: 'ready', conversation, error: null } });
  } catch (err) {
    if (!current()) return;
    const notFound = err instanceof ApiError && (err.status === 404 || err.status === 400);
    setState({ open: { id, status: notFound ? 'notfound' : 'error', conversation: null, error: errorMessage(err) } });
  }
}

/** Replaces the open conversation with fresh server data (used after a stream gives up). */
export function replaceOpenConversation(conversation: Conversation): void {
  setState((s) =>
    s.open && s.open.id === conversation.id ? { open: { ...s.open, status: 'ready', conversation, error: null } } : {},
  );
}

export function markOpenConversationMissing(id: string): void {
  setState((s) =>
    s.open && s.open.id === id
      ? { open: { id, status: 'notfound', conversation: null, error: 'This conversation no longer exists.' } }
      : {},
  );
  void refreshConversations();
}

// ---------------------------------------------------------------------------------------------
// Composer and turns
// ---------------------------------------------------------------------------------------------

export function setDraft(key: ConversationKey, text: string): void {
  setState((s) => ({ drafts: { ...s.drafts, [key]: text } }));
}

export function clearComposerError(key: ConversationKey): void {
  setState((s) => {
    if (!(key in s.composerErrors)) return {};
    const next = { ...s.composerErrors };
    delete next[key];
    return { composerErrors: next };
  });
}

function setComposerError(key: ConversationKey, message: string): void {
  setState((s) => ({ composerErrors: { ...s.composerErrors, [key]: message } }));
}

function appendTurn(state: AppState, conversationId: string, turn: Turn, replaceTurnId?: string): Partial<AppState> {
  const open = state.open;
  if (!open || open.id !== conversationId || !open.conversation) return {};
  const others = open.conversation.turns.filter((t) => t.id !== turn.id && t.id !== replaceTurnId);
  return { open: { ...open, conversation: { ...open.conversation, turns: [...others, turn] } } };
}

/** Posts a message from the composer identified by `key` ('' = new chat). */
export async function sendMessage(key: ConversationKey, message: string): Promise<void> {
  const state = getState();
  if (state.pendingSend) return;
  clearComposerError(key);
  setState((s) => ({ pendingSend: { key, message }, drafts: { ...s.drafts, [key]: '' } }));

  let response: SendTurnResponse;
  try {
    response = await api.sendTurn(key ? { conversationId: key, message } : { message });
  } catch (err) {
    setState((s) => ({
      pendingSend: null,
      // Restore the message unless the user has started typing something else meanwhile.
      drafts: { ...s.drafts, [key]: s.drafts[key] ? s.drafts[key]! : message },
    }));
    setComposerError(key, errorMessage(err));
    return;
  }

  const { conversation: summary, turn } = response;
  setState((s) => ({ pendingSend: null, conversations: upsertSummary(s.conversations, summary) }));
  if (key) {
    setState((s) => appendTurn(s, key, turn));
    return;
  }
  // A new conversation: open it with the turn we already have, without another round trip.
  const conversation: Conversation = {
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    turns: [turn],
  };
  if (getState().route.kind === 'home') {
    setState({ open: { id: summary.id, status: 'ready', conversation, error: null } });
    navigate({ kind: 'conversation', id: summary.id });
  }
}

function setTurnAction(turnId: string, action: 'stop' | 'skip' | 'regenerate' | null): void {
  setState((s) => {
    const next = { ...s.turnActions };
    if (action) next[turnId] = action;
    else delete next[turnId];
    return { turnActions: next };
  });
}

export async function stopTurn(conversationId: string, turnId: string): Promise<void> {
  if (getState().turnActions[turnId] === 'stop') return;
  setTurnAction(turnId, 'stop');
  try {
    await api.stopTurn(conversationId, turnId);
  } catch (err) {
    setComposerError(conversationId, `Could not stop the run: ${errorMessage(err)}`);
  } finally {
    setTurnAction(turnId, null);
  }
}

export async function skipToVerdict(conversationId: string, turnId: string): Promise<void> {
  if (getState().turnActions[turnId]) return;
  setTurnAction(turnId, 'skip');
  try {
    await api.skipTurn(conversationId, turnId);
  } catch (err) {
    setComposerError(conversationId, `Could not skip to the verdict: ${errorMessage(err)}`);
  } finally {
    setTurnAction(turnId, null);
  }
}

/** Reruns the last turn. Returns an error message for the caller to show, or null on success. */
export async function regenerateTurn(conversationId: string, turnId: string): Promise<string | null> {
  if (getState().turnActions[turnId]) return null;
  setTurnAction(turnId, 'regenerate');
  try {
    const { conversation: summary, turn } = await api.regenerateTurn(conversationId, turnId);
    setState((s) => ({ ...appendTurn(s, conversationId, turn, turnId), conversations: upsertSummary(s.conversations, summary) }));
    return null;
  } catch (err) {
    return `Could not regenerate: ${errorMessage(err)}`;
  } finally {
    setTurnAction(turnId, null);
  }
}

// ---------------------------------------------------------------------------------------------
// Conversation management
// ---------------------------------------------------------------------------------------------

/** Throws with a presentable message on failure. */
export async function renameConversation(id: string, title: string): Promise<void> {
  const summary = await api.renameConversation(id, title);
  setState((s) => ({
    conversations: s.conversations.map((c) => (c.id === id ? summary : c)),
    open:
      s.open && s.open.id === id && s.open.conversation
        ? { ...s.open, conversation: { ...s.open.conversation, title: summary.title } }
        : s.open,
  }));
}

/** Throws with a presentable message on failure. */
export async function deleteConversation(id: string): Promise<void> {
  await api.deleteConversation(id);
  setState((s) => {
    const drafts = { ...s.drafts };
    delete drafts[id];
    return { conversations: s.conversations.filter((c) => c.id !== id), drafts };
  });
  if (getState().route.kind === 'conversation' && conversationKey(getState().route) === id) {
    navigate({ kind: 'home' }, { replace: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/**
 * All settings writes go through one chain so they reach the server in order, and every
 * quick change (composer controls) is applied to the latest settings in the store rather than
 * to a copy captured earlier, so concurrent changes are never lost.
 */
let settingsChain: Promise<void> = Promise.resolve();
let localVersion = 0;
let quickSaveQueued = false;
let quickSaveLabel = '';

export function changeSettings(mutate: (current: Settings) => Settings, label: string): void {
  const current = getState().settings;
  if (!current) return;
  const next = mutate(current);
  if (next === current) return;
  localVersion += 1;
  quickSaveLabel = label;
  setState({ settings: next });
  if (quickSaveQueued) return;
  quickSaveQueued = true;
  settingsChain = settingsChain.then(async () => {
    quickSaveQueued = false;
    const version = localVersion;
    const body = getState().settings;
    if (!body) return;
    try {
      const saved = await api.saveSettings(body);
      confirmedSettings = saved;
      if (localVersion === version) setState({ settings: saved });
    } catch (err) {
      if (localVersion === version && confirmedSettings) setState({ settings: confirmedSettings });
      showToast(`Could not save ${quickSaveLabel}: ${errorMessage(err)}`);
    }
  });
}

/** Saves the settings dialog's draft. Resolves with the saved settings; rejects with the server's error. */
export function saveSettingsDraft(draft: Settings): Promise<Settings> {
  return new Promise<Settings>((resolve, reject) => {
    settingsChain = settingsChain.then(async () => {
      try {
        const saved = await api.saveSettings(draft);
        const before = confirmedSettings;
        confirmedSettings = saved;
        localVersion += 1;
        setState({ settings: saved });
        resolve(saved);
        const providersChanged =
          !before ||
          JSON.stringify(before.providers) !== JSON.stringify(saved.providers) ||
          JSON.stringify(before.customProviders) !== JSON.stringify(saved.customProviders) ||
          before.stripApiKeys !== saved.stripApiKeys;
        if (providersChanged) void loadProviders(true);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(errorMessage(err)));
      }
    });
  });
}

export function openSettings(tab: SettingsTab = 'council'): void {
  setState({ settingsDialog: { open: true, tab }, mobileSidebarOpen: false });
}

export function closeSettings(): void {
  setState((s) => ({ settingsDialog: { ...s.settingsDialog, open: false } }));
}

// ---------------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------------

export function setTheme(theme: ThemePreference): void {
  writeStorage(STORAGE_KEYS.theme, theme);
  setState({ theme });
}

export function toggleSidebarCollapsed(): void {
  const next = !getState().sidebarCollapsed;
  writeStorage(STORAGE_KEYS.sidebarCollapsed, next ? '1' : '0');
  setState({ sidebarCollapsed: next });
}

export function setMobileSidebarOpen(open: boolean): void {
  setState({ mobileSidebarOpen: open });
}
