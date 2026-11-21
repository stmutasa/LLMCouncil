import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { antigravityInvocation, createAntigravityParser, parseAntigravityModels } from './antigravity';
import { claudeArgs, CLAUDE_SYSTEM_PROMPT, createClaudeParser, describeClaudeAuth } from './claude';
import type { StreamParser } from './cli';
import { codexArgs, createCodexParser, describeCodexLogin, parseCodexModels } from './codex';
import { customArgs } from './custom';
import type { ProcResult } from './proc';

function fixture(name: string): string[] {
  const text = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
  return text.split('\n').filter((l, i, all) => l !== '' || i < all.length - 1);
}

function proc(partial: Partial<ProcResult> = {}): ProcResult {
  return {
    exitCode: 0,
    exitSignal: null,
    stdoutTail: '',
    stderrTail: '',
    diagnostics: '',
    terminal: false,
    lingered: false,
    ...partial,
  };
}

/** Mirrors what a UI would show from onText/onActivity calls. */
function recorder() {
  const rec = {
    shown: '',
    replaces: 0,
    activities: [] as string[],
    onText(text: string, replace: boolean) {
      if (replace) {
        rec.replaces++;
        rec.shown = text;
      } else rec.shown += text;
    },
    onActivity(label: string) {
      rec.activities.push(label);
    },
  };
  return rec;
}

function feed(parser: StreamParser, lines: string[]): { terminalAt: number | null } {
  let terminalAt: number | null = null;
  lines.forEach((line, i) => {
    if (parser.push(line) === 'terminal' && terminalAt === null) terminalAt = i;
  });
  return { terminalAt };
}

describe('Claude parser', () => {
  it('streams text, reports the model and subscription billing, and uses result as the final text', () => {
    const rec = recorder();
    const parser = createClaudeParser(rec);
    const lines = fixture('claude-success.jsonl');
    const { terminalAt } = feed(parser, lines);
    expect(terminalAt).toBe(lines.findIndex((l) => l.includes('"type":"result"')));
    expect(rec.shown).toBe('council probe ok');
    expect(parser.finish(proc())).toEqual({ text: 'council probe ok', model: 'claude-haiku-5-5', billing: 'subscription' });
  });

  it('clears text streamed before a tool call when the next message starts, and shows activities', () => {
    const rec = recorder();
    const parser = createClaudeParser(rec);
    const seen: string[] = [];
    for (const line of fixture('claude-websearch.jsonl')) {
      parser.push(line);
      if (line.includes('"type":"tool_use"')) seen.push(rec.shown);
    }
    expect(seen[0]).toBe('Let me check the current release schedule.');
    expect(rec.replaces).toBe(1);
    expect(rec.shown.startsWith('Node.js 26 should be the current stable LTS line')).toBe(true);
    expect(rec.activities).toEqual(['', 'Searching the web…', 'Thinking…', '']);
    const out = parser.finish(proc());
    expect(out.text).toBe(rec.shown);
    expect(out.text).not.toContain('Let me check');
  });

  it('fails with the result text on an error result and never uses synthetic assistant lines', () => {
    const rec = recorder();
    const parser = createClaudeParser(rec);
    feed(parser, fixture('claude-error.jsonl'));
    expect(rec.shown).toBe('');
    expect(() => parser.finish(proc({ exitCode: 1 }))).toThrow(
      "Claude Code CLI reported an error: There's an issue with the selected model (not-a-real-model-xyz). It may not exist or you may not have access to it. Check the model name in Settings, or leave it empty to use the CLI default.",
    );
  });

  it('uses errors[] or the subtype when an error result has no text', () => {
    const p1 = createClaudeParser(recorder());
    p1.push('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["first","second"]}');
    expect(() => p1.finish(proc())).toThrow('Claude Code CLI reported an error: first; second');
    const p2 = createClaudeParser(recorder());
    p2.push('{"type":"result","subtype":"error_max_turns","is_error":false}');
    expect(() => p2.finish(proc())).toThrow('Claude Code CLI reported an error: error_max_turns');
  });

  it('adds the login hint to authentication errors', () => {
    const p = createClaudeParser(recorder());
    p.push('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}');
    expect(() => p.finish(proc())).toThrow(/Please run \/login Run `claude` and sign in/);
  });

  it('falls back to streamed text when result is empty', () => {
    const p = createClaudeParser(recorder());
    p.push('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"streamed"}}}');
    p.push('{"type":"result","subtype":"success","is_error":false,"result":""}');
    expect(p.finish(proc()).text).toBe('streamed');
  });

  it('ignores sub-agent stream events, malformed and unknown lines', () => {
    const rec = recorder();
    const p = createClaudeParser(rec);
    p.push('garbage {');
    p.push('{"type":"stream_event","parent_tool_use_id":"toolu_1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"sub"}}}');
    p.push('{"type":"brand_new_type","x":1}');
    p.push('{"type":"stream_event","event":null}');
    p.push('[1,2,3]');
    expect(rec.shown).toBe('');
  });

  it('reports api-key billing when an API key is the source', () => {
    const p = createClaudeParser(recorder());
    p.push('{"type":"system","subtype":"init","model":"claude-opus-5","apiKeySource":"ANTHROPIC_API_KEY"}');
    p.push('{"type":"result","subtype":"success","is_error":false,"result":"ok"}');
    expect(p.finish(proc()).billing).toBe('api-key');
  });

  it('fails with the stderr tail when there is no result and the exit code is non-zero', () => {
    const p = createClaudeParser(recorder());
    expect(() => p.finish(proc({ exitCode: 2, stderrTail: '\u001b[31merror: unknown option --foo\u001b[0m\n' }))).toThrow(
      'Claude Code CLI exited with code 2: error: unknown option --foo',
    );
    expect(() => createClaudeParser(recorder()).finish(proc({ exitCode: 5 }))).toThrow(
      'Claude Code CLI exited with code 5 without an error message.',
    );
  });

  it('describes auth status output', () => {
    expect(describeClaudeAuth(0, '{"loggedIn":true,"authMethod":"claude.ai"}')).toMatchObject({ auth: 'ok', billing: 'subscription' });
    expect(describeClaudeAuth(0, '{"loggedIn":true,"authMethod":"oauth_token"}')).toMatchObject({ auth: 'ok', billing: 'subscription' });
    const key = describeClaudeAuth(0, '{"loggedIn":true,"authMethod":"api_key"}');
    expect(key).toMatchObject({ auth: 'ok', billing: 'api-key' });
    expect(key.warnings).toHaveLength(1);
    expect(describeClaudeAuth(1, '{"loggedIn":false,"authMethod":"none"}').auth).toBe('missing');
    expect(describeClaudeAuth(1, 'not json').auth).toBe('missing');
    expect(describeClaudeAuth(0, 'not json').auth).toBe('unknown');
  });
});

