import path from 'node:path';
import type { FolderSource, NotionSource, SyncState } from '../../shared/types';
import type { Extractor } from './extract/extractor';
import { CUT_DETAIL, finishParts } from './extract/normalize';
import { NotionError, TOKEN_REJECTED, type NotionClient } from './notionClient';
import { scanFolder, TOO_MANY_FILES } from './sources/folder';
import { enumerateNotion, fetchPageText, locationOf, type NotionPage } from './sources/notion';
import { docIdFor, type LibraryStore } from './store';
import { classifyWithoutReading, EXTRACTOR_VERSION, MAX_DOCUMENT_CHARS, type DocRecord, type ExtractResult, type Part } from './types';

/** Persist progress this often while reading, so a restart keeps what was done. */
export const PERSIST_EVERY = 25;

export function idleState(error: string | null = null): SyncState {
  return { running: false, phase: 'idle', done: 0, total: 0, current: '', error };
}

/** A sync that could not run or stopped early, with a reason for the user. */
export class SyncStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncStopped';
  }
}

function abortError(): Error {
  const err = new Error('The sync was cancelled.');
  err.name = 'AbortError';
  return err;
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** What a sync job works on. The record map is shared with the rest of the library. */
export interface SyncContext {
  store: LibraryStore;
  records: Map<string, DocRecord>;
  extractor: Extractor;
  persist(): Promise<void>;
  notionClient(): Promise<NotionClient | null>;
  /** The Notion token was rejected; the library stops treating Notion as connected. */
  onNotionRejected(): void;
}

export interface JobOutcome {
  /** Documents were added, changed or removed. */
  changed: boolean;
  /** Set when the sync completed but not everything could be looked at. */
  warning: string | null;
}

function partCount(parts: Part[]): number {
  return parts.some((p) => p.label !== '') ? parts.length : 0;
}

function sameRecord(a: DocRecord | undefined, b: DocRecord): boolean {
  if (!a) return false;
  return (Object.keys(b) as (keyof DocRecord)[]).every((k) => a[k] === b[k]);
}

export const STALE_PREFIX = 'The latest version could not be read';

/** The record keeps the previous good text because the latest version failed to read. */
export function isStale(r: DocRecord): boolean {
  return r.status === 'ok' && r.detail.startsWith(STALE_PREFIX);
}

/**
 * Applies one extraction result: writes the text file for readable documents and removes the
 * stale one otherwise. Returns the record to store. A document that has good text and fails to
 * read this time (a half-downloaded cloud file, a timeout, a server error) keeps its previous
 * text and stays searchable; its old size and date are kept, so the next sync tries again.
 */
async function applyResult(
  ctx: SyncContext,
  base: DocRecord,
  result: ExtractResult,
  previous: DocRecord | undefined,
  hasText: boolean,
): Promise<DocRecord> {
  if (result.status === 'error' && previous?.status === 'ok' && hasText) {
    const reason = result.detail.replace(/\.$/, '');
    return {
      ...previous,
      title: base.title,
      location: base.location,
      url: base.url,
      detail: `${STALE_PREFIX} (${reason}); the previous version is still used.`,
    };
  }
  if (result.status === 'ok') {
    try {
      await ctx.store.writeParts(base.id, result.parts);
    } catch (err) {
      return { ...base, status: 'error', detail: `The text could not be saved: ${(err as Error).message}`, chars: 0, parts: 0 };
    }
    return {
      ...base,
      status: 'ok',
      detail: result.detail,
      chars: result.parts.reduce((n, p) => n + p.text.length, 0),
      parts: partCount(result.parts),
    };
  }
  await ctx.store.deleteParts(base.id);
  return { ...base, status: result.status, detail: result.detail, chars: 0, parts: 0 };
}

export interface Progress {
  state: SyncState;
  /** Set when the queue gave up waiting for this job; it must not record anything any more. */
  abandoned?: boolean;
}

/** Reads what changed in one folder. Unchanged files are not read again. */
export async function syncFolder(
  ctx: SyncContext,
  source: FolderSource,
  signal: AbortSignal,
  progress: Progress,
  scanner: typeof scanFolder = scanFolder,
): Promise<JobOutcome> {
  progress.state.phase = 'scanning';
  const scan = await scanner(source.path, { signal });
  if (signal.aborted) throw abortError();
  // An unreadable folder (an unplugged drive, say) keeps every document it had.
  if (!scan.readable) throw new SyncStopped(scan.error ?? 'The folder could not be read.');

  const stored = await ctx.store.storedTextIds();
  const existing = new Map<string, DocRecord>();
  for (const r of ctx.records.values()) if (r.sourceId === source.id) existing.set(r.key, r);
  let changed = false;
  const seen = new Set<string>();
  const toRead: DocRecord[] = [];

  for (const f of scan.files) {
    seen.add(f.rel);
    const before = existing.get(f.rel);
    const base: DocRecord = {
      id: docIdFor(source.id, f.rel),
      sourceId: source.id,
      key: f.rel,
      title: f.name,
      location: f.dir,
      type: f.type,
      status: 'error',
      detail: '',
      chars: 0,
      parts: 0,
      modifiedAt: new Date(f.mtimeMs || 0).toISOString(),
      url: null,
      size: f.size,
      mtimeMs: f.mtimeMs,
      extractorVersion: EXTRACTOR_VERSION,
    };
    const known = classifyWithoutReading(f.type, f.size);
    if (known) {
      const next: DocRecord = { ...base, status: known.status, detail: known.detail };
      if (!sameRecord(before, next)) {
        if (before?.status === 'ok') await ctx.store.deleteParts(base.id);
        if (signal.aborted) throw abortError();
        ctx.records.set(next.id, next);
        changed = true;
      }
      continue;
    }
    const unchanged =
      before !== undefined &&
      before.size === f.size &&
      before.mtimeMs === f.mtimeMs &&
      before.extractorVersion === EXTRACTOR_VERSION &&
      before.status !== 'error' &&
      !isStale(before) &&
      (before.status !== 'ok' || stored.has(before.id));
    if (!unchanged) toRead.push(base);
  }

  if (!scan.truncated) {
    for (const [key, r] of existing) {
      if (signal.aborted) throw abortError();
      if (seen.has(key)) continue;
      // Files under a sub-folder that could not be listed (or that could not be checked) may well still be there.
      if (scan.unreadableDirs.some((d) => key === d || key.startsWith(`${d}/`))) continue;
      ctx.records.delete(r.id);
      await ctx.store.deleteParts(r.id);
      changed = true;
    }
  }

  progress.state.phase = 'reading';
  progress.state.total = toRead.length;
  progress.state.done = 0;
  for (const base of toRead) {
    if (signal.aborted) throw abortError();
    progress.state.current = base.title;
    const file = path.join(source.path, ...base.key.split('/'));
    const result = await ctx.extractor.extract(file, base.type, signal, source.path);
    if (signal.aborted) throw abortError();
    const previous = existing.get(base.key);
    const record = await applyResult(ctx, base, result, previous, previous !== undefined && stored.has(previous.id));
    // A file read before a cancel is kept, unless the queue has given up on this job (then the
    // source may be gone or owned by a newer job; a stray text file is cleaned up later).
    if (progress.abandoned) throw abortError();
    ctx.records.set(base.id, record);
    changed = true;
    progress.state.done++;
    if (progress.state.done % PERSIST_EVERY === 0) await ctx.persist();
  }
  progress.state.current = '';
  return { changed, warning: scan.truncated ? TOO_MANY_FILES : null };
}

/** Lists the workspace and reads the pages that are new, edited since, or failed before. */
export async function syncNotion(
  ctx: SyncContext,
  source: NotionSource,
  signal: AbortSignal,
  progress: Progress,
): Promise<JobOutcome> {
  const client = await ctx.notionClient();
  if (!client) throw new SyncStopped('Connect Notion in Settings → Library first.');
  progress.state.phase = 'scanning';
  const en = await enumerateNotion(client, signal);
  if (signal.aborted) throw abortError();
  if (!en.complete && en.error === TOKEN_REJECTED) {
    ctx.onNotionRejected();
    throw new SyncStopped(TOKEN_REJECTED);
  }

  const stored = await ctx.store.storedTextIds();
  const existing = new Map<string, DocRecord>();
  for (const r of ctx.records.values()) if (r.sourceId === source.id) existing.set(r.key, r);
  let changed = false;
  const toRead: { base: DocRecord; page: NotionPage }[] = [];

  for (const page of en.pages.values()) {
    const before = existing.get(page.id);
    const base: DocRecord = {
      id: docIdFor(source.id, page.id),
      sourceId: source.id,
      key: page.id,
      title: page.title,
      location: locationOf(page, en),
      type: 'notion',
      status: 'error',
      detail: '',
      chars: 0,
      parts: 0,
      modifiedAt: page.lastEdited,
      url: page.url,
      size: 0,
      mtimeMs: 0,
      extractorVersion: EXTRACTOR_VERSION,
    };
    const unchanged =
      before !== undefined &&
      before.modifiedAt === page.lastEdited &&
      before.extractorVersion === EXTRACTOR_VERSION &&
      before.status !== 'error' &&
      !isStale(before) &&
      (before.status !== 'ok' || stored.has(before.id));
    if (unchanged) {
      // A parent can be renamed without the page itself changing.
      const next = { ...before, title: base.title, location: base.location, url: base.url };
      if (!sameRecord(before, next)) {
        if (signal.aborted) throw abortError();
        ctx.records.set(next.id, next);
        changed = true;
      }
      continue;
    }
    toRead.push({ base, page });
  }

  if (en.complete) {
    for (const [key, r] of existing) {
      if (signal.aborted) throw abortError();
      if (en.pages.has(key)) continue;
      ctx.records.delete(r.id);
      await ctx.store.deleteParts(r.id);
      changed = true;
    }
  }

  progress.state.phase = 'reading';
  progress.state.total = toRead.length;
  progress.state.done = 0;
  for (const { base, page } of toRead) {
    if (signal.aborted) throw abortError();
    progress.state.current = base.title;
    let result: ExtractResult;
    try {
      const fetched = await fetchPageText(client, page, signal);
      // Capped before any processing: the page text is handled in the server process.
      const tooLong = fetched.text.length > MAX_DOCUMENT_CHARS;
      result = finishParts([{ label: '', text: tooLong ? fetched.text.slice(0, MAX_DOCUMENT_CHARS) : fetched.text }], 'This page is empty.');
      if (result.status === 'ok' && !result.detail) {
        if (tooLong) result = { ...result, detail: CUT_DETAIL };
        else if (fetched.truncated) result = { ...result, detail: 'Notion returned only part of this page.' };
      }
    } catch (err) {
      if (signal.aborted || isAbort(err)) throw abortError();
      if (err instanceof NotionError && err.status === 401) {
        ctx.onNotionRejected();
        throw new SyncStopped(TOKEN_REJECTED);
      }
      result = { status: 'error', detail: (err as Error).message };
    }
    if (signal.aborted) throw abortError();
    const previous = existing.get(page.id);
    const record = await applyResult(ctx, base, result, previous, previous !== undefined && stored.has(previous.id));
    // A file read before a cancel is kept, unless the queue has given up on this job (then the
    // source may be gone or owned by a newer job; a stray text file is cleaned up later).
    if (progress.abandoned) throw abortError();
    ctx.records.set(base.id, record);
    changed = true;
    progress.state.done++;
    if (progress.state.done % PERSIST_EVERY === 0) await ctx.persist();
  }
  progress.state.current = '';
  const warning = en.complete
    ? null
    : `Notion did not list every page (${en.error ?? 'unknown error'}). Pages that were not listed were kept.`;
  return { changed, warning };
}

/**
 * Runs one sync at a time; further requests wait in order. Each source has a live SyncState
 * the status endpoint can read at any moment.
 */
/** How long cancel waits for a job to stop before giving up on it. */
export const CANCEL_WAIT_MS = 5_000;

interface Job {
  sourceId: string;
  ctl: AbortController;
  progress: Progress;
  done: Promise<void>;
}

/**
 * Runs one sync at a time; further requests wait in order. Each source has a live SyncState
 * the status endpoint can read at any moment. A job that does not stop within a few seconds of
 * being cancelled (a call stuck on a hung drive) is abandoned: the queue moves on, and the job,
 * marked abandoned and aborted, may no longer record anything.
 */
export class SyncQueue {
  private readonly queue: string[] = [];
  private current: Job | null = null;
  private readonly states = new Map<string, SyncState>();
  private stopped = false;

  constructor(
    private readonly run: (sourceId: string, signal: AbortSignal, progress: Progress) => Promise<void>,
    private readonly onIdle: () => void,
    private readonly cancelWaitMs = CANCEL_WAIT_MS,
  ) {}

  state(sourceId: string, lastError: string | null): SyncState {
    const live = this.states.get(sourceId);
    return live ? { ...live } : idleState(lastError);
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  isQueuedOrRunning(sourceId: string): boolean {
    return this.current?.sourceId === sourceId || this.queue.includes(sourceId);
  }

  request(sourceId: string): void {
    if (this.stopped || this.isQueuedOrRunning(sourceId)) return;
    this.queue.push(sourceId);
    this.states.set(sourceId, { running: true, phase: 'queued', done: 0, total: 0, current: '', error: null });
    this.pump();
  }

  /** Stops a running sync promptly (what was read is kept) or drops a queued one. */
  cancel(sourceId: string): Promise<void> {
    const i = this.queue.indexOf(sourceId);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.states.delete(sourceId);
    }
    const job = this.current;
    if (job?.sourceId === sourceId) return this.stopJob(job);
    return Promise.resolve();
  }

  private stopJob(job: Job): Promise<void> {
    job.ctl.abort();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.abandon(job);
        resolve();
      }, this.cancelWaitMs);
      t.unref?.();
      void job.done.then(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private abandon(job: Job): void {
    if (this.current !== job) return;
    job.progress.abandoned = true;
    console.warn(`[library] The check of source ${job.sourceId} did not stop when cancelled; it was abandoned.`);
    this.release(job);
  }

  private release(job: Job): void {
    if (this.states.get(job.sourceId) === job.progress.state) this.states.delete(job.sourceId);
    if (this.current === job) {
      this.current = null;
      this.pump();
    }
  }

  private pump(): void {
    if (this.current || this.stopped) return;
    const sourceId = this.queue.shift();
    if (sourceId === undefined) {
      this.onIdle();
      return;
    }
    const ctl = new AbortController();
    const progress: Progress = {
      state: { running: true, phase: 'scanning', done: 0, total: 0, current: '', error: null },
      abandoned: false,
    };
    this.states.set(sourceId, progress.state);
    const job: Job = { sourceId, ctl, progress, done: Promise.resolve() };
    job.done = this.run(sourceId, ctl.signal, progress)
      .catch((err: unknown) => {
        console.error(`[library] Sync of source ${sourceId} failed:`, err);
      })
      .finally(() => this.release(job));
    this.current = job;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    for (const id of [...this.states.keys()]) if (this.current?.sourceId !== id) this.states.delete(id);
    if (this.current) await this.stopJob(this.current);
  }
}
