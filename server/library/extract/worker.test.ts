import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { liveWorkerCount, TIMEOUT_DETAIL, WorkerExtractor } from './extractor';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

let dir: string;
const extractors: WorkerExtractor[] = [];

function make(timeoutMs = 20_000): WorkerExtractor {
  const e = new WorkerExtractor({ timeoutMs, testHooks: true });
  extractors.push(e);
  return e;
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'council-worker-'));
  await writeFile(path.join(dir, 'stuck__hang__.txt'), 'x');
  await writeFile(path.join(dir, 'dies__crash__.txt'), 'x');
  await copyFile(path.join(FIXTURES, 'utf8.txt'), path.join(dir, 'fine.txt'));
});

afterEach(async () => {
  for (const e of extractors.splice(0)) e.stop();
  await waitFor(() => liveWorkerCount() === 0);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extraction worker', () => {
  it('runs TypeScript in a separate process, launched with an explicit tsx loader', async () => {
    // Under vitest, process.execArgv has no tsx loader flags; the worker still starts.
    expect(process.execArgv.join(' ')).not.toMatch(/tsx/);
    const e = make();
    const r = await e.extract(path.join(FIXTURES, 'report.pdf'), 'pdf');
    expect(r.status).toBe('ok');
    expect(e.running).toBe(true);
    expect(liveWorkerCount()).toBe(1);
  });

  it('kills a hanging extraction at the timeout and reads the next file in a fresh worker', async () => {
    const e = make(1_500);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 25);
    const started = Date.now();
    const hung = await e.extract(path.join(dir, 'stuck__hang__.txt'), 'txt');
    clearInterval(timer);
    expect(hung).toEqual({ status: 'error', detail: TIMEOUT_DETAIL });
    expect(Date.now() - started).toBeLessThan(10_000);
    // The server process kept running its event loop while the worker spun.
    expect(ticks).toBeGreaterThan(10);
    const next = await e.extract(path.join(dir, 'fine.txt'), 'txt');
    expect(next.status).toBe('ok');
  });

  it('records a crash as an error and recovers', async () => {
    const e = make();
    const crashed = await e.extract(path.join(dir, 'dies__crash__.txt'), 'txt');
    expect(crashed.status).toBe('error');
    expect(crashed.detail).toMatch(/^The file could not be read: the reader stopped unexpectedly \(exit code 7\)\.$/);
    expect((await e.extract(path.join(dir, 'fine.txt'), 'txt')).status).toBe('ok');
  });

  it('serialises calls: one file at a time, answers in order', async () => {
    const e = make();
    const results = await Promise.all([
      e.extract(path.join(FIXTURES, 'utf8.txt'), 'txt'),
      e.extract(path.join(FIXTURES, 'sales.xlsx'), 'xlsx'),
      e.extract(path.join(FIXTURES, 'scan.pdf'), 'pdf'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'empty']);
  });

  it('aborts promptly and leaves no worker behind after stop()', async () => {
    const e = make();
    const ctl = new AbortController();
    const pending = e.extract(path.join(dir, 'stuck__hang__.txt'), 'txt', ctl.signal);
    setTimeout(() => ctl.abort(), 300);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => liveWorkerCount() === 0);
    await e.extract(path.join(dir, 'fine.txt'), 'txt');
    expect(liveWorkerCount()).toBe(1);
    e.stop();
    await waitFor(() => liveWorkerCount() === 0);
    expect(e.running).toBe(false);
  });

  it('does not honour test file names unless test hooks are on', async () => {
    const e = new WorkerExtractor({ timeoutMs: 20_000 });
    extractors.push(e);
    const r = await e.extract(path.join(dir, 'dies__crash__.txt'), 'txt');
    expect(r).toEqual({ status: 'ok', parts: [{ label: '', text: 'x' }], detail: '' });
  });
});