describe('Codex parser', () => {
  it('replaces text per agent message, maps activities, and takes the last message', () => {
    const rec = recorder();
    const parser = createCodexParser(rec);
    const lines = fixture('codex-success.jsonl');
    const { terminalAt } = feed(parser, lines);
    expect(terminalAt).toBe(lines.length - 1);
    expect(rec.activities).toEqual([
      'Reasoning…',
      '',
      'Searching the web…',
      '',
      '',
      'Running a command…',
      '',
      '',
      '',
    ]);
    const expected = '## Answer\n\nUse the standard approach — it handles “edge cases” well.';
    expect(rec.shown).toBe(expected);
    expect(parser.finish(proc())).toEqual({ text: expected, model: null, billing: 'unknown' });
  });

  it('fails with the turn.failed message and the login hint on the captured auth failure', () => {
    const parser = createCodexParser(recorder());
    const lines = fixture('codex-auth-failure.jsonl');
    const { terminalAt } = feed(parser, lines);
    expect(terminalAt).toBe(lines.length - 1);
    expect(() => parser.finish(proc({ exitCode: 1 }))).toThrow(
      'Codex CLI failed: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses Run `codex login` and choose Sign in with ChatGPT.',
    );
  });

  it('fails when the turn completes without a message', () => {
    const parser = createCodexParser(recorder());
    parser.push('{"type":"turn.completed","usage":{}}');
    expect(() => parser.finish(proc())).toThrow('Codex returned no message.');
  });

  it('uses the last error notice when the process exits without a terminal event', () => {
    const parser = createCodexParser(recorder());
    parser.push('{"type":"error","message":"Reconnecting... 1/5"}');
    parser.push('{"type":"error","message":"stream disconnected before completion"}');
    expect(() => parser.finish(proc({ exitCode: 1, stderrTail: 'log noise' }))).toThrow(
      'Codex CLI exited with code 1: stream disconnected before completion',
    );
    const bare = createCodexParser(recorder());
    expect(() => bare.finish(proc({ exitCode: 1, stderrTail: 'panic: boom' }))).toThrow('Codex CLI exited with code 1: panic: boom');
  });

  it('tolerates items without fields', () => {
    const rec = recorder();
    const parser = createCodexParser(rec);
    parser.push('{"type":"item.completed"}');
    parser.push('{"type":"item.completed","item":{"type":"agent_message"}}');
    parser.push('{"type":"turn.failed"}');
    expect(() => parser.finish(proc({ exitCode: 1 }))).toThrow('Codex CLI failed: unknown error');
  });

  it('reads login status and the model list', () => {
    expect(describeCodexLogin('Not logged in\n')).toMatchObject({ auth: 'missing' });
    expect(describeCodexLogin('Logged in using ChatGPT\n')).toMatchObject({ auth: 'ok', billing: 'subscription' });
    expect(describeCodexLogin('Logged in using an API key - sk-***\n')).toMatchObject({ auth: 'ok', billing: 'api-key' });
    expect(describeCodexLogin('something else').auth).toBe('unknown');
    expect(
      parseCodexModels('{"models":[{"slug":"gpt-6.2-sol","visibility":"list"},{"slug":"hidden","visibility":"hide"},{"slug":"gpt-5.5","visibility":"list"}]}'),
    ).toEqual(['gpt-6.2-sol', 'gpt-5.5']);
    expect(parseCodexModels('warning line\n[{"slug":"a"},{"slug":"b"}]')).toEqual(['a', 'b']);
    expect(() => parseCodexModels('nothing')).toThrow();
  });
});

