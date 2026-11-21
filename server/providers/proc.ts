import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { TailBuffer, cleanCliText, joinSentences } from '../util/text';
import { abortError, ProviderError } from './types';

const TAIL_CHARS = 8 * 1024;
const KILL_GRACE_MS = 2_000;
const LINGER_MS = 5_000;
const STDIO_AFTER_EXIT_MS = 2_000;

export interface ProcOptions {
  command: string;
  args: string[];
  /** Written to stdin; stdin is always ended, so no CLI waits for input. */
  stdin: string | null;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Shown in messages, e.g. "Claude Code CLI". */
  cliName: string;
  installHint: string;
  /** Each complete stdout line. Return 'terminal' once the CLI's final event has been seen. */
  onLine?(line: string): 'terminal' | void;
  /** Decoded stdout as it arrives. */
  onData?(text: string): void;
  /** How long to wait for the process to exit after its terminal event. */
  lingerMs?: number;
}

export interface ProcResult {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  /** Labelled stdout/stderr tails, ANSI-stripped, for the troubleshooting panel. */
  diagnostics: string;
  /** The adapter reported its terminal event. */
  terminal: boolean;
  /** The process did not exit on its own after the terminal event and was killed. */
  lingered: boolean;
}

/** Every child that may still be running, so shutdown can kill them all. */
const live = new Set<ChildProcess>();

export function liveChildCount(): number {
  return live.size;
}

/** Kills the child and everything it started. Never throws. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
        'error',
        () => undefined,
      );
    } catch {
      // Nothing else can be done; the process may already be gone.
    }
    return;
  }
  // The child leads its own process group (detached), so a negative pid reaches the whole tree.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group has exited.
    }
  }, KILL_GRACE_MS);
}

/** Kills every live child tree; `force` sends SIGKILL at once (for process exit). */
export function killAll(force = false): void {
  for (const child of live) {
    if (force && process.platform !== 'win32' && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    } else {
      killTree(child);
    }
  }
}

function describeSpawnError(err: NodeJS.ErrnoException, o: ProcOptions): ProviderError {
  switch (err.code) {
    case 'ENOENT':
      return new ProviderError(
        joinSentences(
          `\`${o.command}\` was not found.`,
          o.installHint,
          'If it is installed in a different place, enter its full path as the command in Settings → Providers.',
        ),
      );
    case 'EACCES':
      return new ProviderError(
        `\`${o.command}\` could not be started: permission denied. Check that the file is executable, or correct the command in Settings → Providers.`,
      );
    case 'E2BIG':
      return new ProviderError(
        `The prompt is too long to pass to ${o.cliName} as a command-line argument. Switch the provider's prompt delivery to stdin.`,
      );
    default:
      return new ProviderError(`\`${o.command}\` could not be started: ${err.message}`);
  }
}

/**
 * On Windows, .cmd and .bat launchers run through cmd.exe, which stops reading its command line
 * at the first line break: a prompt passed as an argument would silently lose everything after
 * its first line. Native executables are unaffected.
 */
export function losesMultilineArgs(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  parse: ((command: string, args: string[]) => { command: string }) | undefined = crossSpawnParse,
): boolean {
  if (platform !== 'win32' || !args.some((a) => /[\r\n]/.test(a))) return false;
  if (/\.(?:cmd|bat)$/i.test(command)) return true;
  if (/\.(?:exe|com)$/i.test(command) || !parse) return false;
  try {
    // cross-spawn swaps in the command interpreter exactly when the target needs it.
    return /(?:^|[\\/])cmd(?:\.exe)?$/i.test(parse(command, [...args]).command);
  } catch {
    return false;
  }
}

const crossSpawnParse = (spawn as unknown as { _parse?: (command: string, args: string[]) => { command: string } })
  ._parse;

function buildDiagnostics(stdout: string, stderr: string): string {
  const parts: string[] = [];
  const err = cleanCliText(stderr);
  const out = cleanCliText(stdout);
  if (err) parts.push(`--- stderr (last part) ---\n${err}`);
  if (out) parts.push(`--- stdout (last part) ---\n${out}`);
  return parts.join('\n\n');
}

/**
 * Runs a CLI in a fresh empty directory and streams its stdout. Resolves when the process exits
 * (whatever the exit code; the adapter decides what it means) or when it lingers after its
 * terminal event. Rejects on spawn failure, timeout and abort, killing the process tree.
 */
