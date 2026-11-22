import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ExtractResult } from '../types';
import { oneLine } from './normalize';
import type { WorkerRequest, WorkerResponse } from './worker';

export const EXTRACT_TIMEOUT_MS = 120_000;
export const TIMEOUT_DETAIL = 'Reading this file took too long.';

/** What the sync manager needs from an extractor (tests substitute their own). */
export interface Extractor {
  /**
   * Never rejects except with an AbortError when `signal` is aborted. With `root`, only a regular
   * file that is really inside that folder is read.
   */
  extract(file: string, type: string, signal?: AbortSignal, root?: string): Promise<ExtractResult>;
  /** Ends the worker process, if any. The next extract() starts a fresh one. */
  stop(): void;
}

const WORKER_FILE = fileURLToPath(new URL('./worker.ts', import.meta.url));

/** Every worker that may still be running, so shutdown can end them all. */
const liveWorkers = new Set<ChildProcess>();

export function liveWorkerCount(): number {
  return liveWorkers.size;
}

export function killAllWorkers(): void {
  for (const w of liveWorkers) {
    try {
      w.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function abortError(): Error {
  const err = new Error('Reading was cancelled.');
  err.name = 'AbortError';
  return err;
}

/**
 * The tsx loader, by absolute URL, so the worker can run TypeScript whether the server runs
 * under `tsx` (whose loader flags are in process.execArgv) or under vitest (where they are not).
 */
function loaderUrl(): string {
  return import.meta.resolve('tsx');
}

export interface WorkerExtractorOptions {
  timeoutMs?: number;
  /** Lets the worker honour test-only file names (`__hang__`, `__crash__`). */
  testHooks?: boolean;
}

/** Runs extraction in a forked worker process, one file at a time, with a per-file timeout. */
export class WorkerExtractor implements Extractor {
  private worker: ChildProcess | null = null;
  private stderrTail = '';
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;

  constructor(private readonly options: WorkerExtractorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  }

  get running(): boolean {
    return this.worker !== null;
  }

  private start(): ChildProcess {
    const env = { ...process.env };
    if (this.options.testHooks) env.COUNCIL_EXTRACT_TEST_HOOKS = '1';
    else delete env.COUNCIL_EXTRACT_TEST_HOOKS;
    const child = fork(WORKER_FILE, [], {
      execArgv: ['--import', loaderUrl(), '--max-old-space-size=2048'],
      // pdf.js and SheetJS print notices; they belong to the worker, not to the server log.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
      env,
    });
    liveWorkers.add(child);
    this.stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.on('exit', () => {
      liveWorkers.delete(child);
      if (this.worker === child) this.worker = null;
    });
    child.on('error', () => {
      // Reported through the pending request (exit or timeout); nothing else to do here.
    });
    this.worker = child;
    return child;
  }

  stop(): void {
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    try {
      w.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  extract(file: string, type: string, signal?: AbortSignal, root?: string): Promise<ExtractResult> {
    const run = this.queue.then(() => this.extractNow(file, type, signal, root));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private extractNow(file: string, type: string, signal?: AbortSignal, root?: string): Promise<ExtractResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    const worker = this.worker ?? this.start();
    const id = this.nextId++;
    return new Promise<ExtractResult>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        worker.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onMessage = (msg: WorkerResponse) => {
        if (!msg || msg.id !== id) return;
        finish(() => resolve(msg.result));
      };
      const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
        const memory = /heap out of memory|allocation failed/i.test(this.stderrTail);
        const why = memory
          ? 'the reader ran out of memory'
          : `the reader stopped unexpectedly (${code !== null ? `exit code ${code}` : `signal ${sig ?? 'unknown'}`})`;
        finish(() => resolve({ status: 'error', detail: `The file could not be read: ${why}.` }));
      };
      const onError = (err: Error) => {
        this.stop();
        finish(() => resolve({ status: 'error', detail: `The file could not be read: ${oneLine(err.message)}` }));
      };
      const onAbort = () => {
        this.stop();
        finish(() => reject(abortError()));
      };
      const timer = setTimeout(() => {
        // A parser stuck in a loop never answers; only killing the process frees it.
        this.stop();
        finish(() => resolve({ status: 'error', detail: TIMEOUT_DETAIL }));
      }, this.timeoutMs);
      worker.on('message', onMessage);
      worker.on('exit', onExit);
      worker.on('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      const request: WorkerRequest = { id, file, type, root };
      try {
        worker.send(request, (err) => {
          if (err) onError(err);
        });
      } catch (err) {
        onError(err as Error);
      }
    });
  }
}
