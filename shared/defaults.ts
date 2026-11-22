import type {
  ArbiterConfig,
  LibrarySettings,
  MemberConfig,
  Protocol,
  ProviderSettings,
  RoleDef,
  RoundConfig,
  RoundType,
  Settings,
} from './types';

export const APP_NAME = 'LLM Council';

export const LIMITS = {
  maxMembers: 8,
  maxRounds: 8,
  maxMessageChars: 200_000,
  maxNameChars: 40,
  maxRulesChars: 8_000,
  minTimeoutSec: 10,
  maxTimeoutSec: 3_600,
  maxLibrarySources: 20,
  minExcerptChars: 2_000,
  maxExcerptChars: 200_000,
  minAttachmentChars: 5_000,
  maxAttachmentChars: 1_000_000,
  maxAttachments: 20,
} as const;

export const ROUND_TYPE_META: Record<RoundType, { title: string; description: string }> = {
  answer: {
    title: 'Independent answers',
    description: 'Every member answers the question on its own, without seeing the others.',
  },
  review: {
    title: 'Peer review & ranking',
    description: "Every member critiques the others' current answers and ranks them.",
  },
  revise: {
    title: 'Rebuttal & revision',
    description: "Every member sees the others' answers and any reviews, then rewrites its own.",
  },
};

export function roundTitle(round: Pick<RoundConfig, 'type' | 'title'>): string {
  const custom = round.title.trim();
  return custom || ROUND_TYPE_META[round.type].title;
}

export const ROLES: RoleDef[] = [
  { id: 'none', label: 'No role', description: 'Answers as itself.', prompt: '' },
  {
    id: 'skeptic',
    label: "Devil's advocate",
    description: 'Challenges the prevailing view.',
    prompt:
      'Challenge the prevailing view. Look for the strongest objections, failure modes and counter-examples, even where the mainstream answer seems plausible. Still give your honest bottom line.',
  },
  {
    id: 'critic',
    label: 'Evidence critic',
    description: 'Demands evidence and data.',
    prompt:
      'Hold every claim to a high evidentiary standard. Ask what data or sources support it, separate established fact from speculation, and flag anything unverified.',
  },
  {
    id: 'researcher',
    label: 'Researcher',
    description: 'Brings context and real-world examples.',
    prompt:
      'Bring context: relevant facts, prior work, real-world examples and precise figures. Prefer specifics over generalities and say where each key fact comes from.',
  },
  {
    id: 'pragmatist',
    label: 'Pragmatist',
    description: 'Focuses on what is actionable.',
    prompt:
      'Focus on what is actionable. Weigh cost, effort, risk and time, and steer toward the option a competent practitioner would actually choose.',
  },
  {
    id: 'optimist',
    label: 'Optimist',
    description: 'Makes the case for what could go right.',
    prompt:
      'Make the strongest good-faith case for what could go right and how to get there, without ignoring real obstacles.',
  },
  {
    id: 'pessimist',
    label: 'Pessimist',
    description: 'Looks for risks and worst cases.',
    prompt:
      'Assume things will go wrong. Identify risks, hidden costs and worst cases, and say what would have to be true for the plan to fail.',
  },
  {
    id: 'visionary',
    label: 'Visionary',
    description: 'Thinks long-term and connects big ideas.',
    prompt:
      'Think long-term. Connect the question to larger trends and second-order effects, and offer the non-obvious angle.',
  },
  { id: 'custom', label: 'Custom…', description: 'Write your own role.', prompt: '' },
];

export function roleById(id: string): RoleDef | undefined {
  return ROLES.find((r) => r.id === id);
}

function round(id: string, type: RoundType, anonymize: boolean, instructions = ''): RoundConfig {
  return { id, type, title: '', instructions, anonymize, includeSelf: false };
}

