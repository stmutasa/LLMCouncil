/**
 * Shared contract between the server (server/) and the web app (web/).
 * Everything that crosses the HTTP boundary or is persisted to disk is typed here.
 * Keep this file free of runtime code and of Node- or DOM-specific types.
 */

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Built-in ids: 'claude' | 'codex' | 'antigravity' | 'mock'. Custom providers add their own. */
export type ProviderId = string;

export type AuthState = 'ok' | 'missing' | 'unknown';
export type BillingMode = 'subscription' | 'api-key' | 'unknown';

/** Live status of one provider, as reported by GET /api/providers. */
export interface ProviderInfo {
  id: ProviderId;
  /** Short name, e.g. "Claude". */
  label: string;
  /** What actually runs, e.g. "Claude Code CLI". */
  cliName: string;
  vendor: string;
  kind: 'builtin' | 'custom' | 'mock';
  /** The command that will be executed (binary name or absolute path). */
  command: string;
  installed: boolean;
  version: string | null;
  /** Whether the CLI is signed in. 'unknown' when the CLI offers no way to check without a model call. */
  auth: AuthState;
  /** Human-readable description of the auth state. */
  authDetail: string;
  /** How calls will be billed, as far as it can be determined without making a call. */
  billing: BillingMode;
  /** Things the user should know, e.g. an API-key variable found in the environment. */
  warnings: string[];
  effortLevels: string[];
  /** 'toggle': the app can switch web search on/off. 'builtin': the CLI decides. 'none': unsupported. */
  webSearch: 'toggle' | 'builtin' | 'none';
  /** False when the CLI only delivers whole messages (no token streaming). */
  streams: boolean;
  modelSuggestions: string[];
  /** True when GET /api/providers/:id/models can ask the CLI for its live model list. */
  canListModels: boolean;
  installHint: string;
  loginHint: string;
  docsUrl: string;
}

/** Per-provider overrides stored in settings. */
export interface ProviderSettings {
  /** Binary name or absolute path. '' = the provider's default command. */
  command: string;
  /** Extra CLI arguments appended to the built-in ones. */
  extraArgs: string[];
  /** Per-call timeout in seconds. 0 = use Settings.defaultTimeoutSec. */
  timeoutSec: number;
  /**
   * How the prompt reaches the CLI, for providers that support both ('antigravity').
   * 'stdin' (default) has no length limit; 'arg' passes it as a command-line argument.
   */
  promptMode: 'stdin' | 'arg';
}

/** A user-defined CLI provider (settings file only; plain-text stdout). */
export interface CustomProviderConfig {
  id: string;
  label: string;
  command: string;
  /** Arguments. The literal token "{model}" is replaced by the member's model. */
  args: string[];
  /** Arguments inserted only when the member has a model set; "{model}" is replaced. */
  modelArgs: string[];
  /** 'stdin': prompt is written to stdin. 'arg': prompt is appended as the last argument. */
  promptVia: 'stdin' | 'arg';
}

export interface ProviderTestResult {
  ok: boolean;
  text: string;
  error: string | null;
  durationMs: number;
  model: string | null;
  billing: BillingMode;
  /** Tail of raw CLI output, for troubleshooting. */
  diagnostics: string;
}