describe('Antigravity parser', () => {
  it('appends ACTIVE fragments and prefers the result response', () => {
    const rec = recorder();
    const parser = createAntigravityParser(rec);
    const lines = fixture('agy-success-active.jsonl');
    expect(feed(parser, lines).terminalAt).toBe(lines.length - 1);
    expect(rec.shown).toBe('Hello, world — ünïcode ✓');
    expect(parser.finish(proc())).toEqual({ text: 'Hello, world — ünïcode ✓', model: 'gemini-4-neon-high', billing: 'unknown' });
  });

  it('handles a cumulative DONE delta, clears for a later response step, and uses the first result only', () => {
    const rec = recorder();
    const parser = createAntigravityParser(rec);
    feed(parser, fixture('agy-cumulative.jsonl'));
    expect(rec.replaces).toBe(1);
    expect(rec.shown).toBe('The answer is 42.');
    expect(rec.activities).toContain('Using run_command…');
    expect(parser.finish(proc()).text).toBe('The answer is 42.');
  });

  it('fails with the result error', () => {
    const parser = createAntigravityParser(recorder());
    feed(parser, fixture('agy-error.jsonl'));
    expect(() => parser.finish(proc())).toThrow(
      "Antigravity CLI reported an error: You have used your plan's quota for this model. It resets in 3 hours.",
    );
    const noError = createAntigravityParser(recorder());
    noError.push('{"event":"result","result":{"status":"CANCELLED"}}');
    expect(() => noError.finish(proc())).toThrow('Antigravity CLI ended with status CANCELLED');
  });

  it('treats non-JSON output with exit code 0 as a plain-text answer', () => {
    const rec = recorder();
    const parser = createAntigravityParser(rec);
    feed(parser, fixture('agy-plain.txt'));
    expect(parser.finish(proc()).text).toBe('Plain answer line one.\nSecond line in green.');
    expect(rec.shown).toBe('Plain answer line one.\nSecond line in green.');
  });

  it('explains a missing sign-in', () => {
    const parser = createAntigravityParser(recorder());
    expect(() => parser.finish(proc({ exitCode: 1, stderrTail: 'Error: Authentication required. Please sign in.' }))).toThrow(
      'Antigravity CLI is not signed in. Run `agy` once in a terminal and sign in with your Google account.',
    );
    const other = createAntigravityParser(recorder());
    expect(() => other.finish(proc({ exitCode: 3, stderrTail: 'boom' }))).toThrow('Antigravity CLI exited with code 3: boom');
  });

  it('tolerates events without payloads', () => {
    const rec = recorder();
    const parser = createAntigravityParser(rec);
    parser.push('{"event":"step_update"}');
    parser.push('{"event":"step_update","step_update":{"step_type":"agent_response"}}');
    parser.push('{"event":"init"}');
    parser.push('{"event":"result"}');
    expect(() => parser.finish(proc())).toThrow('Antigravity CLI ended with status UNKNOWN');
  });

  it('parses `agy models` output', () => {
    expect(parseAntigravityModels('gemini-4-neon-high   Gemini 4 Neon (High)\n\nNAME  DISPLAY\ngemini-3.8-flash-high  Flash\n')).toEqual([
      'gemini-4-neon-high',
      'gemini-3.8-flash-high',
    ]);
  });
});

