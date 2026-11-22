import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Conversation,
  DocumentStatus,
  LibraryDocument,
  LibraryDocumentsResponse,
  LibraryDocumentText,
  LibrarySource,
  LibrarySourceStatus,
  LibraryStatus,
  NotionPageRef,
  NotionStatus,
  Settings,
  Turn,
} from '../../shared/types';
import { BrowseMirror, type MirrorSource } from './browse';
import { WorkerExtractor, type Extractor } from './extract/extractor';
import { fold } from './tokenize';
import { LibraryIndex, type IndexDocInput } from './index';
import { NotionClient, NotionError, TOKEN_REJECTED, type FetchFn } from './notionClient';
import { saveTurnToNotion } from './notionSave';
import { renderParts } from './render';
import { searchIndex, type FoundPassage } from './search';
import { SecretsStore } from './secrets';
import { checkFolderReady, folderPathProblem } from './sources/folder';
import { pageTitle, readPage } from './sources/notion';
import { DOC_ID_RE, LibraryStore } from './store';
import { isAbort, SyncQueue, syncFolder, syncNotion, SyncStopped, type Progress, type SyncContext } from './sync';
import { publicDocument, SUPPORTED_TYPES, type DocRecord, type Manifest, type Part } from './types';

export const STATUSES: DocumentStatus[] = ['ok', 'empty', 'unsupported', 'stub', 'too-large', 'error'];
const TEXT_LIMIT = 200_000;
const READY_CACHE_MS = 5_000;
const NOTION_CACHE_MS = 60_000;
const START_DELAY_MS = 3_000;
const INDEX_WAIT_MS = 60_000;

/** A library error with an HTTP status (404 unknown, 409 not possible now, 400 bad input). */
export class LibraryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LibraryError';
  }
}

export interface LibraryOptions {
  dataDir: string;
  /** The current settings (a fresh copy each call). */
  settings: () => Settings;
  /** Saves settings (used to add the Notion source when a token is connected). */
  saveSettings: (next: Settings) => Promise<Settings>;
  extractor?: Extractor;
  notionFetch?: FetchFn;
  notionSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Syncs at start (after a short delay) and every autoSyncMinutes. Tests turn it off. */
  autoSync?: boolean;
  startDelayMs?: number;
}

function enabledSourceIds(settings: Settings): string[] {
  return settings.library.sources.filter((s) => s.enabled).map((s) => s.id);
}

function abortError(): Error {
  const err = new Error('Cancelled.');
  err.name = 'AbortError';
  return err;
}

/** Waits for `work`, but no longer than `ms` and not past an abort. */
function within<T>(work: Promise<T>, ms: number, signal: AbortSignal | undefined, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), ms);
    const onAbort = () => finish(() => reject(abortError()));
    const finish = (fn: () => void) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => finish(() => resolve(v)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}

/**
 * The document library: what has been read from each source (the manifest and text files), the
 * search index, the browse mirror, the sync queue and the Notion connection.
 */
