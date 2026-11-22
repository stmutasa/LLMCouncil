import { create } from 'zustand';
import type {
  Conversation,
  ConversationSummary,
  LibraryStatus,
  MetaResponse,
  NotionStatus,
  ProviderInfo,
  Settings,
  Turn,
} from '../../shared/types';
import type { AttachedDocument } from './lib/library';
import { readStorage } from './lib/storage';

export type Route = { kind: 'home' } | { kind: 'conversation'; id: string };

export type SettingsTab = 'council' | 'protocol' | 'arbiter' | 'library' | 'providers' | 'general';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface OpenConversation {
  id: string;
  status: 'loading' | 'ready' | 'notfound' | 'error';
  conversation: Conversation | null;
  error: string | null;
}

/** Connection state of the event stream for a running turn. */
export type StreamState = 'connecting' | 'live' | 'reconnecting';

export interface Toast {
  id: number;
  message: string;
}

/** Key for per-conversation UI state; '' is the new-chat composer. */
export type ConversationKey = string;

export interface AppState {
  boot: { status: 'loading' | 'ready' | 'error'; error: string | null };
  meta: MetaResponse | null;
  settings: Settings | null;
  providers: { list: ProviderInfo[] | null; loading: boolean; error: string | null };
  conversations: ConversationSummary[];
  route: Route;
  open: OpenConversation | null;
  streams: Record<string, StreamState>;
  /** A message being posted; shown optimistically in the thread until the server answers. */
  pendingSend: { key: ConversationKey; message: string; attachments: AttachedDocument[] } | null;
  composerErrors: Record<ConversationKey, string>;
  drafts: Record<ConversationKey, string>;
  /** Turn ids with a stop/skip/regenerate request in flight. */
  turnActions: Record<string, 'stop' | 'skip' | 'regenerate'>;
  settingsDialog: { open: boolean; tab: SettingsTab };
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  toasts: Toast[];
  theme: ThemePreference;
  /** GET /api/library, polled while a source is syncing. `error` is the last failed check. */
  library: { status: LibraryStatus | null; error: string | null };
  notion: { status: NotionStatus | null; loading: boolean; error: string | null };
  /** Documents attached in each composer; they stay attached for later questions. */
  attachments: Record<ConversationKey, AttachedDocument[]>;
  /** What was attached to a turn when it was sent, shown until the server reports its own list. */
  sentAttachments: Record<string, AttachedDocument[]>;
  /** A citation chip was activated: the turn's Sources block opens and shows the item. */
  citationTarget: { turnId: string; id: string; seq: number } | null;
}

export const STORAGE_KEYS = {
  theme: 'llm-council.theme',
  sidebarCollapsed: 'llm-council.sidebar-collapsed',
} as const;

function initialTheme(): ThemePreference {
  const stored = readStorage(STORAGE_KEYS.theme);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export const useStore = create<AppState>()(() => ({
  boot: { status: 'loading', error: null },
  meta: null,
  settings: null,
  providers: { list: null, loading: false, error: null },
  conversations: [],
  route: { kind: 'home' },
  open: null,
  streams: {},
  pendingSend: null,
  composerErrors: {},
  drafts: {},
  turnActions: {},
  settingsDialog: { open: false, tab: 'council' },
  sidebarCollapsed: readStorage(STORAGE_KEYS.sidebarCollapsed) === '1',
  mobileSidebarOpen: false,
  toasts: [],
  theme: initialTheme(),
  library: { status: null, error: null },
  notion: { status: null, loading: false, error: null },
  attachments: {},
  sentAttachments: {},
  citationTarget: null,
}));

export const getState = useStore.getState;
export const setState = useStore.setState;

/** Replaces one turn of the open conversation (matched by id); a no-op if it is not open. */
export function withOpenTurn(state: AppState, conversationId: string, turnId: string, fn: (turn: Turn) => Turn): Partial<AppState> {
  const open = state.open;
  if (!open || open.id !== conversationId || !open.conversation) return {};
  const turns = open.conversation.turns;
  const pos = turns.findIndex((t) => t.id === turnId);
  if (pos === -1) return {};
  const updated = fn(turns[pos]!);
  if (updated === turns[pos]) return {};
  const nextTurns = turns.slice();
  nextTurns[pos] = updated;
  return { open: { ...open, conversation: { ...open.conversation, turns: nextTurns } } };
}

export function conversationKey(route: Route): ConversationKey {
  return route.kind === 'conversation' ? route.id : '';
}

/** Running turns of the open conversation (normally at most one). */
export function runningTurnIds(state: AppState): string[] {
  const conv = state.open?.status === 'ready' ? state.open.conversation : null;
  if (!conv) return [];
  return conv.turns.filter((t) => t.status === 'running').map((t) => t.id);
}

let toastSeq = 0;
export function nextToastId(): number {
  toastSeq += 1;
  return toastSeq;
}