/** Built-in presets. Always refreshed from code on load; users duplicate them to customise. */
export const BUILTIN_PROTOCOLS: Protocol[] = [
  {
    id: 'council',
    name: 'Council',
    description: 'Independent answers, anonymous peer review and ranking, then the arbiter rules.',
    builtin: true,
    rounds: [round('council-1', 'answer', false), round('council-2', 'review', true)],
  },
  {
    id: 'quick',
    name: 'Quick synthesis',
    description: 'Each model answers once; the arbiter compares and fuses. Fastest.',
    builtin: true,
    rounds: [round('quick-1', 'answer', false)],
  },
  {
    id: 'debate',
    name: 'Debate',
    description: "Models read each other's answers and rebut or revise over two rounds.",
    builtin: true,
    rounds: [
      round('debate-1', 'answer', false),
      round('debate-2', 'revise', false),
      round('debate-3', 'revise', false),
    ],
  },
  {
    id: 'deep',
    name: 'Deep deliberation',
    description: 'Answers, anonymous peer review, then revision in light of the critiques.',
    builtin: true,
    rounds: [
      round('deep-1', 'answer', false),
      round('deep-2', 'review', true),
      round('deep-3', 'revise', true),
    ],
  },
];

export const DEFAULT_PROTOCOL_ID = 'council';

export const MEMBER_COLORS = [
  '#d97757', // clay
  '#10a37f', // green
  '#4285f4', // blue
  '#a855f7', // violet
  '#eab308', // amber
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
];

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  command: '',
  extraArgs: [],
  timeoutSec: 0,
  promptMode: 'stdin',
};

function member(
  id: string,
  name: string,
  provider: string,
  color: string,
  effort = '',
): MemberConfig {
  return { id, name, provider, model: '', effort, roleId: 'none', customRole: '', enabled: true, color };
}

export function defaultMembers(mock: boolean): MemberConfig[] {
  if (mock) {
    return [
      member('m-claude', 'Claude', 'mock', MEMBER_COLORS[0]!),
      member('m-chatgpt', 'ChatGPT', 'mock', MEMBER_COLORS[1]!),
      member('m-gemini', 'Gemini', 'mock', MEMBER_COLORS[2]!),
    ];
  }
  return [
    member('m-claude', 'Claude', 'claude', MEMBER_COLORS[0]!),
    // Codex's catalogue defaults most models to low reasoning effort, which is tuned for
    // coding-agent latency rather than deliberation quality.
    member('m-chatgpt', 'ChatGPT', 'codex', MEMBER_COLORS[1]!, 'high'),
    member('m-gemini', 'Gemini', 'antigravity', MEMBER_COLORS[2]!),
  ];
}

export function defaultArbiter(mock: boolean): ArbiterConfig {
  return {
    name: 'Claude',
    provider: mock ? 'mock' : 'claude',
    model: '',
    effort: '',
    instructions: '',
    analysis: true,
  };
}

export function defaultLibrary(mock: boolean): LibrarySettings {
  return {
    sources: [],
    mode: 'search',
    browseUntested: false,
    excerptChars: 24_000,
    attachmentChars: 120_000,
    // A small, fast model is enough to turn a question into keyword searches.
    planner: { enabled: true, provider: mock ? 'mock' : 'claude', model: mock ? '' : 'haiku', effort: '' },
    autoSyncMinutes: 30,
    notionSaveParent: null,
  };
}

export function defaultSettings(mock = false): Settings {
  return {
    version: 1,
    members: defaultMembers(mock),
    protocols: BUILTIN_PROTOCOLS.map((p) => structuredClone(p)),
    activeProtocolId: DEFAULT_PROTOCOL_ID,
    arbiter: defaultArbiter(mock),
    councilRules: '',
    webSearch: false,
    defaultTimeoutSec: 600,
    maxHistoryChars: 60_000,
    stripApiKeys: true,
    providers: {},
    customProviders: [],
    library: defaultLibrary(mock),
  };
}

/** Label letters for answers under review: A, B, C, … */
export function labelFor(index: number): string {
  return String.fromCharCode(65 + index);
}