export class Library {
  readonly store: LibraryStore;
  readonly secrets: SecretsStore;
  readonly mirror: BrowseMirror;
  private readonly extractor: Extractor;
  private readonly records = new Map<string, DocRecord>();
  private sourceState: Manifest['sources'] = {};
  private index = LibraryIndex.empty();
  private indexBuilt: Promise<void>;
  private markIndexBuilt!: () => void;
  private rebuilding: Promise<void> | null = null;
  private rebuildAgain = false;
  private readonly queue: SyncQueue;
  private readonly readyCache = new Map<string, { at: number; key: string; ready: boolean; detail: string }>();
  private notionCache: { at: number; status: NotionStatus } | null = null;
  private notionCheck: Promise<NotionStatus> | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private reconcileChain: Promise<unknown> = Promise.resolve();
  private persistChain: Promise<unknown> = Promise.resolve();
  private mirrorChain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: LibraryOptions) {
    this.store = new LibraryStore(options.dataDir);
    this.secrets = new SecretsStore(options.dataDir);
    this.mirror = new BrowseMirror(this.store);
    this.extractor = options.extractor ?? new WorkerExtractor();
    this.indexBuilt = new Promise((resolve) => (this.markIndexBuilt = resolve));
    this.queue = new SyncQueue(
      (id, signal, progress) => this.runSync(id, signal, progress),
      () => this.extractor.stop(),
    );
  }

  private get settings(): Settings {
    return this.options.settings();
  }

  /** Loads the manifest and starts the index and mirror in the background. Never blocks on a sync. */
  async init(): Promise<void> {
    await this.store.init();
    const manifest = await this.store.loadManifest();
    for (const r of manifest.documents) this.records.set(r.id, r);
    this.sourceState = manifest.sources;
    await this.reconcile(this.settings, null);
    void this.rebuildIndex().finally(() => this.markIndexBuilt());
    if (this.options.autoSync !== false) this.armAutoSync(this.options.startDelayMs ?? START_DELAY_MS);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    // A sync stuck on an unresponsive drive must not keep the server from stopping.
    await Promise.race([this.queue.shutdown(), new Promise((r) => setTimeout(r, 3_000).unref())]);
    this.extractor.stop();
    await this.persistChain.catch(() => undefined);
    await this.mirrorChain.catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------
  // Persistence, index and mirror

  private persist(): Promise<void> {
    const run = this.persistChain.then(() =>
      this.store.saveManifest({
        version: 1,
        documents: [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
        sources: this.sourceState,
      }),
    );
    this.persistChain = run.catch((err: unknown) => console.error('[library] Could not save the manifest:', err));
    return run;
  }

  private async *indexInputs(): AsyncGenerator<IndexDocInput> {
    const ok = [...this.records.values()].filter((r) => r.status === 'ok').sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const r of ok) {
      const parts = await this.store.readParts(r.id);
      if (parts) yield { id: r.id, sourceId: r.sourceId, title: r.title, location: r.location, parts };
    }
  }

  /** Rebuilds the whole index in the background and swaps it in when complete. */
  rebuildIndex(): Promise<void> {
    if (this.rebuilding) {
      this.rebuildAgain = true;
      return this.rebuilding;
    }
    this.rebuilding = (async () => {
      do {
        this.rebuildAgain = false;
        try {
          this.index = await LibraryIndex.build(this.indexInputs());
        } catch (err) {
          console.error('[library] The search index could not be built:', err);
        }
      } while (this.rebuildAgain && !this.closed);
    })().finally(() => {
      this.rebuilding = null;
    });
    return this.rebuilding;
  }

  /** The sources the mirror shows: enabled ones, in settings order. */
  private mirrorSources(settings: Settings): MirrorSource[] {
    return settings.library.sources.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name, kind: s.kind }));
  }

  /** Brings the browse mirror in line with the library; repairs anything a CLI changed. */
  updateMirror(signal?: AbortSignal): Promise<{ documents: number }> {
    const settings = this.settings;
    const sources = this.mirrorSources(settings);
    const ids = new Set(sources.map((s) => s.id));
    const records = [...this.records.values()].filter((r) => r.status === 'ok' && ids.has(r.sourceId));
    const run = this.mirror.update(sources, records, (id) => this.store.readParts(id), signal);
    this.mirrorChain = run.catch(() => undefined);
    return run;
  }

  private refreshMirrorQuietly(): void {
    this.updateMirror().catch((err: unknown) => console.error('[library] The browse mirror could not be updated:', err));
  }

  // ---------------------------------------------------------------------------------------------
  // Settings

  /**
   * Makes the library match the settings: documents of removed sources (or of a folder source
   * whose path changed) are deleted; new or re-enabled sources are synced when `previous` is
   * given (a save, not the startup check).
   */
  reconcile(next: Settings, previous: Settings | null): Promise<void> {
    const run = this.reconcileChain.then(() => this.reconcileNow(next, previous));
    this.reconcileChain = run.catch((err: unknown) => console.error('[library] Could not apply the library settings:', err));
    return run;
  }

  /** Deletes the documents of the given sources. Callers cancel their syncs first. */
  private async dropSources(ids: Set<string>, keep: Set<string>): Promise<void> {
    let removed = false;
    for (const r of [...this.records.values()]) {
      if (!ids.has(r.sourceId)) continue;
      this.records.delete(r.id);
      await this.store.deleteParts(r.id);
      removed = true;
    }
    for (const id of ids) {
      if (keep.has(id)) this.sourceState[id] = { lastSyncedAt: null, error: null, path: null };
      else delete this.sourceState[id];
      this.readyCache.delete(id);
    }
    if (ids.size > 0) await this.persist();
    if (removed) void this.rebuildIndex();
  }

  private async reconcileNow(next: Settings, previous: Settings | null): Promise<void> {
    const byId = new Map(next.library.sources.map((s) => [s.id, s]));
    const purge = new Set<string>();
    for (const r of this.records.values()) if (!byId.has(r.sourceId)) purge.add(r.sourceId);
    for (const id of Object.keys(this.sourceState)) if (!byId.has(id)) purge.add(id);
    for (const s of next.library.sources) {
      const known = this.sourceState[s.id];
      if (s.kind === 'folder' && known && known.path !== null && known.path !== s.path) purge.add(s.id);
    }
    for (const id of purge) await this.queue.cancel(id);
    await this.dropSources(purge, new Set(byId.keys()));
    this.refreshMirrorQuietly();
    if (this.options.autoSync !== false && previous && previous.library.autoSyncMinutes !== next.library.autoSyncMinutes) {
      this.armAutoSync();
    }

    if (!previous) return;
    const before = new Map(previous.library.sources.map((s) => [s.id, s]));
    for (const s of next.library.sources) {
      const old = before.get(s.id);
      const isNew = !old || (old.kind === 'folder' && s.kind === 'folder' && old.path !== s.path);
      if (s.enabled && (isNew || !old.enabled)) {
        const ready = await this.sourceReady(s, true);
        if (ready.ready) this.queue.request(s.id);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sync

  private armAutoSync(delayMs?: number): void {
    if (this.closed) return;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    const minutes = this.settings.library.autoSyncMinutes;
    const ms = delayMs ?? (minutes > 0 ? minutes * 60_000 : -1);
    if (ms < 0) return;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      void this.syncAllReady().finally(() => {
        if (this.settings.library.autoSyncMinutes > 0) this.armAutoSync();
      });
    }, ms);
    this.autoTimer.unref();
  }

  /** Queues a sync of every enabled source that is ready. */
  async syncAllReady(): Promise<void> {
    for (const s of this.settings.library.sources) {
      if (!s.enabled) continue;
      if ((await this.sourceReady(s, true)).ready) this.queue.request(s.id);
    }
  }

  /** POST /library/sources/:id/sync */
  async requestSync(sourceId: string): Promise<void> {
    const source = this.settings.library.sources.find((s) => s.id === sourceId);
    if (!source) throw new LibraryError(404, 'There is no library source with this id.');
    if (!source.enabled) throw new LibraryError(409, `“${source.name}” is turned off. Turn it on to check it for changes.`);
    const ready = await this.sourceReady(source, true);
    if (!ready.ready) throw new LibraryError(409, ready.detail);
    this.queue.request(sourceId);
  }

  async cancelSync(sourceId: string): Promise<void> {
    await this.queue.cancel(sourceId);
  }

  /** True while any source is queued or syncing (tests and shutdown wait on it). */
  get syncing(): boolean {
    return this.queue.busy;
  }

  private context(): SyncContext {
    return {
      store: this.store,
      records: this.records,
      extractor: this.extractor,
      persist: () => this.persist(),
      notionClient: () => this.notionClient(),
      onNotionRejected: () => {
        this.notionCache = {
          at: Date.now(),
          status: { connected: false, workspace: '', identity: '', error: TOKEN_REJECTED },
        };
      },
    };
  }

  private async runSync(sourceId: string, signal: AbortSignal, progress: Progress): Promise<void> {
    const source = this.settings.library.sources.find((s) => s.id === sourceId);
    if (!source) return;
    const sizeBefore = this.records.size;
    let changed = false;
    let error: string | null = null;
    let completed = false;
    try {
      const outcome =
        source.kind === 'folder'
          ? await syncFolder(this.context(), source, signal, progress)
          : await syncNotion(this.context(), source, signal, progress);
      changed = outcome.changed;
      error = outcome.warning;
      completed = true;
    } catch (err) {
      // What was read before the stop is kept; it is in the record map already.
      changed = true;
      if (isAbort(err)) error = 'The check was cancelled before it finished.';
      else if (err instanceof SyncStopped) error = err.message;
      else error = `The check stopped because of an unexpected error: ${(err as Error).message}`;
    }
    // A source removed (or pointed at another folder) while it was being read leaves nothing behind.
    const now = this.settings.library.sources.find((s) => s.id === sourceId);
    if (!now || (now.kind === 'folder' && source.kind === 'folder' && now.path !== source.path)) {
      await this.dropSources(new Set([sourceId]), new Set(now ? [sourceId] : []));
      await this.cleanOrphanTexts();
      return;
    }
    const state = this.sourceState[sourceId] ?? { lastSyncedAt: null, error: null, path: null };
    this.sourceState[sourceId] = {
      lastSyncedAt: completed ? new Date().toISOString() : state.lastSyncedAt,
      error,
      path: source.kind === 'folder' ? source.path : null,
    };
    if (changed || this.records.size !== sizeBefore) {
      await this.cleanOrphanTexts();
      await this.rebuildIndex();
      await this.updateMirror().catch((err: unknown) => console.error('[library] The browse mirror could not be updated:', err));
    }
    await this.persist();
  }

  /** Text files without a manifest entry (left by a crash or a removed source). */
  private async cleanOrphanTexts(): Promise<void> {
    const ids = await this.store.storedTextIds();
    for (const id of ids) if (!this.records.has(id)) await this.store.deleteParts(id);
    try {
      for (const name of await fs.readdir(this.store.textDir)) {
        if (name.endsWith('.tmp')) await fs.rm(path.join(this.store.textDir, name), { force: true });
      }
    } catch {
      // Nothing to clean.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Status

  private async sourceReady(source: LibrarySource, fresh = false): Promise<{ ready: boolean; detail: string }> {
    if (source.kind === 'notion') {
      const token = await this.secrets.notionToken();
      if (!token) return { ready: false, detail: 'Connect Notion in Settings → Library to read your pages.' };
      const cached = this.notionCache?.status;
      if (cached && !cached.connected && cached.error) return { ready: false, detail: cached.error };
      return { ready: true, detail: '' };
    }
    const problem = folderPathProblem(source.path, this.options.dataDir);
    if (problem) return { ready: false, detail: problem };
    const cached = this.readyCache.get(source.id);
    const now = Date.now();
    if (!fresh && cached && cached.key === source.path && now - cached.at < READY_CACHE_MS) return cached;
    const check = await checkFolderReady(source.path, 1_000);
    this.readyCache.set(source.id, { at: now, key: source.path, ...check });
    return check;
  }

  async status(): Promise<LibraryStatus> {
    const settings = this.settings;
    const enabled = new Set(enabledSourceIds(settings));
    const sources: LibrarySourceStatus[] = await Promise.all(
      settings.library.sources.map(async (source) => {
        const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<DocumentStatus, number>;
        let chars = 0;
        for (const r of this.records.values()) {
          if (r.sourceId !== source.id) continue;
          counts[r.status]++;
          if (r.status === 'ok') chars += r.chars;
        }
        const ready = await this.sourceReady(source);
        const state = this.sourceState[source.id];
        return {
          source,
          ready: ready.ready,
          readyDetail: ready.detail,
          counts,
          chars,
          lastSyncedAt: state?.lastSyncedAt ?? null,
          sync: this.queue.state(source.id, state?.error ?? null),
        };
      }),
    );
    let documents = 0;
    for (const r of this.records.values()) if (r.status === 'ok' && enabled.has(r.sourceId)) documents++;
    return { sources, documents, supportedTypes: [...SUPPORTED_TYPES] };
  }

  // ---------------------------------------------------------------------------------------------
  // Documents

  private visibleRecord(id: string): DocRecord | null {
    const r = this.records.get(id);
    if (!r) return null;
    return this.settings.library.sources.some((s) => s.id === r.sourceId) ? r : null;
  }

  document(id: string): LibraryDocument | null {
    const r = this.visibleRecord(id);
    return r ? publicDocument(r) : null;
  }

  /** The record behind a document, for the reveal endpoint (folder sources only). */
  filePath(id: string): string {
    const r = this.visibleRecord(id);
    if (!r) throw new LibraryError(404, 'There is no document with this id.');
    const source = this.settings.library.sources.find((s) => s.id === r.sourceId);
    if (!source || source.kind !== 'folder') {
      throw new LibraryError(400, 'Only documents from folders on this computer can be shown in the file manager.');
    }
    return path.join(source.path, ...r.key.split('/'));
  }

  documents(query: { sourceId?: string; status?: string; q?: string; offset?: number; limit?: number }): LibraryDocumentsResponse {
    const statuses = query.status
      ? query.status
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    for (const s of statuses) {
      if (!STATUSES.includes(s as DocumentStatus)) {
        throw new LibraryError(400, `Unknown status "${s}". Use one or more of: ${STATUSES.join(', ')}.`);
      }
    }
    const words = fold(query.q ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const known = new Set(this.settings.library.sources.map((s) => s.id));
    const matches = [...this.records.values()].filter((r) => {
      if (!known.has(r.sourceId)) return false;
      if (query.sourceId && r.sourceId !== query.sourceId) return false;
      if (statuses.length > 0 && !statuses.includes(r.status)) return false;
      if (words.length > 0) {
        const hay = fold(`${r.title} ${r.location}`);
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    matches.sort((a, b) => {
      const ta = a.title.toLowerCase();
      const tb = b.title.toLowerCase();
      if (ta !== tb) return ta < tb ? -1 : 1;
      if (a.location !== b.location) return a.location < b.location ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return { total: matches.length, documents: matches.slice(offset, offset + limit).map(publicDocument) };
  }

  async documentText(id: string): Promise<LibraryDocumentText> {
    if (!DOC_ID_RE.test(id)) throw new LibraryError(404, 'There is no document with this id.');
    const r = this.visibleRecord(id);
    if (!r) throw new LibraryError(404, 'There is no document with this id.');
    if (r.status !== 'ok') return { document: publicDocument(r), text: '', truncated: false };
    const parts = await this.store.readParts(id);
    if (!parts) throw new LibraryError(409, 'The text of this document is missing. Check its source for changes to read it again.');
    const text = renderParts(parts);
    return {
      document: publicDocument(r),
      text: text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text,
      truncated: text.length > TEXT_LIMIT,
    };
  }

  readParts(id: string): Promise<Part[] | null> {
    if (!DOC_ID_RE.test(id)) return Promise.resolve(null);
    return this.store.readParts(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Search and browse (used by turns)

  searchableCount(sourceIds: string[]): number {
    const ids = new Set(sourceIds);
    let n = 0;
    for (const r of this.records.values()) if (r.status === 'ok' && ids.has(r.sourceId)) n++;
    return n;
  }

  /** Waits for the first index build (bounded), then searches the index as it stands. */
  async search(
    queries: string[],
    opts: { budgetChars: number; sourceIds: string[]; signal?: AbortSignal },
  ): Promise<FoundPassage[]> {
    await within(
      this.indexBuilt,
      INDEX_WAIT_MS,
      opts.signal,
      'The library is still being prepared after the server started; try again in a minute.',
    );
    return searchIndex(this.index, queries, opts, (id) => this.store.readParts(id));
  }

  async prepareBrowse(signal?: AbortSignal): Promise<{ dir: string; documents: number }> {
    const { documents } = await this.updateMirror(signal);
    return { dir: this.mirror.dir, documents };
  }

  // ---------------------------------------------------------------------------------------------
  // Notion

  private async notionClient(token?: string): Promise<NotionClient | null> {
    const t = token ?? (await this.secrets.notionToken());
    if (!t) return null;
    return new NotionClient({ token: t, fetch: this.options.notionFetch, sleep: this.options.notionSleep });
  }

  private async checkToken(token: string): Promise<NotionStatus> {
    const client = (await this.notionClient(token))!;
    try {
      const me = await client.me();
      const bot = me.bot && typeof me.bot === 'object' ? (me.bot as Record<string, unknown>) : null;
      return {
        connected: true,
        workspace: typeof bot?.workspace_name === 'string' ? bot.workspace_name : '',
        identity: typeof me.name === 'string' ? me.name : '',
        error: null,
      };
    } catch (err) {
      return { connected: false, workspace: '', identity: '', error: (err as Error).message };
    }
  }

  /** GET /library/notion: the stored token, checked with Notion at most once a minute. */
  async notionStatus(refresh = false): Promise<NotionStatus> {
    const token = await this.secrets.notionToken();
    if (!token) return { connected: false, workspace: '', identity: '', error: null };
    if (!refresh && this.notionCache && Date.now() - this.notionCache.at < NOTION_CACHE_MS) return this.notionCache.status;
    if (!this.notionCheck) {
      this.notionCheck = this.checkToken(token)
        .then((status) => {
          this.notionCache = { at: Date.now(), status };
          return status;
        })
        .finally(() => {
          this.notionCheck = null;
        });
    }
    return this.notionCheck;
  }

  /** Checks the token with Notion, then stores it and makes sure there is a Notion source. */
  async connectNotion(token: string): Promise<NotionStatus> {
    const status = await this.checkToken(token);
    if (!status.connected) throw new LibraryError(400, status.error ?? TOKEN_REJECTED);
    await this.secrets.setNotionToken(token);
    this.notionCache = { at: Date.now(), status };
    const settings = this.settings;
    const existing = settings.library.sources.find((s) => s.kind === 'notion');
    if (!existing) {
      const next = structuredClone(settings);
      next.library.sources.push({ id: randomUUID(), kind: 'notion', name: uniqueName(settings, 'Notion'), enabled: true });
      const saved = await this.options.saveSettings(next);
      await this.reconcile(saved, settings);
    } else if (existing.enabled) {
      this.queue.request(existing.id);
    }
    return status;
  }

  async disconnectNotion(): Promise<void> {
    await this.secrets.setNotionToken(null);
    this.notionCache = null;
    const notion = this.settings.library.sources.find((s) => s.kind === 'notion');
    if (notion) await this.queue.cancel(notion.id);
  }

  private async requireClient(): Promise<NotionClient> {
    const client = await this.notionClient();
    if (!client) throw new LibraryError(400, 'Connect Notion in Settings → Library first.');
    return client;
  }

  async notionPages(query: string): Promise<NotionPageRef[]> {
    const client = await this.requireClient();
    try {
      const res = await client.search({ query, filter: { property: 'object', value: 'page' }, page_size: 20 });
      const out: NotionPageRef[] = [];
      for (const r of Array.isArray(res.results) ? res.results : []) {
        const page = readPage(r);
        if (!page) continue;
        out.push({ id: page.id, title: pageTitle(page.properties), url: page.url ?? '' });
      }
      return out;
    } catch (err) {
      throw notionHttpError(err);
    }
  }

  async saveToNotion(conversation: Conversation, turn: Turn, includeDeliberation: boolean): Promise<{ url: string; title: string }> {
    const parent = this.settings.library.notionSaveParent;
    if (!parent) throw new LibraryError(400, 'Choose a Notion page to save under first.');
    const client = await this.requireClient();
    try {
      return await saveTurnToNotion(client, parent.id, conversation, turn, includeDeliberation);
    } catch (err) {
      throw notionHttpError(err);
    }
  }
}

/** Notion's answer to a request the user made: their input (400) or Notion's side (502). */
function notionHttpError(err: unknown): Error {
  if (err instanceof NotionError) {
    const theirs = err.status === 0 || err.status === 429 || err.status >= 500;
    return new LibraryError(theirs ? 502 : 400, err.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function uniqueName(settings: Settings, base: string): string {
  const taken = new Set(settings.library.sources.map((s) => s.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}