export interface ProviderModelsResult {
  models: string[];
  source: 'cli' | 'static';
  error: string | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface MemberConfig {
  id: string;
  /** Display name; unique among members (case-insensitive). Used for @mentions. */
  name: string;
  provider: ProviderId;
  /** '' = the CLI's default model. */
  model: string;
  /** '' = the CLI's default reasoning effort. */
  effort: string;
  /** 'none', a built-in role id, or 'custom'. */
  roleId: string;
  /** Role text used when roleId === 'custom'. */
  customRole: string;
  /** Disabled members stay configured but do not take part (unless @mentioned). */
  enabled: boolean;
  /** Hex colour, e.g. "#d97757". */
  color: string;
}

/**
 * answer — every member answers the question independently.
 * review — every member critiques the others' current answers and ranks them.
 * revise — every member sees the others' current answers (and any reviews) and rewrites its own.
 */
export type RoundType = 'answer' | 'review' | 'revise';

export interface RoundConfig {
  id: string;
  type: RoundType;
  /** '' = default title for the type. */
  title: string;
  /** The user's rules for this round; injected into every member's prompt. '' = none. */
  instructions: string;
  /** review/revise: hide who wrote each peer response. */
  anonymize: boolean;
  /** review only: members also review and rank their own answer. */
  includeSelf: boolean;
}

export interface Protocol {
  id: string;
  name: string;
  description: string;
  /** Built-in presets are read-only; duplicate to customise. */
  builtin: boolean;
  /** 1..MAX_ROUNDS rounds. rounds[0].type is always 'answer'; later rounds are 'review' or 'revise'. */
  rounds: RoundConfig[];
}

export interface ArbiterConfig {
  /** Display name, e.g. "Claude". */
  name: string;
  provider: ProviderId;
  model: string;
  effort: string;
  /** The user's rules for the arbiter. '' = none. */
  instructions: string;
  /** When true the arbiter writes a short council analysis before the final answer. */
  analysis: boolean;
}

export interface Settings {
  version: 1;
  members: MemberConfig[];
  protocols: Protocol[];
  activeProtocolId: string;
  arbiter: ArbiterConfig;
  /** Rules applied to every member in every round. '' = none. */
  councilRules: string;
  /** Let members use web search where the provider supports toggling it. */
  webSearch: boolean;
  /** Per-call timeout in seconds. */
  defaultTimeoutSec: number;
  /** Character budget for earlier turns included in follow-up prompts. */
  maxHistoryChars: number;
  /** Remove API-key environment variables from CLI calls so they bill the subscription login. */
  stripApiKeys: boolean;
  providers: Record<ProviderId, ProviderSettings>;
  customProviders: CustomProviderConfig[];
}

export interface RoleDef {
  id: string;
  label: string;
  /** One-line description shown in the UI. */
  description: string;
  /** Text injected into the member's prompt. '' for 'none' and 'custom'. */
  prompt: string;
}

// ---------------------------------------------------------------------------
// Conversations and turns
// ---------------------------------------------------------------------------

/**
 * running     — in progress on the server.
 * complete    — finished with a final answer.
 * error       — finished without a final answer.
 * stopped     — the user stopped it.
 * interrupted — the server went away mid-run.
 */
export type TurnStatus = 'running' | 'complete' | 'error' | 'stopped' | 'interrupted';

/**
 * pending — not started. running — CLI call in flight. done — finished successfully.
 * error — the call failed. skipped — not run, or cut short by "skip to verdict"/stop.
 */
export type CallStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

/** Frozen copy of a member's configuration at the time a turn started. */
export interface MemberSnapshot {
  id: string;
  name: string;
  provider: ProviderId;
  /** Provider label at the time, e.g. "Claude". */
  providerLabel: string;
  model: string;
  effort: string;
  roleId: string;
  /** Resolved role label, '' when none. */
  roleLabel: string;
  color: string;
}

/** One model call: a member's contribution to a round, or the arbiter's verdict. */
export interface CallResult {
  status: CallStatus;
  /** Text so far (streaming) or the complete text. */
  text: string;
  /** Transient progress label such as "Thinking…" or "Searching the web…"; '' when none. */
  activity: string;
  error: string | null;
  startedAt: string | null;
  durationMs: number | null;
  /** Model name reported by the CLI, if any. */
  model: string | null;
  billing: BillingMode;
}

export interface MemberResponse extends CallResult {
  memberId: string;
  /** Review rounds: labels in ranked order (best first), e.g. ["C","A"]. null if not parsed / not applicable. */
  ranking: string[] | null;
}

export interface LeaderboardEntry {
  memberId: string;
  /** Label letter the member's answer carried in this round, e.g. "A". */
  label: string;
  /** Mean position across reviewers; 1 is best. */
  averageRank: number;
  votes: number;
  firstPlaceVotes: number;
}

export interface RoundResult {
  index: number;
  type: RoundType;
  title: string;
  instructions: string;
  anonymize: boolean;
  includeSelf: boolean;
  status: 'pending' | 'running' | 'done' | 'skipped';
  /**
   * review/revise rounds: label letter -> memberId for the answers shown in this round.
   * {} for answer rounds.
   */
  labels: Record<string, string>;
  responses: MemberResponse[];
  /** review rounds with at least one parsed ranking; otherwise null. */
  leaderboard: LeaderboardEntry[] | null;
}

export interface ArbiterResult extends CallResult {
  name: string;
  provider: ProviderId;
  providerLabel: string;
  /** Configured model ('' = CLI default). The reported model is in CallResult.model. */
  configuredModel: string;
  effort: string;
  /** Whether a council analysis section was requested. */
  analysisEnabled: boolean;
}

/**
 * arbiter  — the arbiter's final answer.
 * member   — direct mode: a single member answered.
 * fallback — the arbiter failed; the best-placed member's answer is shown instead.
 * none     — no final answer (error, or stopped before one existed).
 */
export interface FinalSource {
  kind: 'arbiter' | 'member' | 'fallback' | 'none';
  /** Arbiter or member display name; '' for 'none'. */
  name: string;
  /** Member id for 'member' and 'fallback'; null otherwise. */
  memberId: string | null;
}

export interface Turn {
  id: string;
  createdAt: string;
  /** The user's message as typed (including any @mentions). */
  userMessage: string;
  /** council — rounds plus arbiter. direct — exactly one member answers, no arbiter. */
  mode: 'council' | 'direct';
  status: TurnStatus;
  /** Why the turn has no (or a degraded) answer; null when all went well. */
  error: string | null;
  members: MemberSnapshot[];
  protocolName: string;
  councilRules: string;
  webSearch: boolean;
  rounds: RoundResult[];
  /** null in direct mode. */
  arbiter: ArbiterResult | null;
  /** The arbiter's council analysis ('' if none). Derived from arbiter.text. */
  analysisText: string;
  /** The answer shown as the assistant message. May be partial while running or after a stop. */
  finalText: string;
  finalSource: FinalSource;
  finishedAt: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  /** True while a turn of this conversation is running on the server. */
  running: boolean;
}

// ---------------------------------------------------------------------------
// HTTP API payloads
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
}

