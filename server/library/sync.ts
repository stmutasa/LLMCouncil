import path from 'node:path';
import type { FolderSource, NotionSource, SyncState } from '../../shared/types';
import type { Extractor } from './extract/extractor';
import { finishParts } from './extract/normalize';
import { NotionError, TOKEN_REJECTED, type NotionClient } from './notionClient';
import { scanFolder, TOO_MANY_FILES } from './sources/folder';
import { enumerateNotion, fetchPageText, locationOf, type NotionPage } from './sources/notion';
import { docIdFor, type LibraryStore } from './store';
import { classifyWithoutReading, EXTRACTOR_VERSION, type DocRecord, type ExtractResult, type Part } from './types';

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

/**
 * Applies one extraction result: writes the text file for readable documents and removes the
 * stale one otherwise. Returns the record to store.
 */
async function applyResult(ctx: SyncContext, base: DocRecord, result: ExtractResult): Promise<DocRecord> {
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
      (before.status !== 'ok' || stored.has(before.id));
    if (!unchanged) toRead.push(base);
  }

  if (!scan.truncated) {
    const unreadable = scan.unreadableDirs.map((d) => `${d}/`);
    for (const [key, r] of existing) {
      if (seen.has(key)) continue;
      // Files under a sub-folder that could not be listed may well still be there.
      if (unreadable.some((d) => key.startsWith(d))) continue;
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
    const result = await ctx.extractor.extract(file, base.type, signal);
    if (signal.aborted) throw abortError();
    ctx.records.set(base.id, await applyResult(ctx, base, result));
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
      (before.status !== 'ok' || stored.has(before.id));
    if (unchanged) {
      // A parent can be renamed without the page itself changing.
      const next = { ...before, title: base.title, location: base.location, url: base.url };
      if (!sameRecord(before, next)) {
        ctx.records.set(next.id, next);
        changed = true;
      }
      continue;
    }
    toRead.push({ base, page });
  }

  if (en.complete) {
    for (const [key, r] of existing) {
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
      const { text, truncated } = await fetchPageText(client, page, signal);
      result = finishParts([{ label: '', text }], 'This page is empty.');
      if (truncated && result.status === 'ok' && !result.detail) {
        result = { ...result, detail: 'Notion returned only part of this page.' };
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
    ctx.records.set(base.id, await applyResult(ctx, base, result));
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
export class SyncQueue {
  private readonly queue: string[] = [];
  private current: { sourceId: string; ctl: AbortController; done: Promise<void> } | null = null;
  private readonly states = new Map<string, SyncState>();
  private stopped = false;

  constructor(
    private readonly run: (sourceId: string, signal: AbortSignal, progress: Progress) => Promise<void>,
    private readonly onIdle: () => void,
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
    if (this.current?.sourceId === sourceId) {
      this.current.ctl.abort();
      return this.current.done;
    }
    return Promise.resolve();
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
    };
    this.states.set(sourceId, progress.state);
    const done = this.run(sourceId, ctl.signal, progress)
      .catch((err: unknown) => {
        console.error(`[library] Sync of source ${sourceId} failed:`, err);
      })
      .finally(() => {
        this.states.delete(sourceId);
        this.current = null;
        this.pump();
      });
    this.current = { sourceId, ctl, done };
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    for (const id of [...this.states.keys()]) if (this.current?.sourceId !== id) this.states.delete(id);
    if (this.current) {
      this.current.ctl.abort();
      await this.current.done;
    }
  }
}
