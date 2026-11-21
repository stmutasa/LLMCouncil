import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { antigravityProvider } from './antigravity';
import { CLAUDE_SYSTEM_PROMPT, claudeProvider } from './claude';
import { codexProvider } from './codex';
import { ProviderError, type CliConfig, type RunRequest } from './types';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE = path.join(FIXTURES, 'fake-cli.mjs');

let dir: string;

/**
 * A stand-in executable for a vendor CLI: records its arguments and stdin, then replays a
 * fixture and exits with the given code. Spawned exactly as the real CLI would be.
 */
async function fakeCommand(name: string, fixture: string, exitCode = 0): Promise<{ command: string; read: () => Promise<{ args: string[]; stdin: string }> }> {
  const base = path.join(dir, name);
  const recorder = `${base}.record.mjs`;
  await writeFile(
    recorder,
    `import { writeFileSync } from 'node:fs';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
writeFileSync(${JSON.stringify(`${base}.args.json`)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(`${base}.stdin.txt`)}, Buffer.concat(chunks));
`,
  );
  const script = `#!/bin/sh\n"${process.execPath}" "${recorder}" "$@" || exit 99\nexec "${process.execPath}" "${FAKE}" replay "${path.join(FIXTURES, fixture)}" ${exitCode}\n`;
  await writeFile(base, script);
  await chmod(base, 0o755);
  return {
    command: base,
    read: async () => ({
      args: JSON.parse(await readFile(`${base}.args.json`, 'utf8')) as string[],
      stdin: await readFile(`${base}.stdin.txt`, 'utf8'),
    }),
  };
}

function cfg(command: string, extra: Partial<CliConfig> = {}): CliConfig {
  return { command, extraArgs: [], timeoutSec: 0, promptMode: 'stdin', stripApiKeys: true, ...extra };
}

function request(partial: Partial<RunRequest> = {}): RunRequest & { shown: () => string } {
  let shown = '';
  return {
    prompt: 'Question with "quotes", $VARS and ünïcode ✓',
    model: '',
    effort: '',
    webSearch: false,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    onText: (t, replace) => {
      shown = replace ? t : shown + t;
    },
    onActivity: () => undefined,
    shown: () => shown,
    ...partial,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'council-adapters-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CLI adapters end to end (fake executables)', () => {
  it('Claude: prompt on stdin, documented arguments, streamed and final text', async () => {
    const fake = await fakeCommand('claude', 'claude-success.jsonl');
    const req = request({ model: 'haiku', effort: 'low' });
    const out = await claudeProvider(cfg(fake.command, { extraArgs: ['--x'] })).run(req);
    expect(out).toMatchObject({ text: 'council probe ok', model: 'claude-haiku-5-5', billing: 'subscription' });
    expect(req.shown()).toBe('council probe ok');
    expect(out.diagnostics).toContain('--- stdout (last part) ---');
    const { args, stdin } = await fake.read();
    expect(stdin).toBe(req.prompt);
    expect(args).toContain(CLAUDE_SYSTEM_PROMPT);
    expect(args.slice(-7)).toEqual(['--tools', '', '--model', 'haiku', '--effort', 'low', '--x']);
    expect(args).not.toContain(req.prompt);
  });

  it('Claude: an error result becomes a ProviderError with diagnostics', async () => {
    const fake = await fakeCommand('claude-err', 'claude-error.jsonl', 1);
    const err = await claudeProvider(cfg(fake.command)).run(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/^Claude Code CLI reported an error: There's an issue with the selected model/);
    expect((err as ProviderError).diagnostics).toContain('not-a-real-model-xyz');
  });

  it('Codex: --search before exec, prompt on stdin after "-", auth failure explained', async () => {
    const fake = await fakeCommand('codex', 'codex-auth-failure.jsonl', 1);
    const err = (await codexProvider(cfg(fake.command))
      .run(request({ webSearch: true, model: 'gpt-6.2-sol', effort: 'high' }))
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^Codex CLI failed: unexpected status 401 Unauthorized/);
    expect(err.message).toMatch(/Run `codex login` and choose Sign in with ChatGPT\.$/);
    const { args, stdin } = await fake.read();
    expect(args[0]).toBe('--search');
    expect(args[1]).toBe('exec');
    expect(args.slice(-5)).toEqual(['-m', 'gpt-6.2-sol', '-c', 'model_reasoning_effort=high', '-']);
    expect(stdin).toBe('Question with "quotes", $VARS and ünïcode ✓');
  });

  it('Codex: success returns the last agent message', async () => {
    const fake = await fakeCommand('codex-ok', 'codex-success.jsonl');
    const out = await codexProvider(cfg(fake.command)).run(request());
    expect(out.text).toBe('## Answer\n\nUse the standard approach — it handles “edge cases” well.');
  });

  it('Antigravity: one JSON line on stdin, or the prompt as an argument', async () => {
    const home = path.join(dir, 'home');
    const fake = await fakeCommand('agy', 'agy-success-active.jsonl');
    const req = request();
    const out = await antigravityProvider(cfg(fake.command), home).run(req);
    expect(out).toMatchObject({ text: 'Hello, world — ünïcode ✓', model: 'gemini-4-neon-high', billing: 'subscription' });
    const { args, stdin } = await fake.read();
    expect(args.slice(0, 4)).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json']);
    expect(stdin).toBe(JSON.stringify({ event: 'user', message: { content: req.prompt } }) + '\n');

    const argMode = await fakeCommand('agy-arg', 'agy-success-active.jsonl');
    await antigravityProvider(cfg(argMode.command, { promptMode: 'arg' }), home).run(req);
    const recorded = await argMode.read();
    expect(recorded.args.slice(0, 2)).toEqual(['-p', req.prompt]);
    expect(recorded.stdin).toBe('');
  });

  it('reports a missing CLI as not installed', async () => {
    const info = await claudeProvider(cfg(path.join(dir, 'missing-claude'))).info();
    expect(info.installed).toBe(false);
    expect(info.authDetail).toMatch(/was not found\. Install Claude Code: https:\/\/code\.claude\.com\/docs\/en\/setup\./);
  });
});