describe('argument builders', () => {
  const base = { model: '', effort: '', webSearch: false };

  it('claude', () => {
    const fixed = [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--system-prompt',
      CLAUDE_SYSTEM_PROMPT,
      '--no-session-persistence',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--setting-sources',
      '',
    ];
    expect(claudeArgs(base, [])).toEqual([...fixed, '--tools', '']);
    expect(claudeArgs({ model: 'haiku', effort: 'high', webSearch: true }, ['--foo', 'bar'])).toEqual([
      ...fixed,
      '--tools',
      'WebSearch,WebFetch',
      '--allowedTools',
      'WebSearch,WebFetch',
      '--model',
      'haiku',
      '--effort',
      'high',
      '--foo',
      'bar',
    ]);
    expect(claudeArgs({ ...base, model: 'opus' }, [])).toEqual([...fixed, '--tools', '', '--model', 'opus']);
    expect(claudeArgs({ ...base, effort: 'max' }, [])).toEqual([...fixed, '--tools', '', '--effort', 'max']);
    expect(claudeArgs(base, [])).not.toContain('--bare');
    expect(CLAUDE_SYSTEM_PROMPT).not.toMatch(/["'`$\\]/);
  });

  it('codex', () => {
    const fixed = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '-s',
      'read-only',
      '--color',
      'never',
      '-c',
      'project_doc_max_bytes=0',
    ];
    expect(codexArgs(base, [])).toEqual([...fixed, '-']);
    expect(codexArgs({ model: 'gpt-6.2-sol', effort: 'high', webSearch: true }, ['--x'])).toEqual([
      '--search',
      ...fixed,
      '-m',
      'gpt-6.2-sol',
      '-c',
      'model_reasoning_effort=high',
      '--x',
      '-',
    ]);
    expect(codexArgs({ ...base, effort: 'low' }, [])).toEqual([...fixed, '-c', 'model_reasoning_effort=low', '-']);
    expect(codexArgs({ ...base, model: 'm' }, [])).toEqual([...fixed, '-m', 'm', '-']);
  });

  it('antigravity, stdin and arg modes', () => {
    const stdin = antigravityInvocation({ ...base, prompt: 'Say "hi"\nplease' }, { extraArgs: [], promptMode: 'stdin' });
    expect(stdin.args).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']);
    expect(stdin.stdin).toBe('{"event":"user","message":{"content":"Say \\"hi\\"\\nplease"}}\n');
    expect(stdin.stdin.split('\n')).toHaveLength(2);

    const full = antigravityInvocation(
      { model: 'gemini-4-neon-high', effort: 'xhigh', prompt: 'p' },
      { extraArgs: ['--sandbox'], promptMode: 'stdin' },
    );
    expect(full.args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--model',
      'gemini-4-neon-high',
      '--effort',
      'xhigh',
      '--sandbox',
    ]);

    const arg = antigravityInvocation({ model: 'm', effort: '', prompt: 'the prompt' }, { extraArgs: [], promptMode: 'arg' });
    expect(arg).toEqual({
      args: ['-p', 'the prompt', '--output-format', 'stream-json', '--disable-slash-commands', '--model', 'm'],
      stdin: '',
    });
    expect(() =>
      antigravityInvocation({ ...base, prompt: 'x'.repeat(30_001) }, { extraArgs: [], promptMode: 'arg' }),
    ).toThrow(/too long for an argument; switch the provider's prompt delivery to stdin/);
    expect(() => antigravityInvocation({ ...base, prompt: 'x'.repeat(30_000) }, { extraArgs: [], promptMode: 'arg' })).not.toThrow();
  });

  it('custom providers', () => {
    const config = {
      id: 'local',
      label: 'Local',
      command: 'llm',
      args: ['run', '--name={model}'],
      modelArgs: ['-m', '{model}'],
      promptVia: 'stdin' as const,
    };
    expect(customArgs(config, { model: '', prompt: 'p' }, [])).toEqual(['run', '--name=']);
    expect(customArgs(config, { model: 'llama', prompt: 'p' }, ['--x'])).toEqual(['run', '--name=llama', '-m', 'llama', '--x']);
    expect(customArgs({ ...config, promptVia: 'arg' }, { model: '', prompt: 'the prompt' }, [])).toEqual([
      'run',
      '--name=',
      'the prompt',
    ]);
  });
});
