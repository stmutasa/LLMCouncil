import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitArbiterOutput } from '../../shared/arbiter';
import { defaultSettings } from '../../shared/defaults';
import type { ProviderInfo } from '../../shared/types';
import { buildArbiterPrompt, buildReviewPrompt, type MemberPromptContext } from '../engine/prompts';
import { parseRanking } from '../engine/ranking';
import { readAntigravityConfig } from './antigravity';
import { customProvider } from './custom';
import { apiKeyWarnings, buildChildEnv, presentApiKeyVars } from './env';
import { mockProvider, mockResponse } from './mock';
import { cliConfigFor, ProviderRegistry, timeoutMsFor } from './registry';
import type { Provider, RunRequest } from './types';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));

function req(partial: Partial<RunRequest> = {}): RunRequest & { shown: () => string } {
  let shown = '';
  return {
    prompt: 'hello',
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

function fakeInfo(id: string): ProviderInfo {
  return { id, installed: true } as ProviderInfo;
}

describe('ProviderRegistry', () => {
  it('caches detection for a minute, bypasses the cache on refresh and when provider settings change', async () => {
    let count = 0;
    const counter: Provider = {
      id: 'counter',
      info: async () => {
        count++;
        return fakeInfo('counter');
      },
      run: () => Promise.reject(new Error('unused')),
    };
    const registry = new ProviderRegistry({ mock: false, overrides: { claude: counter, codex: counter, antigravity: counter } });
    const settings = defaultSettings(false);
    await registry.listInfo(settings);
    await registry.listInfo(settings);
    expect(count).toBe(3);
    await registry.listInfo(settings, { refresh: true });
    expect(count).toBe(6);
    settings.providers.claude = { command: '/opt/claude', extraArgs: [], timeoutSec: 0, promptMode: 'stdin' };
    await registry.listInfo(settings);
    expect(count).toBe(9);
  });

  it('turns a failing or hanging detection into installed:false with the reason', async () => {
    const registry = new ProviderRegistry({
      mock: true,
      detectTimeoutMs: 100,
      overrides: {
        claude: { id: 'claude', info: () => Promise.reject(new Error('kaboom')), run: () => Promise.reject(new Error('x')) },
        codex: { id: 'codex', info: () => new Promise(() => undefined), run: () => Promise.reject(new Error('x')) },
        antigravity: { id: 'antigravity', info: async () => fakeInfo('antigravity'), run: () => Promise.reject(new Error('x')) },
      },
    });
    const list = await registry.listInfo(defaultSettings(true));
    expect(list.map((p) => p.id)).toEqual(['claude', 'codex', 'antigravity', 'mock']);
    expect(list[0]).toMatchObject({ installed: false, authDetail: 'Detection failed: kaboom', label: 'Claude', cliName: 'Claude Code CLI' });
    expect(list[1]).toMatchObject({ installed: false, authDetail: 'Detection failed: ChatGPT did not respond within 0.1 s.' });
    expect(list[3]).toMatchObject({ id: 'mock', installed: true, kind: 'mock' });
  });

  it('resolves providers, labels and per-provider configuration', () => {
    const settings = defaultSettings(false);
    settings.customProviders.push({ id: 'local', label: 'Local LLM', command: 'llm', args: [], modelArgs: [], promptVia: 'stdin' });
    settings.providers.codex = { command: '/usr/local/bin/codex', extraArgs: ['--x'], timeoutSec: 30, promptMode: 'stdin' };
    const registry = new ProviderRegistry({ mock: false });
    expect(registry.get('claude', settings)?.id).toBe('claude');
    expect(registry.get('local', settings)?.id).toBe('local');
    expect(registry.get('mock', settings)).toBeNull();
    expect(registry.get('nope', settings)).toBeNull();
    expect(registry.ids(settings)).toEqual(['claude', 'codex', 'antigravity', 'local']);
    expect(registry.label('codex', settings)).toBe('ChatGPT');
    expect(registry.label('local', settings)).toBe('Local LLM');
    expect(registry.label('nope', settings)).toBe('nope');
    expect(registry.webSearchSupport('claude')).toBe('toggle');
    expect(registry.webSearchSupport('antigravity')).toBe('builtin');
    expect(registry.webSearchSupport('local')).toBe('none');
    expect(cliConfigFor(settings, 'codex')).toEqual({ command: '/usr/local/bin/codex', extraArgs: ['--x'], timeoutSec: 30, promptMode: 'stdin', stripApiKeys: true });
    expect(cliConfigFor(settings, 'claude')).toEqual({ command: '', extraArgs: [], timeoutSec: 0, promptMode: 'stdin', stripApiKeys: true });
    expect(timeoutMsFor(settings, 'codex')).toBe(30_000);
    expect(timeoutMsFor(settings, 'claude')).toBe(600_000);
  });
});

describe('API-key environment handling', () => {
  const env = { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '', PATH: '/bin' };
  it('detects set variables and words the warnings by setting', () => {
    expect(presentApiKeyVars(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK'], env)).toEqual(['ANTHROPIC_API_KEY']);
    expect(apiKeyWarnings(['ANTHROPIC_API_KEY'], true, env)).toEqual([
      'ANTHROPIC_API_KEY is set in this environment; it is removed from council calls so they use your subscription login.',
    ]);
    expect(apiKeyWarnings(['ANTHROPIC_API_KEY'], false, env)).toEqual([
      'ANTHROPIC_API_KEY is set and will be used — calls may be billed to the API.',
    ]);
  });

  it('strips case-insensitively and adds NO_COLOR', () => {
    expect(buildChildEnv(['ANTHROPIC_API_KEY'], true, { anthropic_api_key: 'x', PATH: '/bin' })).toEqual({ PATH: '/bin', NO_COLOR: '1' });
  });
});

describe('custom provider', () => {
  const config = (args: string[]) => ({ id: 'local', label: 'Local', command: process.execPath, args, modelArgs: [], promptVia: 'stdin' as const });
  const cfg = { command: '', extraArgs: [], timeoutSec: 0, promptMode: 'stdin' as const, stripApiKeys: true };

  it('uses plain stdout as the answer with ANSI stripped', async () => {
    const r = req({ prompt: 'x'.repeat(1234) });
    const out = await customProvider(config([FAKE, 'plain']), cfg).run(r);
    expect(out.text).toBe('Answer: received 1234 characters');
    expect(r.shown()).toBe('Answer: received 1234 characters');
  });

  it('fails with the stderr tail on a non-zero exit', async () => {
    await expect(customProvider(config([FAKE, 'exit', '4']), cfg).run(req())).rejects.toThrow(
      'Local (custom command) exited with code 4: fatal: something went wrong (no detail)',
    );
  });

  it('reports version detection', async () => {
    const info = await customProvider(config([FAKE]), { ...cfg, command: '/nonexistent/llm' }).info();
    expect(info).toMatchObject({ installed: false, kind: 'custom', auth: 'unknown', webSearch: 'none' });
  });
});

describe('Antigravity settings file', () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'council-home-'));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const write = async (content: string) => {
    await mkdir(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    await writeFile(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), content);
  };

  it('defaults to subscription billing', async () => {
    expect(await readAntigravityConfig(path.join(home, 'nobody'))).toEqual({ billing: 'subscription', warnings: [] });
  });

  it('warns about API-key billing and overage credits', async () => {
    await write('{"modelProvider":"gemini","useG1Credits":true}');
    const cfg = await readAntigravityConfig(home);
    expect(cfg.billing).toBe('api-key');
    expect(cfg.warnings).toHaveLength(2);
    expect(cfg.warnings[1]).toMatch(/Overage AI credits are enabled/);
  });

  it('ignores a file it cannot parse', async () => {
    await write('// comment\n{"modelProvider": "gemini",}');
    expect(await readAntigravityConfig(home)).toEqual({ billing: 'subscription', warnings: [] });
  });
});

describe('mock provider', () => {
  const ctx: MemberPromptContext = {
    name: 'Gemini',
    roleId: 'none',
    customRole: '',
    councilSize: 3,
    mode: 'council',
    webSearch: false,
    councilRules: '',
    history: '',
    question: 'Pick a database.',
  };
  const info = { index: 1, total: 2, title: 'Peer review & ranking', instructions: '', anonymize: true, includeSelf: false };
  const shown = [
    { label: 'A', name: 'Claude', text: 'one' },
    { label: 'C', name: 'ChatGPT', text: 'two' },
  ];

  it('writes a critique per label and a valid, deterministic ranking', () => {
    const { prompt } = buildReviewPrompt(ctx, info, shown, true);
    const text = mockResponse(prompt, new Set());
    expect(text).toContain('**Response A.**');
    expect(text).toContain('**Response C.**');
    const ranking = parseRanking(text, ['A', 'C']);
    expect(ranking?.slice().sort()).toEqual(['A', 'C']);
    expect(mockResponse(prompt, new Set())).toBe(text);
  });

  it('writes no ranking for a single response', () => {
    const { prompt } = buildReviewPrompt(ctx, info, [shown[0]!], true);
    expect(mockResponse(prompt, new Set())).not.toContain('FINAL RANKING');
  });

  it('writes the arbiter structure, or plain output when asked', () => {
    const prompt = buildArbiterPrompt({
      name: 'Claude',
      councilSize: 2,
      webSearch: false,
      councilRules: '',
      instructions: '',
      analysis: true,
      history: '',
      question: 'Pick a database.',
      answers: shown,
      reviews: [],
      reviewsAnonymized: false,
      leaderboard: null,
      missing: [],
    });
    const split = splitArbiterOutput(mockResponse(prompt, new Set()), true, true);
    expect(split.hasMarker).toBe(true);
    expect(split.analysis).toMatch(/^\*\*Consensus:\*\*/);
    expect(split.final).toMatch(/\| Option \| Strength \| Risk \|/);
    expect(split.final).toContain('```ts');
    expect(mockResponse(prompt, new Set(['plain']))).not.toContain('===FINAL ANSWER===');
  });

  it('answers by name, echoing the question', () => {
    const text = mockResponse('You are Claude, one of 3.\n\n<question>\nWhat is 2+2?\n</question>', new Set());
    expect(text).toContain("Claude's answer");
    expect(text).toContain('What is 2+2?');
  });

  it('honours fail, hang with timeout, and abort', async () => {
    const p = mockProvider();
    await expect(p.run(req({ model: 'fail' }))).rejects.toThrow('Mock failure');
    await expect(p.run(req({ model: 'hang', timeoutMs: 150 }))).rejects.toThrow('Demo provider timed out after 0 s.');
    const ctl = new AbortController();
    const running = p.run(req({ model: 'hang', signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 50);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    const out = await p.run(req({ model: 'instant', prompt: 'You are Claude, x\n<question>\nq\n</question>' }));
    expect(out).toMatchObject({ model: 'mock-1', billing: 'subscription' });
  });

  it('streams with delays totalling about a second by default', async () => {
    const started = Date.now();
    await mockProvider().run(req({ prompt: 'You are Claude, x\n<question>\nq\n</question>' }));
    const ms = Date.now() - started;
    expect(ms).toBeGreaterThanOrEqual(500);
    expect(ms).toBeLessThan(2500);
  });
});
