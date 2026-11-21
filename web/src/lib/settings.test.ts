import { describe, expect, it } from 'vitest';
import { BUILTIN_PROTOCOLS, LIMITS, defaultSettings } from '../../../shared/defaults';
import type { ProviderInfo, Settings } from '../../../shared/types';
import {
  activeProtocol,
  arbiterFromMember,
  arbiterMatchesMember,
  duplicateMember,
  duplicateProtocol,
  errorKey,
  moveRound,
  newMember,
  newRound,
  providerProblems,
  settingsEqual,
  setupSummary,
  tabForErrorKey,
  validateSettings,
} from './settings';

function info(id: string, patch: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id,
    label: id,
    cliName: `${id} CLI`,
    vendor: 'v',
    kind: 'builtin',
    command: id,
    installed: true,
    version: '1',
    auth: 'ok',
    authDetail: '',
    billing: 'subscription',
    warnings: [],
    effortLevels: [],
    webSearch: 'toggle',
    streams: true,
    modelSuggestions: [],
    canListModels: false,
    installHint: `install ${id}`,
    loginHint: `login ${id}`,
    docsUrl: '',
    ...patch,
  };
}

const ALL = new Set(['claude', 'codex', 'antigravity', 'mock']);

describe('validateSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(defaultSettings(), ALL)).toEqual({});
    expect(validateSettings(defaultSettings(true), ALL)).toEqual({});
  });

  it('flags empty, duplicate and unmentionable names', () => {
    const s = defaultSettings();
    s.members[0]!.name = '  ';
    s.members[1]!.name = 'gemini';
    s.members[2]!.name = 'Gemini';
    const errors = validateSettings(s, ALL);
    expect(errors[errorKey.memberName(s.members[0]!.id)]).toBe('Enter a name.');
    expect(errors[errorKey.memberName(s.members[1]!.id)]).toBeUndefined();
    expect(errors[errorKey.memberName(s.members[2]!.id)]).toContain('already called “gemini”');

    const t = defaultSettings();
    t.members[0]!.name = '!!!';
    expect(validateSettings(t, ALL)[errorKey.memberName(t.members[0]!.id)]).toContain('@mentioned');

    const u = defaultSettings();
    u.members[0]!.name = 'x'.repeat(LIMITS.maxNameChars + 1);
    expect(validateSettings(u, ALL)[errorKey.memberName(u.members[0]!.id)]).toContain(`${LIMITS.maxNameChars}`);
  });

  it('checks providers only when the provider list is known', () => {
    const s = defaultSettings();
    s.members[0]!.provider = 'ghost';
    s.arbiter.provider = 'ghost';
    expect(validateSettings(s, ALL)[errorKey.memberProvider(s.members[0]!.id)]).toBeDefined();
    expect(validateSettings(s, ALL)[errorKey.arbiterProvider]).toBeDefined();
    expect(validateSettings(s, null)).toEqual({});
  });

  it('requires a custom role text and bounds text fields', () => {
    const s = defaultSettings();
    s.members[0]!.roleId = 'custom';
    expect(validateSettings(s, ALL)[errorKey.memberRole(s.members[0]!.id)]).toBeDefined();
    s.members[0]!.customRole = 'Be terse.';
    expect(validateSettings(s, ALL)[errorKey.memberRole(s.members[0]!.id)]).toBeUndefined();
    s.councilRules = 'x'.repeat(LIMITS.maxRulesChars + 1);
    s.arbiter.instructions = 'x'.repeat(LIMITS.maxRulesChars + 1);
    const errors = validateSettings(s, ALL);
    expect(errors[errorKey.councilRules]).toBeDefined();
    expect(errors[errorKey.arbiterInstructions]).toBeDefined();
  });

  it('validates custom protocols but not built-ins', () => {
    const s = defaultSettings();
    const custom = duplicateProtocol(s.protocols, BUILTIN_PROTOCOLS[0]!);
    custom.name = '';
    custom.rounds = [];
    s.protocols.push(custom);
    let errors = validateSettings(s, ALL);
    expect(errors[errorKey.protocolName(custom.id)]).toBe('Enter a name.');
    expect(errors[errorKey.protocolRounds(custom.id)]).toBeDefined();
    custom.name = 'Mine';
    custom.rounds = [newRound('review')];
    errors = validateSettings(s, ALL);
    expect(errors[errorKey.protocolRounds(custom.id)]).toContain('Only the first round');
    custom.rounds = Array.from({ length: LIMITS.maxRounds + 1 }, (_, i) => newRound(i === 0 ? 'answer' : 'revise'));
    expect(validateSettings(s, ALL)[errorKey.protocolRounds(custom.id)]).toContain(`${LIMITS.maxRounds}`);
  });

  it('bounds timeouts and the history budget', () => {
    const s = defaultSettings();
    s.defaultTimeoutSec = LIMITS.minTimeoutSec - 1;
    s.maxHistoryChars = -1;
    s.providers = { claude: { command: '', extraArgs: [], timeoutSec: 5, promptMode: 'stdin' } };
    let errors = validateSettings(s, ALL);
    expect(errors[errorKey.defaultTimeout]).toBeDefined();
    expect(errors[errorKey.maxHistory]).toBeDefined();
    expect(errors[errorKey.providerTimeout('claude')]).toBeDefined();
    s.defaultTimeoutSec = Number.NaN;
    expect(validateSettings(s, ALL)[errorKey.defaultTimeout]).toBeDefined();
    s.defaultTimeoutSec = LIMITS.maxTimeoutSec;
    s.maxHistoryChars = 0;
    s.providers.claude!.timeoutSec = 0;
    errors = validateSettings(s, ALL);
    expect(errors).toEqual({});
  });

  it('requires at least one member', () => {
    const s = defaultSettings();
    s.members = [];
    expect(validateSettings(s, ALL)[errorKey.members]).toBeDefined();
  });

  it('maps error keys to their settings tabs', () => {
    expect(tabForErrorKey(errorKey.memberName('x'))).toBe('council');
    expect(tabForErrorKey(errorKey.members)).toBe('council');
    expect(tabForErrorKey(errorKey.protocolRounds('p'))).toBe('protocol');
    expect(tabForErrorKey(errorKey.roundInstructions('r'))).toBe('protocol');
    expect(tabForErrorKey(errorKey.councilRules)).toBe('protocol');
    expect(tabForErrorKey(errorKey.arbiterName)).toBe('arbiter');
    expect(tabForErrorKey(errorKey.providerTimeout('claude'))).toBe('providers');
    expect(tabForErrorKey(errorKey.defaultTimeout)).toBe('general');
  });
});

