import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PROTOCOLS, defaultSettings } from '../shared/defaults';
import type { Settings } from '../shared/types';
import { normalizeSettings, SettingsError, SettingsStore } from './settings';

const save = { mock: false, allowUnknownProviders: false };
const check = (mutate: (s: Settings) => void, opts = save) => {
  const s = defaultSettings(false);
  mutate(s);
  return () => normalizeSettings(s, opts);
};

describe('settings validation', () => {
  it('accepts the defaults', () => {
    expect(normalizeSettings(defaultSettings(false), save)).toEqual(defaultSettings(false));
    expect(normalizeSettings(defaultSettings(true), { mock: true, allowUnknownProviders: false }).members[0]!.provider).toBe('mock');
  });

  it('reports shape errors with the path', () => {
    expect(check((s) => ((s as unknown as { webSearch: string }).webSearch = 'yes'))).toThrow(
      'Invalid settings at webSearch: Invalid input: expected boolean, received string.',
    );
    expect(check((s) => ((s.members[1] as unknown as { name: number }).name = 5))).toThrow(/Invalid settings at members\[1\]\.name/);
  });

  it.each<[string, (s: Settings) => void, RegExp]>([
    ['no members', (s) => (s.members = []), /at least one member/],
    ['too many members', (s) => (s.members = Array.from({ length: 9 }, (_, i) => ({ ...s.members[0]!, id: `m${i}`, name: `M${i}` }))), /at most 8 members/],
    ['empty name', (s) => (s.members[0]!.name = '  '), /Member 1 needs a name/],
    ['long name', (s) => (s.members[0]!.name = 'x'.repeat(41)), /at most 40 characters/],
    ['duplicate name', (s) => (s.members[1]!.name = 'claude'), /Two members are named "claude"/],
    ['clashing handle', (s) => (s.members[1]!.name = 'Clau-de'), /would both be addressed as @claude/],
    ['name without handle', (s) => (s.members[0]!.name = '!!!'), /at least one letter or digit/],
    ['duplicate id', (s) => (s.members[1]!.id = s.members[0]!.id), /share the id/],
    ['bad colour', (s) => (s.members[0]!.color = 'red'), /not a #rrggbb hex colour/],
    ['unknown provider', (s) => (s.members[0]!.provider = 'mock'), /provider "mock", which is not available/],
    ['unknown arbiter provider', (s) => (s.arbiter.provider = 'nope'), /The arbiter uses the provider "nope"/],
    ['flag-like model', (s) => (s.members[0]!.model = '--dangerous'), /the model "--dangerous" is not valid/],
    ['model with spaces', (s) => (s.arbiter.model = 'a b'), /The arbiter: the model "a b" is not valid/],
    ['bad effort', (s) => (s.members[0]!.effort = 'high; rm'), /the effort "high; rm" is not valid/],
    ['unknown role', (s) => (s.members[0]!.roleId = 'jester'), /unknown role "jester"/],
    ['empty arbiter name', (s) => (s.arbiter.name = ''), /The arbiter needs a name/],
    ['round 1 not answer', (s) => s.protocols.push({ id: 'p', name: 'P', description: '', builtin: false, rounds: [{ id: 'r', type: 'review', title: '', instructions: '', anonymize: false, includeSelf: false }] }), /round 1 must be "Independent answers"/],
    ['later answer round', (s) => s.protocols.push({ id: 'p', name: 'P', description: '', builtin: false, rounds: [{ id: 'r1', type: 'answer', title: '', instructions: '', anonymize: false, includeSelf: false }, { id: 'r2', type: 'answer', title: '', instructions: '', anonymize: false, includeSelf: false }] }), /round 2 must be/],
    ['no rounds', (s) => s.protocols.push({ id: 'p', name: 'P', description: '', builtin: false, rounds: [] }), /needs at least one round/],
    ['too many rounds', (s) => s.protocols.push({ id: 'p', name: 'P', description: '', builtin: false, rounds: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, type: i === 0 ? 'answer' : 'review', title: '', instructions: '', anonymize: false, includeSelf: false })) }), /9 rounds; the limit is 8/],
    ['duplicate protocol id', (s) => s.protocols.push({ id: 'p', name: 'P', description: '', builtin: false, rounds: [{ id: 'r', type: 'answer', title: '', instructions: '', anonymize: false, includeSelf: false }] }, { id: 'p', name: 'Q', description: '', builtin: false, rounds: [{ id: 'r', type: 'answer', title: '', instructions: '', anonymize: false, includeSelf: false }] }), /Two protocols share the id "p"/],
    ['long rules', (s) => (s.councilRules = 'x'.repeat(8001)), /council rules is too long/],
    ['timeout too small', (s) => (s.defaultTimeoutSec = 5), /between 10 and 3600 seconds/],
    ['provider timeout', (s) => (s.providers.claude = { command: '', extraArgs: [], timeoutSec: 5, promptMode: 'stdin' }), /timeout for provider "claude"/],
    ['history budget', (s) => (s.maxHistoryChars = 2_000_000), /history budget/],
    ['custom provider id', (s) => s.customProviders.push({ id: 'Bad Id', label: 'X', command: 'x', args: [], modelArgs: [], promptVia: 'stdin' }), /the id "Bad Id" is not valid/],
    ['custom provider reserved', (s) => s.customProviders.push({ id: 'claude', label: 'X', command: 'x', args: [], modelArgs: [], promptVia: 'stdin' }), /reserved for a built-in provider/],
    ['custom provider command', (s) => s.customProviders.push({ id: 'local', label: 'X', command: ' ', args: [], modelArgs: [], promptVia: 'stdin' }), /needs a command/],
  ])('rejects %s', (_name, mutate, message) => {
    const run = check(mutate);
    expect(run).toThrow(SettingsError);
    expect(run).toThrow(message);
  });

  it('accepts members using a custom provider, and 0 as a provider timeout', () => {
    const s = defaultSettings(false);
    s.customProviders.push({ id: 'local', label: 'Local', command: 'llm', args: [], modelArgs: [], promptVia: 'stdin' });
    s.members[0]!.provider = 'local';
    s.providers.codex = { command: '', extraArgs: [], timeoutSec: 0, promptMode: 'stdin' };
    expect(() => normalizeSettings(s, save)).not.toThrow();
  });

  it('tolerates unknown providers on load', () => {
    const s = defaultSettings(true);
    expect(() => normalizeSettings(s, { mock: false, allowUnknownProviders: true })).not.toThrow();
    expect(() => normalizeSettings(s, { mock: false, allowUnknownProviders: false })).toThrow(/not available/);
  });

  it('re-syncs built-in protocols, keeps user ones and falls back for a missing active protocol', () => {
    const s = defaultSettings(false);
    s.protocols[0]!.name = 'Hacked';
    s.protocols[0]!.rounds = [s.protocols[0]!.rounds[0]!];
    s.protocols = s.protocols.filter((p) => p.id !== 'debate');
    s.protocols.push({ id: 'mine', name: 'Mine', description: '', builtin: true, rounds: [{ id: 'r', type: 'answer', title: '', instructions: '', anonymize: false, includeSelf: false }] });
    s.activeProtocolId = 'gone';
    const out = normalizeSettings(s, save);
    expect(out.protocols.slice(0, BUILTIN_PROTOCOLS.length)).toEqual(BUILTIN_PROTOCOLS);
    expect(out.protocols.at(-1)).toMatchObject({ id: 'mine', builtin: false });
    expect(out.activeProtocolId).toBe('council');
  });

  it('fills missing keys from defaults', () => {
    const out = normalizeSettings(
      {
        version: 1,
        members: [{ id: 'a', name: 'Solo', provider: 'claude' }],
        protocols: [{ id: 'mine', name: 'Mine', rounds: [{ id: 'r', type: 'answer' }] }],
        providers: { codex: { timeoutSec: 30 } },
      },
      save,
    );
    expect(out.members[0]).toEqual({ id: 'a', name: 'Solo', provider: 'claude', model: '', effort: '', roleId: 'none', customRole: '', enabled: true, color: '#d97757' });
    expect(out.protocols.find((p) => p.id === 'mine')!.rounds[0]).toEqual({ id: 'r', type: 'answer', title: '', instructions: '', anonymize: false, includeSelf: false });
    expect(out.providers.codex).toEqual({ command: '', extraArgs: [], timeoutSec: 30, promptMode: 'stdin' });
    expect(out.defaultTimeoutSec).toBe(600);
    expect(out.arbiter.provider).toBe('claude');
  });
});

