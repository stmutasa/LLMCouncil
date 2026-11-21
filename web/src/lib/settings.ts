import {
  BUILTIN_PROTOCOLS,
  DEFAULT_PROTOCOL_ID,
  DEFAULT_PROVIDER_SETTINGS,
  LIMITS,
  MEMBER_COLORS,
} from '../../../shared/defaults';
import { mentionHandle } from '../../../shared/mentions';
import type {
  ArbiterConfig,
  MemberConfig,
  Protocol,
  ProviderInfo,
  ProviderSettings,
  RoundConfig,
  RoundType,
  Settings,
} from '../../../shared/types';
import { newId } from './ids';

export function activeProtocol(settings: Settings): Protocol | undefined {
  return (
    settings.protocols.find((p) => p.id === settings.activeProtocolId) ??
    settings.protocols.find((p) => p.id === DEFAULT_PROTOCOL_ID) ??
    settings.protocols[0]
  );
}

export function enabledMembers(settings: Settings): MemberConfig[] {
  return settings.members.filter((m) => m.enabled);
}

export function providerSettingsFor(settings: Settings, id: string): ProviderSettings {
  return { ...DEFAULT_PROVIDER_SETTINGS, ...settings.providers[id] };
}

/** "3 members · Council · Arbiter: Claude"; direct mode when only one member is enabled. */
export function setupSummary(settings: Settings): string {
  const enabled = enabledMembers(settings);
  if (enabled.length === 0) return 'No members enabled';
  if (enabled.length === 1) return `1 member · Direct answers from ${enabled[0]!.name}`;
  const protocol = activeProtocol(settings);
  return `${enabled.length} members · ${protocol?.name ?? 'Council'} · Arbiter: ${settings.arbiter.name}`;
}

export function arbiterMatchesMember(arbiter: ArbiterConfig, member: MemberConfig): boolean {
  return (
    arbiter.name === member.name &&
    arbiter.provider === member.provider &&
    arbiter.model === member.model &&
    arbiter.effort === member.effort
  );
}

/** Choosing a member as arbiter copies its seat; the arbiter's own instructions are kept. */
export function arbiterFromMember(arbiter: ArbiterConfig, member: MemberConfig): ArbiterConfig {
  return { ...arbiter, name: member.name, provider: member.provider, model: member.model, effort: member.effort };
}

// ---------------------------------------------------------------------------------------------
// Provider problems (empty-state notice)
// ---------------------------------------------------------------------------------------------

export interface ProviderProblem {
  providerId: string;
  /** Who depends on it, e.g. "Claude, Arbiter". */
  usedBy: string[];
  title: string;
  fix: string;
}