export async function runProcess(o: ProcOptions): Promise<ProcResult> {
  if (o.signal?.aborted) throw abortError();
  if (losesMultilineArgs(o.command, o.args)) {
    throw new ProviderError(
      `\`${o.command}\` is started through a Windows command script, which cannot receive a multi-line argument. Switch the provider's prompt delivery to stdin.`,
    );
  }
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-council-'));
  const removeCwd = () => {
    fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  };
  if (o.signal?.aborted) {
    removeCwd();
    throw abortError();
  }

  return new Promise<ProcResult>((resolve, reject) => {
    const stdoutTail = new TailBuffer(TAIL_CHARS);
    const stderrTail = new TailBuffer(TAIL_CHARS);
    let settled = false;
    let terminal = false;
    let closed = false;
    let timers: NodeJS.Timeout[] = [];
    let child: ChildProcess;

    const result = (exitCode: number | null, exitSignal: NodeJS.Signals | null, lingered: boolean): ProcResult => ({
      exitCode,
      exitSignal,
      stdoutTail: stdoutTail.toString(),
      stderrTail: stderrTail.toString(),
      diagnostics: buildDiagnostics(stdoutTail.toString(), stderrTail.toString()),
      terminal,
      lingered,
    });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      timers = [];
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const fail = (err: Error) => {
      settle(() => {
        if (!closed) killTree(child);
        reject(err);
      });
    };

    const onAbort = () => fail(abortError());

    try {
      child = spawn(o.command, o.args, {
        cwd,
        env: o.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      removeCwd();
      reject(describeSpawnError(err as NodeJS.ErrnoException, o));
      return;
    }
    live.add(child);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      live.delete(child);
      removeCwd();
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      // Spawn failures arrive here; the process never ran, so there is nothing to kill.
      const neverRan = child.pid === undefined;
      if (neverRan) {
        closed = true;
        cleanup();
      }
      // On Windows a missing command is reported after cmd.exe has run, so it has a pid; the
      // error code, not the pid, says that the command could not be started.
      const notStarted = neverRan || err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'E2BIG';
      fail(notStarted ? describeSpawnError(err, o) : new ProviderError(`${o.cliName} failed: ${err.message}`));
    });

    const deliver = (line: string) => {
      if (settled || !o.onLine) return;
      try {
        if (o.onLine(line) === 'terminal' && !terminal) {
          terminal = true;
          timers.push(
            setTimeout(() => {
              settle(() => {
                killTree(child);
                resolve(result(null, null, true));
              });
            }, o.lingerMs ?? LINGER_MS),
          );
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const decoder = new StringDecoder('utf8');
    let partial = '';
    const handleStdout = (text: string) => {
      if (!text) return;
      stdoutTail.append(text);
      if (settled) return;
      o.onData?.(text);
      if (!o.onLine) return;
      let start = 0;
      let nl: number;
      while ((nl = text.indexOf('\n', start)) >= 0) {
        const line = partial + text.slice(start, nl);
        partial = '';
        deliver(line.endsWith('\r') ? line.slice(0, -1) : line);
        start = nl + 1;
      }
      partial += text.slice(start);
    };
    child.stdout!.on('data', (buf: Buffer) => handleStdout(decoder.write(buf)));

    const errDecoder = new StringDecoder('utf8');
    child.stderr!.on('data', (buf: Buffer) => stderrTail.append(errDecoder.write(buf)));

    child.stdin!.on('error', () => {
      // EPIPE and friends: the CLI exited or closed stdin early; its exit status tells the story.
    });
    if (o.stdin !== null && o.stdin !== '') child.stdin!.end(o.stdin, 'utf8');
    else child.stdin!.end();

    child.on('exit', () => {
      // A grandchild that inherited stdout can keep the pipes open after the CLI itself exits.
      const t = setTimeout(() => {
        if (closed) return;
        killTree(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, STDIO_AFTER_EXIT_MS);
      t.unref();
    });

    child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
      closed = true;
      handleStdout(decoder.end());
      if (partial) {
        const line = partial;
        partial = '';
        deliver(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
      stderrTail.append(errDecoder.end());
      cleanup();
      settle(() => resolve(result(code, sig, false)));
    });

    timers.push(
      setTimeout(() => {
        const secs = Math.round(o.timeoutMs / 1000);
        fail(
          new ProviderError(
            `${o.cliName} timed out after ${secs} s. Raise the timeout in Settings (General, or this provider's own timeout) if the model needs longer.`,
            buildDiagnostics(stdoutTail.toString(), stderrTail.toString()),
          ),
        );
      }, o.timeoutMs),
    );
    o.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE = 16 * 1024 * 1024;

/** Runs a short command (version, login status, model list) and captures its output. */
export async function runCommand(
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; cliName: string; installHint: string },
): Promise<CommandResult> {
  let stdout = '';
  const res = await runProcess({
    command,
    args,
    stdin: null,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    cliName: opts.cliName,
    installHint: opts.installHint,
    onData: (text) => {
      if (stdout.length < MAX_CAPTURE) stdout += text;
    },
  });
  return { exitCode: res.exitCode, stdout, stderr: res.stderrTail };
}
