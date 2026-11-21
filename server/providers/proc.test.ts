import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildChildEnv } from './env';
import { liveChildCount, runProcess, type ProcOptions, losesMultilineArgs } from './proc';
import { isAbortError } from './types';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));

function opts(mode: string[], extra: Partial<ProcOptions> = {}): ProcOptions {
  return {
    command: process.execPath,
    args: [FAKE, ...mode],
    stdin: null,
    env: buildChildEnv([], false),
    timeoutMs: 10_000,
    cliName: 'Fake CLI',
    installHint: 'Install the fake CLI.',
    ...extra,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe('runProcess', () => {
  afterAll(async () => {
    expect(await waitFor(() => liveChildCount() === 0, 4000)).toBe(true);
  });

  it('delivers a 200 KB prompt over stdin intact', async () => {
    const prompt = ('Ünïcode prompt line ✓ ' + 'x'.repeat(80) + '\n').repeat(2000);
    expect(prompt.length).toBeGreaterThan(200_000);
    const lines: string[] = [];
    const res = await runProcess(opts(['stdin-digest'], { stdin: prompt, onLine: (l) => void lines.push(l) }));
    expect(res.exitCode).toBe(0);
    const buf = Buffer.from(prompt, 'utf8');
    expect(JSON.parse(lines[0]!)).toEqual({ bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
  });

  it('always ends stdin, even with no input', async () => {
    const lines: string[] = [];
    const res = await runProcess(opts(['stdin-ended'], { onLine: (l) => void lines.push(l) }));
    expect(res.exitCode).toBe(0);
    expect(lines).toEqual(['stdin closed after 0 bytes']);
  });

  it('splits lines across chunk boundaries and multi-byte characters, flushing the last partial line', async () => {
    const lines: string[] = [];
    let data = '';
    await runProcess(
      opts(['chunks'], {
        onLine: (l) => void lines.push(l),
        onData: (t) => {
          data += t;
        },
      }),
    );
    expect(lines).toEqual(['première ligne — ünïcode ✓ 日本語 🎉', 'zweite Zeile', 'last line without newline']);
    expect(data).not.toContain('�');
  });

  it('runs in a fresh empty temporary directory that is removed afterwards', async () => {
    const lines: string[] = [];
    await runProcess(opts(['cwd'], { onLine: (l) => void lines.push(l) }));
    expect(lines[0]).toMatch(/llm-council-/);
    expect(await waitFor(() => !existsSync(lines[0]!), 2000)).toBe(true);
  });

  it('resolves with the exit code and keeps stderr for diagnostics', async () => {
    const res = await runProcess(opts(['exit', '3', 'detail']));
    expect(res.exitCode).toBe(3);
    expect(res.stderrTail).toContain('something went wrong (detail)');
    expect(res.diagnostics).toContain('fatal: something went wrong');
    expect(res.diagnostics).not.toContain('\u001b');
  });

  it('times out, killing the process and its children', async () => {
    let info: { pid: number; grandchild: number } | null = null;
    const started = Date.now();
    const err = await runProcess(
      opts(['sleep'], {
        timeoutMs: 600,
        onLine: (l) => {
          info = JSON.parse(l) as { pid: number; grandchild: number };
        },
      }),
    ).catch((e: unknown) => e as Error);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Fake CLI timed out after 1 s/);
    expect(info).not.toBeNull();
    const { pid, grandchild } = info!;
    expect(await waitFor(() => !alive(pid) && !alive(grandchild), 3000)).toBe(true);
  });

  it('rejects promptly with an AbortError on abort and kills the tree', async () => {
    const ctl = new AbortController();
    let info: { pid: number; grandchild: number } | null = null;
    const p = runProcess(
      opts(['sleep'], {
        signal: ctl.signal,
        onLine: (l) => {
          info = JSON.parse(l) as { pid: number; grandchild: number };
          ctl.abort();
        },
      }),
    );
    const started = Date.now();
    const err = await p.catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(isAbortError(err)).toBe(true);
    const { pid, grandchild } = info!;
    expect(await waitFor(() => !alive(pid) && !alive(grandchild), 3000)).toBe(true);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(runProcess(opts(['sleep'], { signal: ctl.signal }))).rejects.toSatisfy(isAbortError);
  });

  it('kills a process that ignores SIGTERM', async () => {
    const ctl = new AbortController();
    let pid = 0;
    const err = await runProcess(
      opts(['ignore-term'], {
        signal: ctl.signal,
        onLine: (l) => {
          if (l.startsWith('{')) {
            pid = (JSON.parse(l) as { pid: number }).pid;
            ctl.abort();
          }
        },
      }),
    ).catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(alive(pid)).toBe(true);
    expect(await waitFor(() => !alive(pid), 4000)).toBe(true);
  });

  it('resolves after the terminal event even if the process lingers, then kills it', async () => {
    let pid = 0;
    const started = Date.now();
    const res = await runProcess(
      opts(['linger'], {
        lingerMs: 300,
        onLine: (l) => {
          if (l === '{"type":"done"}') return 'terminal';
          pid = (JSON.parse(l) as { pid: number }).pid;
        },
      }),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.terminal).toBe(true);
    expect(res.lingered).toBe(true);
    expect(await waitFor(() => !alive(pid), 3000)).toBe(true);
  });

  it('explains a missing command with the install hint', async () => {
    const err = await runProcess(opts([], { command: 'definitely-not-a-real-cli-xyz' })).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe(
      '`definitely-not-a-real-cli-xyz` was not found. Install the fake CLI. If it is installed in a different place, enter its full path as the command in Settings → Providers.',
    );
  });

  it('strips API-key variables when asked, keeps them otherwise, and sets NO_COLOR', async () => {
    const base = { ...process.env, ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-other', KEEP_ME: 'yes' };
    const read = async (strip: boolean) => {
      const lines: string[] = [];
      await runProcess(
        opts(['env', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'KEEP_ME', 'NO_COLOR'], {
          env: buildChildEnv(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], strip, base),
          onLine: (l) => void lines.push(l),
        }),
      );
      return JSON.parse(lines[0]!) as Record<string, string | null>;
    };
    expect(await read(true)).toEqual({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: 'sk-other', KEEP_ME: 'yes', NO_COLOR: '1' });
    expect(await read(false)).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
      OPENAI_API_KEY: 'sk-other',
      KEEP_ME: 'yes',
      NO_COLOR: '1',
    });
  });

  it('ignores EPIPE when the CLI exits without reading a large stdin', async () => {
    const res = await runProcess(opts(['exit', '0'], { stdin: 'y'.repeat(5_000_000) }));
    expect(res.exitCode).toBe(0);
  });
});

describe('losesMultilineArgs', () => {
  const viaShell = () => ({ command: 'C:\\Windows\\system32\\cmd.exe' });
  const direct = (command: string) => ({ command });

  it('is only a concern on Windows, and only for multi-line arguments', () => {
    expect(losesMultilineArgs('tool.cmd', ['line one\nline two'], 'linux', viaShell)).toBe(false);
    expect(losesMultilineArgs('tool.cmd', ['one line'], 'win32', viaShell)).toBe(false);
  });

  it('flags command scripts and anything cross-spawn would run through cmd.exe', () => {
    expect(losesMultilineArgs('tool.cmd', ['a\nb'], 'win32', direct)).toBe(true);
    expect(losesMultilineArgs('tool.BAT', ['a\r\nb'], 'win32', direct)).toBe(true);
    expect(losesMultilineArgs('gemini', ['a\nb'], 'win32', viaShell)).toBe(true);
  });

  it('lets native executables through', () => {
    expect(losesMultilineArgs('C:\\bin\\agy.exe', ['a\nb'], 'win32', viaShell)).toBe(false);
    expect(losesMultilineArgs('agy', ['a\nb'], 'win32', direct)).toBe(false);
    expect(losesMultilineArgs('agy', ['a\nb'], 'win32', undefined)).toBe(false);
  });
});