/** POST /api/turns */
export interface SendTurnRequest {
  /** Omit to start a new conversation. */
  conversationId?: string;
  message: string;
}

export interface SendTurnResponse {
  conversation: ConversationSummary;
  turn: Turn;
}

/** GET /api/meta */
export interface MetaResponse {
  appVersion: string;
  dataDir: string;
  mock: boolean;
  roles: RoleDef[];
  limits: { maxMembers: number; maxRounds: number; maxMessageChars: number };
}

// ---------------------------------------------------------------------------
// Server-sent events for a running turn
// GET /api/conversations/:conversationId/turns/:turnId/events
// ---------------------------------------------------------------------------

/**
 * The stream always begins with 'snapshot' (the full turn as it stands, including partial text),
 * so a client can subscribe or re-subscribe at any time. 'member.end', 'round.end', 'arbiter.end'
 * and 'turn.end' carry authoritative full objects that replace whatever the client accumulated.
 * 'turn.end' is always the last event. `round` is the 0-based index into `turn.rounds`.
 */
export type RunEvent =
  | { type: 'snapshot'; turn: Turn }
  | { type: 'round.start'; round: number }
  | { type: 'member.start'; round: number; memberId: string; startedAt: string }
  | { type: 'member.delta'; round: number; memberId: string; text: string; replace: boolean }
  | { type: 'member.activity'; round: number; memberId: string; activity: string }
  | { type: 'member.end'; round: number; response: MemberResponse }
  | { type: 'round.end'; round: number; result: RoundResult }
  | { type: 'arbiter.start'; startedAt: string }
  | { type: 'arbiter.delta'; text: string; replace: boolean }
  | { type: 'arbiter.activity'; activity: string }
  | { type: 'arbiter.end'; arbiter: ArbiterResult; analysisText: string; finalText: string }
  | { type: 'turn.end'; turn: Turn };