describe('settingsEqual', () => {
  it('ignores provider overrides that equal the defaults', () => {
    const a = defaultSettings();
    const b: Settings = { ...defaultSettings(), providers: { claude: { command: '', extraArgs: [], timeoutSec: 0, promptMode: 'stdin' } } };
    expect(settingsEqual(a, b)).toBe(true);
    b.providers.claude!.command = '/usr/bin/claude';
    expect(settingsEqual(a, b)).toBe(false);
  });

  it('detects nested changes', () => {
    const a = defaultSettings();
    const b = structuredClone(a);
    expect(settingsEqual(a, b)).toBe(true);
    b.protocols[0]!.rounds[1]!.anonymize = false;
    expect(settingsEqual(a, b)).toBe(false);
  });
});

describe('draft helpers', () => {
  it('creates members with unique names and unused colours', () => {
    const s = defaultSettings();
    const m = newMember(s.members, 'claude');
    expect(m.name).toBe('Member');
    expect(s.members.map((x) => x.color)).not.toContain(m.color);
    const again = newMember([...s.members, m], 'claude');
    expect(again.name).toBe('Member 2');
    expect(again.id).not.toBe(m.id);
  });

  it('duplicates members with a fresh id and a distinct name', () => {
    const s = defaultSettings();
    const copy = duplicateMember(s.members, s.members[0]!);
    expect(copy.id).not.toBe(s.members[0]!.id);
    expect(copy.name).toBe('Claude 2');
    expect(copy.provider).toBe(s.members[0]!.provider);
  });

  it('duplicates protocols as editable copies with fresh round ids', () => {
    const s = defaultSettings();
    const copy = duplicateProtocol(s.protocols, BUILTIN_PROTOCOLS[3]!);
    expect(copy.builtin).toBe(false);
    expect(copy.name).toBe('Deep deliberation (copy)');
    expect(copy.rounds.map((r) => r.type)).toEqual(['answer', 'review', 'revise']);
    expect(copy.rounds.map((r) => r.id)).not.toEqual(BUILTIN_PROTOCOLS[3]!.rounds.map((r) => r.id));
    expect(duplicateProtocol([...s.protocols, copy], BUILTIN_PROTOCOLS[3]!).name).toBe('Deep deliberation (copy) 2');
  });

  it('never moves the first round', () => {
    const rounds = [newRound('answer'), newRound('review'), newRound('revise')];
    expect(moveRound(rounds, 1, -1)).toBe(rounds);
    expect(moveRound(rounds, 0, 1)).toBe(rounds);
    expect(moveRound(rounds, 2, 1)).toBe(rounds);
    expect(moveRound(rounds, 1, 1).map((r) => r.type)).toEqual(['answer', 'revise', 'review']);
  });

  it('copies a member seat into the arbiter while keeping its own instructions', () => {
    const s = defaultSettings();
    s.arbiter.instructions = 'Be brief.';
    const gemini = s.members[2]!;
    const next = arbiterFromMember(s.arbiter, gemini);
    expect(next).toMatchObject({ name: 'Gemini', provider: 'antigravity', instructions: 'Be brief.', analysis: true });
    expect(arbiterMatchesMember(next, gemini)).toBe(true);
    expect(arbiterMatchesMember(next, s.members[0]!)).toBe(false);
  });
});