/** Providers used by enabled members or the arbiter that are missing, not installed or signed out. */
export function providerProblems(settings: Settings, providers: ProviderInfo[]): ProviderProblem[] {
  const usage = new Map<string, string[]>();
  const add = (id: string, who: string) => {
    const list = usage.get(id);
    if (list) list.push(who);
    else usage.set(id, [who]);
  };
  for (const m of enabledMembers(settings)) add(m.provider, m.name);
  if (enabledMembers(settings).length > 1) add(settings.arbiter.provider, `Arbiter (${settings.arbiter.name})`);

  const problems: ProviderProblem[] = [];
  for (const [id, usedBy] of usage) {
    const info = providers.find((p) => p.id === id);
    if (!info) {
      problems.push({
        providerId: id,
        usedBy,
        title: `Provider “${id}” is not available`,
        fix: 'Choose another provider for these seats in Settings.',
      });
    } else if (!info.installed) {
      problems.push({ providerId: id, usedBy, title: `${info.cliName} is not installed`, fix: info.installHint });
    } else if (info.auth === 'missing') {
      problems.push({ providerId: id, usedBy, title: `${info.cliName} is not signed in`, fix: info.loginHint });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Draft editing helpers
// ---------------------------------------------------------------------------------------------

function uniqueName(base: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

function nextColor(members: MemberConfig[]): string {
  const used = new Set(members.map((m) => m.color.toLowerCase()));
  return MEMBER_COLORS.find((c) => !used.has(c.toLowerCase())) ?? MEMBER_COLORS[members.length % MEMBER_COLORS.length]!;
}

export function newMember(members: MemberConfig[], provider: string): MemberConfig {
  return {
    id: newId('m'),
    name: uniqueName('Member', members.map((m) => m.name)),
    provider,
    model: '',
    effort: '',
    roleId: 'none',
    customRole: '',
    enabled: true,
    color: nextColor(members),
  };
}

export function duplicateMember(members: MemberConfig[], source: MemberConfig): MemberConfig {
  return {
    ...structuredClone(source),
    id: newId('m'),
    name: uniqueName(source.name.trim() || 'Member', members.map((m) => m.name)).slice(0, LIMITS.maxNameChars),
    color: nextColor(members),
  };
}

export function newRound(type: RoundType): RoundConfig {
  return { id: newId('r'), type, title: '', instructions: '', anonymize: type === 'review', includeSelf: false };
}

export function duplicateProtocol(protocols: Protocol[], source: Protocol): Protocol {
  return {
    id: newId('p'),
    name: uniqueName(`${source.name} (copy)`, protocols.map((p) => p.name)),
    description: source.description,
    builtin: false,
    rounds: source.rounds.map((r) => ({ ...r, id: newId('r') })),
  };
}

/** Moves round `index` by `delta`; round 1 (the answer round) never moves. */
export function moveRound(rounds: RoundConfig[], index: number, delta: -1 | 1): RoundConfig[] {
  const target = index + delta;
  if (index < 1 || target < 1 || target >= rounds.length) return rounds;
  const next = rounds.slice();
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function isBuiltinProtocolId(id: string): boolean {
  return BUILTIN_PROTOCOLS.some((p) => p.id === id);
}

// ---------------------------------------------------------------------------------------------
// Comparison and validation
// ---------------------------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as never)[k], (b as never)[k]));
}

/** Provider overrides that equal the defaults are the same as no override. */
function normalized(settings: Settings): Settings {
  const providers: Record<string, ProviderSettings> = {};
  for (const [id, value] of Object.entries(settings.providers)) {
    const merged = { ...DEFAULT_PROVIDER_SETTINGS, ...value };
    if (!deepEqual(merged, DEFAULT_PROVIDER_SETTINGS)) providers[id] = merged;
  }
  return { ...settings, providers };
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return deepEqual(normalized(a), normalized(b));
}

export type ValidationErrors = Record<string, string>;

/** Error keys used by the settings dialog to place messages next to their fields. */
export const errorKey = {
  members: 'members',
  memberName: (id: string) => `member.${id}.name`,
  memberProvider: (id: string) => `member.${id}.provider`,
  memberRole: (id: string) => `member.${id}.customRole`,
  protocolName: (id: string) => `protocol.${id}.name`,
  protocolRounds: (id: string) => `protocol.${id}.rounds`,
  roundInstructions: (id: string) => `round.${id}.instructions`,
  councilRules: 'councilRules',
  arbiterName: 'arbiter.name',
  arbiterProvider: 'arbiter.provider',
  arbiterInstructions: 'arbiter.instructions',
  defaultTimeout: 'defaultTimeoutSec',
  maxHistory: 'maxHistoryChars',
  providerTimeout: (id: string) => `provider.${id}.timeoutSec`,
} as const;

function isWholeNumber(n: number): boolean {
  return Number.isInteger(n);
}

/**
 * Client-side mirror of the server's validation rules, for inline messages. The server stays
 * authoritative: its error is shown verbatim if it rejects something these rules allow.
 * `providerIds` is null when the provider list is unavailable (then providers are not checked).
 */
export function validateSettings(s: Settings, providerIds: ReadonlySet<string> | null): ValidationErrors {
  const errors: ValidationErrors = {};
  const tooLong = (text: string) => text.length > LIMITS.maxRulesChars;
  const rulesMessage = `Keep this under ${LIMITS.maxRulesChars.toLocaleString('en-US')} characters.`;

  if (s.members.length < 1) errors[errorKey.members] = 'Add at least one member.';
  if (s.members.length > LIMITS.maxMembers) errors[errorKey.members] = `A council has at most ${LIMITS.maxMembers} members.`;

  const seen = new Map<string, string>();
  for (const m of s.members) {
    const name = m.name.trim();
    const key = errorKey.memberName(m.id);
    if (!name) errors[key] = 'Enter a name.';
    else if (name.length > LIMITS.maxNameChars) errors[key] = `Use at most ${LIMITS.maxNameChars} characters.`;
    else if (!mentionHandle(name)) errors[key] = 'Include at least one letter or digit so the member can be @mentioned.';
    else {
      const lower = name.toLowerCase();
      if (seen.has(lower)) errors[key] = `Another member is already called “${seen.get(lower)}”.`;
      else seen.set(lower, name);
    }
    if (providerIds && !providerIds.has(m.provider)) errors[errorKey.memberProvider(m.id)] = 'Choose an available provider.';
    if (m.roleId === 'custom' && !m.customRole.trim()) errors[errorKey.memberRole(m.id)] = 'Describe the role, or choose another one.';
    else if (tooLong(m.customRole)) errors[errorKey.memberRole(m.id)] = rulesMessage;
  }

  for (const p of s.protocols) {
    if (p.builtin) continue;
    if (!p.name.trim()) errors[errorKey.protocolName(p.id)] = 'Enter a name.';
    if (p.rounds.length < 1 || p.rounds.length > LIMITS.maxRounds) {
      errors[errorKey.protocolRounds(p.id)] = `Use between 1 and ${LIMITS.maxRounds} rounds.`;
    } else if (p.rounds[0]!.type !== 'answer' || p.rounds.slice(1).some((r) => r.type === 'answer')) {
      errors[errorKey.protocolRounds(p.id)] = 'Only the first round can be “Independent answers”.';
    }
    for (const r of p.rounds) if (tooLong(r.instructions)) errors[errorKey.roundInstructions(r.id)] = rulesMessage;
  }

  if (tooLong(s.councilRules)) errors[errorKey.councilRules] = rulesMessage;
  if (!s.arbiter.name.trim()) errors[errorKey.arbiterName] = 'Enter a name.';
  else if (s.arbiter.name.trim().length > LIMITS.maxNameChars) errors[errorKey.arbiterName] = `Use at most ${LIMITS.maxNameChars} characters.`;
  if (providerIds && !providerIds.has(s.arbiter.provider)) errors[errorKey.arbiterProvider] = 'Choose an available provider.';
  if (tooLong(s.arbiter.instructions)) errors[errorKey.arbiterInstructions] = rulesMessage;

  const t = s.defaultTimeoutSec;
  if (!isWholeNumber(t) || t < LIMITS.minTimeoutSec || t > LIMITS.maxTimeoutSec) {
    errors[errorKey.defaultTimeout] = `Enter a whole number of seconds from ${LIMITS.minTimeoutSec} to ${LIMITS.maxTimeoutSec.toLocaleString('en-US')}.`;
  }
  const h = s.maxHistoryChars;
  if (!isWholeNumber(h) || h < 0 || h > 1_000_000) errors[errorKey.maxHistory] = 'Enter a whole number from 0 to 1,000,000.';

  for (const [id, value] of Object.entries(s.providers)) {
    const pt = value.timeoutSec;
    if (pt === undefined) continue;
    if (!isWholeNumber(pt) || (pt !== 0 && (pt < LIMITS.minTimeoutSec || pt > LIMITS.maxTimeoutSec))) {
      errors[errorKey.providerTimeout(id)] = `Enter 0 (use the default) or ${LIMITS.minTimeoutSec}–${LIMITS.maxTimeoutSec.toLocaleString('en-US')} seconds.`;
    }
  }
  return errors;
}

/** The settings tab each error key belongs to, so the dialog can flag tabs with problems. */
export function tabForErrorKey(key: string): 'council' | 'protocol' | 'arbiter' | 'providers' | 'general' {
  if (key === 'members' || key.startsWith('member.')) return 'council';
  if (key.startsWith('protocol.') || key.startsWith('round.') || key === 'councilRules') return 'protocol';
  if (key.startsWith('arbiter.')) return 'arbiter';
  if (key.startsWith('provider.')) return 'providers';
  return 'general';
}
