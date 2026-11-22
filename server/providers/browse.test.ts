import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../shared/defaults';
import { antigravityProvider } from './antigravity';
import { claudeArgs, claudeProvider, createClaudeParser } from './claude';
import { codexArgs, codexProvider, createCodexParser } from './codex';
import { customProvider } from './custom';
import { buildChildEnv } from './env';
import { mockProvider } from './mock';
import { runProcess } from './proc';
import { ProviderRegistry } from './registry';
import type { CliConfig, RunRequest } from './types';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE = path.join(FIXTURES, 'fake-cli.mjs');

let dir: string;
let mirror: string;

/** A stand-in CLI that records its arguments and working directory, then replays a fixture. */
async function fakeCommand(name: string, fixture: string) {
  const base = path.join(dir, name);
  const recorder = `${base}.record.mjs`;
  await writeFile(
    recorder,
    `import { writeFileSync } from 'node:fs';
for await (const _ of process.stdin);
writeFileSync(${JSON.stringify(`${base}.json`)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
`,
  );
  await writeFile(base, `#!/bin/sh\n"${process.execPath}" "${recorder}" "$@" || exit 99\nexec "${process.execPath}" "${FAKE}" replay "${path.join(FIXTURES, fixture)}" 0\n`);
  await chmod(base, 0o755);
  return { command: base, read: async () => JSON.parse(await readFile(`${base}.json`, 'utf8')) as { args: string[]; cwd: string } };
}

const cfg = (command: string): CliConfig => ({ command, extraArgs: [], timeoutSec: 0, promptMode: 'stdin', stripApiKeys: true });

function request(extra: Partial<RunRequest> = {}): RunRequest {
  return {
    prompt: 'hi',
    model: '',
    effort: '',
    webSearch: false,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    onText: () => undefined,
    onActivity: () => undefined,
    ...extra,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'council-browse-cli-'));
  mirror = path.join(dir, 'mirror');
  await mkdir(mirror);
  await writeFile(path.join(mirror, 'INDEX.md'), '# Document library\n\n- a.md — A\n- b.md — B\n- c.md — C\n');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('browse mode argument builders', () => {
  it('Claude gets the read-only file tools, without --allowedTools for them', () => {
    const base = { model: '', effort: '', webSearch: false };
    const args = claudeArgs({ ...base, browseDir: '/m' }, []);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Glob,Grep']);
    expect(args).not.toContain('--allowedTools');
    const web = claudeArgs({ ...base, webSearch: true, browseDir: '/m' }, []);
    const at = web.indexOf('--tools');
    expect(web.slice(at, at + 4)).toEqual(['--tools', 'Read,Glob,Grep,WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch']);
    // Without the mirror nothing changes.
    expect(claudeArgs(base, [])).toContain('');
    expect(claudeArgs(base, []).join(' ')).not.toContain('Read');
  });

  it('Codex arguments are unchanged in browse mode', () => {
    const base = { model: '', effort: '', webSearch: false };
    expect(codexArgs({ ...base, browseDir: '/m' } as typeof base, [])).toEqual(codexArgs(base, []));
  });
});

describe('browse mode activity labels', () => {
  const block = (name: string) =>
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name } } });

  it('Claude names its file tools', () => {
    const seen: string[] = [];
    const parser = createClaudeParser({ onText: () => undefined, onActivity: (a) => seen.push(a) });
    for (const name of ['Read', 'Grep', 'Glob']) parser.push(block(name));
    expect(seen).toEqual(['Reading a document…', 'Searching the library…', 'Listing documents…']);
  });

  it('Codex says it is reading the library when it runs commands in browse mode', () => {
    const item = JSON.stringify({ type: 'item.started', item: { id: 'i', type: 'command_execution', command: 'cat INDEX.md' } });
    const seen: string[] = [];
    createCodexParser({ onText: () => undefined, onActivity: (a) => seen.push(a) }, { browse: true }).push(item);
    createCodexParser({ onText: () => undefined, onActivity: (a) => seen.push(a) }).push(item);
    expect(seen).toEqual(['Reading the library…', 'Running a command…']);
  });
});

describe('working directory', () => {
  it('runs in the given directory and leaves it in place', async () => {
    const lines: string[] = [];
    await runProcess({
      command: process.execPath,
      args: [FAKE, 'cwd'],
      stdin: null,
      env: buildChildEnv([], false),
      timeoutMs: 10_000,
      cliName: 'Fake',
      installHint: '',
      cwd: mirror,
      onLine: (l) => void lines.push(l),
    });
    expect(lines[0]).toBe(mirror);
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(path.join(mirror, 'INDEX.md'))).toBe(true);
  });

  it('Claude, Codex and Antigravity run in the mirror when given it', async () => {
    const claude = await fakeCommand('claude', 'claude-success.jsonl');
    await claudeProvider(cfg(claude.command)).run(request({ browseDir: mirror }));
    const c = await claude.read();
    expect(c.cwd).toBe(mirror);
    expect(c.args).toContain('Read,Glob,Grep');

    const codex = await fakeCommand('codex', 'codex-success.jsonl');
    await codexProvider(cfg(codex.command)).run(request({ browseDir: mirror }));
    expect((await codex.read()).cwd).toBe(mirror);

    const agy = await fakeCommand('agy', 'agy-success-active.jsonl');
    await antigravityProvider(cfg(agy.command), dir).run(request({ browseDir: mirror }));
    expect((await agy.read()).cwd).toBe(mirror);

    // Without the mirror, each call gets a fresh temporary directory.
    await claudeProvider(cfg(claude.command)).run(request());
    expect((await claude.read()).cwd).toMatch(/llm-council-/);
  });

  it('the mock reads INDEX.md in the mirror and says how many documents it lists', async () => {
    let text = '';
    await mockProvider().run(request({ model: 'instant', prompt: 'You are Claude, one of 3 AI models\n<question>\nq\n</question>', browseDir: mirror, onText: (t) => (text += t) }));
    expect(text).toContain('INDEX.md lists 3 documents');
  });
});

describe('browse capability', () => {
  it('is reported per provider: Claude yes, Codex and Antigravity untested, custom no, mock yes', async () => {
    const settings = defaultSettings(true);
    settings.customProviders = [{ id: 'mine', label: 'Mine', command: '/nonexistent/mine', args: [], modelArgs: [], promptVia: 'stdin' }];
    // Point the CLIs at paths that do not exist, so detection never runs a real CLI.
    for (const id of ['claude', 'codex', 'antigravity']) {
      settings.providers[id] = { command: `/nonexistent/${id}`, extraArgs: [], timeoutSec: 0, promptMode: 'stdin' };
    }
    const registry = new ProviderRegistry({ mock: true });
    expect(['claude', 'codex', 'antigravity', 'mine', 'mock'].map((id) => registry.browseSupport(id))).toEqual([
      'yes',
      'untested',
      'untested',
      'no',
      'yes',
    ]);
    expect((await mockProvider().info()).browse).toBe('yes');
    const custom = await customProvider(settings.customProviders[0]!, cfg('/nonexistent/mine')).info();
    expect(custom.browse).toBe('no');
    const infos = await registry.listInfo(settings);
    expect(Object.fromEntries(infos.map((i) => [i.id, i.browse]))).toEqual({
      claude: 'yes',
      codex: 'untested',
      antigravity: 'untested',
      mine: 'no',
      mock: 'yes',
    });
  });
});