describe('summaries and provider problems', () => {
  it('summarises the setup', () => {
    const s = defaultSettings();
    expect(setupSummary(s)).toBe('3 members · Council · Arbiter: Claude');
    s.members[1]!.enabled = false;
    s.members[2]!.enabled = false;
    expect(setupSummary(s)).toBe('1 member · Direct answers from Claude');
    s.members[0]!.enabled = false;
    expect(setupSummary(s)).toBe('No members enabled');
  });

  it('falls back to the default protocol when the active id is unknown', () => {
    const s = defaultSettings();
    s.activeProtocolId = 'missing';
    expect(activeProtocol(s)?.id).toBe('council');
  });

  it('lists missing, uninstalled and signed-out providers used by enabled seats', () => {
    const s = defaultSettings();
    const providers = [info('claude'), info('codex', { installed: false }), info('antigravity', { auth: 'missing' })];
    const problems = providerProblems(s, providers);
    expect(problems.map((p) => [p.providerId, p.title, p.fix])).toEqual([
      ['codex', 'codex CLI is not installed', 'install codex'],
      ['antigravity', 'antigravity CLI is not signed in', 'login antigravity'],
    ]);
    s.members[1]!.enabled = false;
    s.arbiter.provider = 'ghost';
    const next = providerProblems(s, providers);
    expect(next.map((p) => p.providerId)).toEqual(['antigravity', 'ghost']);
    expect(next[1]!.usedBy).toEqual(['Arbiter (Claude)']);
  });

  it('treats unknown sign-in as fine and ignores the arbiter in direct mode', () => {
    const s = defaultSettings();
    s.members = [s.members[0]!];
    s.arbiter.provider = 'ghost';
    expect(providerProblems(s, [info('claude', { auth: 'unknown' })])).toEqual([]);
  });
});