describe('SettingsStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'council-settings-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('uses mock defaults when no file exists, and saves atomically', async () => {
    const store = new SettingsStore(dir, true);
    expect((await store.load()).members[0]!.provider).toBe('mock');
    const next = store.get();
    next.councilRules = 'Be concise.';
    await store.save(next);
    const onDisk = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')) as Settings;
    expect(onDisk.councilRules).toBe('Be concise.');
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await new SettingsStore(dir, true).load()).councilRules).toBe('Be concise.');
  });

  it('returns copies that cannot alter the stored settings', async () => {
    const store = new SettingsStore(dir, false);
    await store.load();
    store.get().members[0]!.name = 'Changed';
    expect(store.get().members[0]!.name).toBe('Claude');
  });

  it('moves an invalid file aside and continues with defaults', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile(path.join(dir, 'settings.json'), '{ not json');
    const store = new SettingsStore(dir, false);
    expect(await store.load()).toEqual(defaultSettings(false));
    const files = await readdir(dir);
    expect(files.some((f) => /^settings\.invalid-.*\.json$/.test(f))).toBe(true);
    expect(files).not.toContain('settings.json');
  });

  it('moves aside a file that fails validation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = defaultSettings(false);
    bad.members = [];
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify(bad));
    expect((await new SettingsStore(dir, false).load()).members).toHaveLength(3);
    expect((await readdir(dir)).some((f) => f.startsWith('settings.invalid-'))).toBe(true);
  });

  it('loads a mock-mode file without --mock', async () => {
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify(defaultSettings(true)));
    expect((await new SettingsStore(dir, false).load()).members[0]!.provider).toBe('mock');
  });

  it('rejects invalid saves without touching the file', async () => {
    const store = new SettingsStore(dir, false);
    await store.load();
    const bad = store.get();
    bad.members[0]!.name = '';
    await expect(store.save(bad)).rejects.toThrow(SettingsError);
    expect(await readdir(dir)).toEqual([]);
  });
});
