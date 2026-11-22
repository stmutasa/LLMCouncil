import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../shared/defaults';
import type { Settings } from '../../shared/types';
import type { Extractor } from './extract/extractor';
import { extractFile, LINK_OUTSIDE_DETAIL } from './extract/formats';
import { CUT_DETAIL } from './extract/normalize';
import { Library } from './library';
import type { FetchFn } from './notionClient';
import { docIdFor } from './store';
import { MAX_FILE_BYTES, STUB_DETAIL, type ExtractResult } from './types';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Reads files in-process and records which ones it was asked for. */
class CountingExtractor implements Extractor {
  calls: string[] = [];
  failing = new Set<string>();
  stops = 0;
  block: ((file: string) => Promise<void>) | null = null;
  async extract(file: string, type: string, signal?: AbortSignal, root?: string): Promise<ExtractResult> {
    this.calls.push(path.basename(file));
    if (this.block) await this.block(file);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (this.failing.has(path.basename(file))) return { status: 'error', detail: 'The file could not be read: simulated' };
    return extractFile(file, type, root);
  }
  stop() {
    this.stops++;
  }
}

let dataDir: string;
let docs: string;
let settings: Settings;
let extractor: CountingExtractor;
const libraries: Library[] = [];

function makeLibrary(opts: { notionFetch?: FetchFn } = {}): Library {
  const lib = new Library({
    dataDir,
    settings: () => structuredClone(settings),
    saveSettings: async (next) => {
      settings = structuredClone(next);
      return structuredClone(settings);
    },
    extractor,
    notionFetch: opts.notionFetch,
    notionSleep: async () => undefined,
    autoSync: false,
    cancelWaitMs: 300,
    browseDir: path.join(dataDir, 'test-cache', 'browse'),
  });
  libraries.push(lib);
  return lib;
}

async function idle(lib: Library): Promise<void> {
  for (let i = 0; i < 500 && lib.syncing; i++) await new Promise((r) => setTimeout(r, 10));
  expect(lib.syncing).toBe(false);
}

async function sync(lib: Library, sourceId = 'docs'): Promise<void> {
  await lib.requestSync(sourceId);
  await idle(lib);
}

async function status(lib: Library, sourceId = 'docs') {
  const s = (await lib.status()).sources.find((x) => x.source.id === sourceId)!;
  return s;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'council-lib-data-'));
  docs = await mkdtemp(path.join(os.tmpdir(), 'council-lib-docs-'));
  await mkdir(path.join(docs, 'Sub folder'), { recursive: true });
  for (const f of ['report.pdf', 'scan.pdf', 'locked.pdf', 'report.docx', 'deck.pptx', 'sales.xlsx', 'drive-doc.gdoc']) {
    await copyFile(path.join(FIXTURES, f), path.join(docs, f));
  }
  await copyFile(path.join(FIXTURES, 'utf8.txt'), path.join(docs, 'Sub folder', 'notes.txt'));
  await writeFile(path.join(docs, 'old deck.ppt'), 'tiny dummy');
  await writeFile(path.join(docs, 'program.exe'), 'MZ');
  await writeFile(path.join(docs, 'huge.pdf'), '');
  await truncate(path.join(docs, 'huge.pdf'), MAX_FILE_BYTES + 1);
  settings = defaultSettings(true);
  settings.library.sources = [{ id: 'docs', kind: 'folder', name: 'My documents', enabled: true, path: docs }];
  extractor = new CountingExtractor();
});

afterEach(async () => {
  for (const lib of libraries.splice(0)) await lib.shutdown();
  await rm(dataDir, { recursive: true, force: true });
  await rm(docs, { recursive: true, force: true });
});

describe('folder sync', () => {
  it('reads supported files, records the rest without reading them, and reports counts', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    expect(extractor.calls.sort()).toEqual(['deck.pptx', 'locked.pdf', 'notes.txt', 'report.docx', 'report.pdf', 'sales.xlsx', 'scan.pdf']);
    const s = await status(lib);
    expect(s.counts).toEqual({ ok: 5, empty: 1, unsupported: 2, stub: 1, 'too-large': 1, error: 1 });
    expect(s.lastSyncedAt).not.toBeNull();
    expect(s.sync).toEqual({ running: false, phase: 'idle', done: 0, total: 0, current: '', error: null });
    expect(s.ready).toBe(true);
    expect(extractor.stops).toBeGreaterThan(0);

    const stub = lib.documents({ status: 'stub' }).documents[0]!;
    expect(stub).toMatchObject({ title: 'drive-doc.gdoc', type: 'gdoc', detail: STUB_DETAIL, location: '' });
    const notes = lib.documents({ q: 'sub notes' }).documents;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: 'notes.txt', location: 'Sub folder', status: 'ok', parts: 0 });
    expect(notes[0]!.id).toBe(docIdFor('docs', 'Sub folder/notes.txt'));
    // Internal fields never leave the server.
    expect(Object.keys(notes[0]!).sort()).toEqual(['chars', 'detail', 'id', 'location', 'modifiedAt', 'parts', 'sourceId', 'status', 'title', 'type', 'url']);
    const pdf = lib.documents({ q: 'report.pdf' }).documents[0]!;
    expect(pdf.parts).toBe(3);
    expect(lib.documents({ status: 'too-large' }).documents[0]!.title).toBe('huge.pdf');
    expect(lib.documents({ status: 'unsupported' }).documents.map((d) => d.detail).sort()).toEqual([
      'Files of this type are not read.',
      'Old PowerPoint format; save it as .pptx to include it.',
    ]);
    expect((await lib.status()).documents).toBe(5);
  });

  it('is incremental: unchanged files are not read again; changed, new and failed ones are; deleted ones go', async () => {
    const lib = makeLibrary();
    await lib.init();
    extractor.failing.add('report.docx');
    await sync(lib);
    expect(lib.documents({ q: 'report.docx' }).documents[0]!.status).toBe('error');

    extractor.calls = [];
    extractor.failing.clear();
    await sync(lib);
    // Only the file that failed (and the locked PDF, which is an error too) is read again.
    expect(extractor.calls.sort()).toEqual(['locked.pdf', 'report.docx']);
    expect(lib.documents({ q: 'report.docx' }).documents[0]!.status).toBe('ok');

    extractor.calls = [];
    await writeFile(path.join(docs, 'Sub folder', 'notes.txt'), 'changed text about turbines');
    await utimes(path.join(docs, 'Sub folder', 'notes.txt'), new Date(), new Date(Date.now() + 5_000));
    await writeFile(path.join(docs, 'new.md'), '# New\n\nfresh');
    await rm(path.join(docs, 'scan.pdf'));
    await sync(lib);
    expect(extractor.calls.sort()).toEqual(['locked.pdf', 'new.md', 'notes.txt']);
    expect(lib.documents({ q: 'scan' }).total).toBe(0);
    const text = await lib.documentText(docIdFor('docs', 'Sub folder/notes.txt'));
    expect(text.text).toBe('changed text about turbines');
  });

  it('does not read a file that was replaced by a link to outside the folder after the scan', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'council-lib-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'outside secret contents');
      const lib = makeLibrary();
      await lib.init();
      const target = path.join(docs, 'Sub folder', 'notes.txt');
      extractor.block = async (file) => {
        if (file.endsWith('deck.pptx')) {
          // Swapped between the scan and the read.
          await rm(target);
          await symlink(path.join(outside, 'secret.txt'), target);
        }
      };
      await sync(lib);
      const doc = lib.document(docIdFor('docs', 'Sub folder/notes.txt'))!;
      expect(doc).toMatchObject({ status: 'error', detail: LINK_OUTSIDE_DETAIL });
      const texts = await readdir(path.join(dataDir, 'library', 'text'));
      for (const t of texts) expect(await readFile(path.join(dataDir, 'library', 'text', t), 'utf8')).not.toContain('outside secret');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('keeps the last good text when a changed file cannot be read this time, and tries again next time', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    const id = docIdFor('docs', 'Sub folder/notes.txt');
    const before = lib.document(id)!;
    await writeFile(path.join(docs, 'Sub folder', 'notes.txt'), 'new text that is half downloaded');
    await utimes(path.join(docs, 'Sub folder', 'notes.txt'), new Date(), new Date(Date.now() + 5_000));
    extractor.failing.add('notes.txt');
    await sync(lib);
    const stale = lib.document(id)!;
    expect(stale.status).toBe('ok');
    expect(stale.detail).toBe('The latest version could not be read (The file could not be read: simulated); the previous version is still used.');
    expect(stale.chars).toBe(before.chars);
    expect(stale.modifiedAt).toBe(before.modifiedAt);
    expect((await lib.documentText(id)).text).toContain('Héllo wörld');
    expect((await lib.search(['zurich'], { budgetChars: 5_000, sourceIds: ['docs'] })).some((f) => f.documentId === id)).toBe(true);

    extractor.calls = [];
    extractor.failing.clear();
    await sync(lib);
    expect(extractor.calls).toContain('notes.txt');
    expect(lib.document(id)!.detail).toBe('');
    expect((await lib.documentText(id)).text).toBe('new text that is half downloaded');
  });

  it('re-reads documents written by an older extractor version', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    await lib.shutdown();
    const manifestFile = path.join(dataDir, 'library', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    for (const d of manifest.documents) if (d.key === 'report.pdf') d.extractorVersion = 0;
    await writeFile(manifestFile, JSON.stringify(manifest));
    extractor.calls = [];
    const again = makeLibrary();
    await again.init();
    await sync(again);
    expect(extractor.calls.sort()).toEqual(['locked.pdf', 'report.pdf']);
  });

  it('keeps every document when the folder cannot be read (an unplugged drive)', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    const before = lib.documents({}).total;
    const away = `${docs}-away`;
    await rename(docs, away);
    try {
      await expect(lib.requestSync('docs')).rejects.toMatchObject({ status: 409 });
      const s = await status(lib);
      expect(s.ready).toBe(false);
      expect(s.readyDetail).toMatch(/does not exist/);
      expect(lib.documents({}).total).toBe(before);
    } finally {
      await rename(away, docs);
    }
  });

  it('treats a sub-folder that disappeared from the listing as deleted', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    const total = lib.documents({}).total;
    await rename(path.join(docs, 'Sub folder'), path.join(docs, '.hidden-now'));
    await sync(lib);
    // A sub-folder that disappeared from the listing is a real deletion.
    expect(lib.documents({}).total).toBe(total - 1);
  });

  it('deletes the documents, text files and mirror files of a removed source', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    await lib.prepareBrowse();
    expect((await readdir(path.join(dataDir, 'library', 'text'))).length).toBe(5);
    const previous = structuredClone(settings);
    settings.library.sources = [];
    await lib.reconcile(settings, previous);
    await lib.updateMirror();
    expect(lib.documents({}).total).toBe(0);
    expect(await readdir(path.join(dataDir, 'library', 'text'))).toEqual([]);
    expect(await readdir(path.join(dataDir, 'test-cache', 'browse'))).toEqual(['INDEX.md']);
    const manifest = JSON.parse(await readFile(path.join(dataDir, 'library', 'manifest.json'), 'utf8'));
    expect(manifest.documents).toEqual([]);
    expect(manifest.sources).toEqual({});
  });

  it('removes documents of sources that are gone from the settings at startup', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    await lib.shutdown();
    settings.library.sources = [];
    const again = makeLibrary();
    await again.init();
    expect(again.documents({}).total).toBe(0);
    expect(await readdir(path.join(dataDir, 'library', 'text'))).toEqual([]);
  });

  it('starts over when a source is pointed at another folder', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    const other = await mkdtemp(path.join(os.tmpdir(), 'council-lib-other-'));
    try {
      await writeFile(path.join(other, 'only.txt'), 'only file');
      const previous = structuredClone(settings);
      settings.library.sources[0] = { ...settings.library.sources[0]!, path: other } as Settings['library']['sources'][number];
      await lib.reconcile(settings, previous);
      await idle(lib);
      expect(lib.documents({}).documents.map((d) => d.title)).toEqual(['only.txt']);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('refuses a folder that leads to the data directory through a symbolic link', async () => {
    const link = path.join(docs, '..', `${path.basename(docs)}-link`);
    await symlink(path.dirname(dataDir), link);
    try {
      settings.library.sources = [{ id: 'docs', kind: 'folder', name: 'Linked', enabled: true, path: link }];
      const lib = makeLibrary();
      await lib.init();
      const s = await status(lib);
      expect(s.ready).toBe(false);
      expect(s.readyDetail).toMatch(/app's own data folder/);
      await expect(lib.requestSync('docs')).rejects.toMatchObject({ status: 409 });
    } finally {
      await rm(link, { force: true });
    }
  });

  it('follows a change of folder made while the first check of a new source is running', async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), 'council-lib-second-'));
    try {
      await writeFile(path.join(other, 'second.txt'), 'second folder');
      settings.library.sources = [];
      const lib = makeLibrary();
      await lib.init();
      let release: () => void = () => undefined;
      extractor.block = () =>
        new Promise<void>((resolve) => {
          release = resolve;
          extractor.block = null;
        });
      let previous = structuredClone(settings);
      settings.library.sources = [{ id: 'docs', kind: 'folder', name: 'New', enabled: true, path: docs }];
      await lib.reconcile(settings, previous);
      for (let i = 0; i < 200 && extractor.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(extractor.calls.length).toBe(1);
      previous = structuredClone(settings);
      settings.library.sources = [{ id: 'docs', kind: 'folder', name: 'New', enabled: true, path: other }];
      const applied = lib.reconcile(settings, previous);
      release();
      await applied;
      await idle(lib);
      expect(lib.documents({}).documents.map((d) => d.title)).toEqual(['second.txt']);
      expect((await status(lib)).lastSyncedAt).not.toBeNull();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('syncs a source when it is added or turned back on', async () => {
    settings.library.sources[0]!.enabled = false;
    const lib = makeLibrary();
    await lib.init();
    await expect(lib.requestSync('docs')).rejects.toMatchObject({ status: 409 });
    await expect(lib.requestSync('nope')).rejects.toMatchObject({ status: 404 });
    const previous = structuredClone(settings);
    settings.library.sources[0]!.enabled = true;
    await lib.reconcile(settings, previous);
    await idle(lib);
    expect(lib.documents({ status: 'ok' }).total).toBe(5);
  });

  it('can be cancelled promptly and keeps what was read', async () => {
    const lib = makeLibrary();
    await lib.init();
    let release: () => void = () => undefined;
    let reads = 0;
    extractor.block = (file) => {
      reads++;
      if (reads < 3) return Promise.resolve();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    await lib.requestSync('docs');
    for (let i = 0; i < 200 && reads < 3; i++) await new Promise((r) => setTimeout(r, 5));
    const running = await status(lib);
    expect(running.sync).toMatchObject({ running: true, phase: 'reading', done: 2 });
    expect(running.sync.current).not.toBe('');
    const cancelled = lib.cancelSync('docs');
    release();
    await cancelled;
    await idle(lib);
    const s = await status(lib);
    expect(s.sync.error).toBe('The check was cancelled before it finished.');
    expect(lib.documents({ status: 'ok,empty,error' }).total).toBe(2);
    expect(s.lastSyncedAt).toBeNull();
  });

  it('abandons a check stuck on the file system, so cancel and later checks are not blocked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lib = makeLibrary();
    await lib.init();
    let releaseStuck: () => void = () => undefined;
    extractor.block = () =>
      new Promise<void>((resolve) => {
        releaseStuck = resolve;
        extractor.block = null;
      });
    // The fake extractor ignores the abort signal, like a read blocked on a hung drive.
    extractor.extract = (async (file: string, type: string, _signal?: AbortSignal, root?: string) =>
      CountingExtractor.prototype.extract.call(extractor, file, type, undefined, root)) as CountingExtractor['extract'];
    await lib.requestSync('docs');
    for (let i = 0; i < 200 && extractor.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    await lib.cancelSync('docs');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(lib.syncing).toBe(false);
    await sync(lib);
    const after = lib.documents({}).total;
    expect(after).toBe(11);
    releaseStuck();
    await new Promise((r) => setTimeout(r, 50));
    expect(lib.documents({}).total).toBe(after);
    expect((await status(lib)).sync.error).toBeNull();
    vi.restoreAllMocks();
  });

  it('queues a second sync while one runs', async () => {
    settings.library.sources.push({ id: 'two', kind: 'folder', name: 'Two', enabled: true, path: path.join(docs, 'Sub folder') });
    const lib = makeLibrary();
    await lib.init();
    let release: () => void = () => undefined;
    extractor.block = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        extractor.block = null;
      });
    await lib.requestSync('docs');
    await lib.requestSync('two');
    expect((await status(lib, 'two')).sync.phase).toBe('queued');
    for (let i = 0; i < 100 && extractor.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    release();
    await idle(lib);
    expect((await status(lib, 'two')).counts.ok).toBe(1);
  });

  it('starts empty from a corrupt manifest and deletes text files nobody owns', async () => {
    await mkdir(path.join(dataDir, 'library', 'text'), { recursive: true });
    await writeFile(path.join(dataDir, 'library', 'manifest.json'), '{ not json');
    await writeFile(path.join(dataDir, 'library', 'text', `${'f'.repeat(20)}.json`), '{"parts":[]}');
    const lib = makeLibrary();
    await lib.init();
    expect(lib.documents({}).total).toBe(0);
    await sync(lib);
    const texts = await readdir(path.join(dataDir, 'library', 'text'));
    expect(texts).not.toContain(`${'f'.repeat(20)}.json`);
    expect(texts).toHaveLength(5);
  });

  it('keeps the library across a restart and searches it', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    await lib.shutdown();
    const again = makeLibrary();
    await again.init();
    expect(again.documents({ status: 'ok' }).total).toBe(5);
    const found = await again.search(['revenue grew 14 percent'], { budgetChars: 5_000, sourceIds: ['docs'] });
    expect(found[0]).toMatchObject({ documentId: docIdFor('docs', 'report.pdf'), part: 'p. 2' });
    expect(found[0]!.text).toContain('Revenue grew by 14 percent.');
  });

  it('lists documents with filters, paging and title order, and validates the status filter', async () => {
    const lib = makeLibrary();
    await lib.init();
    await sync(lib);
    const all = lib.documents({});
    expect(all.total).toBe(11);
    const titles = all.documents.map((d) => d.title.toLowerCase());
    expect(titles).toEqual([...titles].sort());
    expect(lib.documents({ offset: 2, limit: 3 }).documents.map((d) => d.title)).toEqual(all.documents.slice(2, 5).map((d) => d.title));
    expect(lib.documents({ status: 'stub,unsupported' }).total).toBe(3);
    expect(lib.documents({ sourceId: 'other' }).total).toBe(0);
    expect(() => lib.documents({ status: 'bogus' })).toThrow(/Unknown status/);
    const text = await lib.documentText(docIdFor('docs', 'deck.pptx'));
    expect(text.text.startsWith('## Slide 1\n\nTitle Slide: Roadmap')).toBe(true);
    expect(text.truncated).toBe(false);
    await expect(lib.documentText('0'.repeat(20))).rejects.toMatchObject({ status: 404 });
  });
});

describe('Notion sync', () => {
  function notionWorld() {
    const pages = new Map<string, { title: string; edited: string; markdown: string | Error; parent?: Record<string, unknown> }>();
    let failSearch = false;
    let markdownCalls: string[] = [];
    const fetch: FetchFn = async (url, init) => {
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/v1/users/me')) return json(200, { object: 'user', name: 'Council', type: 'bot', bot: { workspace_name: 'Acme' } });
      if (url.endsWith('/v1/search')) {
        const body = JSON.parse(String(init.body));
        if (body.filter.value === 'data_source') return failSearch ? json(500, { message: 'Internal' }) : json(200, { results: [], has_more: false });
        return json(200, {
          results: [...pages.entries()].map(([id, p]) => ({
            object: 'page',
            id,
            url: `https://notion.so/${id}`,
            last_edited_time: p.edited,
            parent: p.parent ?? { type: 'workspace', workspace: true },
            properties: { title: { type: 'title', title: [{ plain_text: p.title }] } },
          })),
          has_more: false,
        });
      }
      const m = /\/v1\/pages\/([^/]+)\/markdown/.exec(url);
      if (m) {
        markdownCalls.push(m[1]!);
        const p = pages.get(m[1]!);
        if (!p) return json(404, { message: 'Could not find page.' });
        if (p.markdown instanceof Error) return json(403, { message: p.markdown.message });
        return json(200, { markdown: p.markdown, truncated: false, unknown_block_ids: [] });
      }
      return json(404, { message: 'unknown endpoint' });
    };
    return {
      pages,
      fetch,
      calls: () => markdownCalls,
      reset: () => (markdownCalls = []),
      failEnumeration: (v: boolean) => (failSearch = v),
    };
  }

  it('reads new and changed pages only, records failures and removes pages that are gone', async () => {
    const world = notionWorld();
    world.pages.set('p1', { title: 'Roadmap', edited: '2026-01-01T00:00:00Z', markdown: '# Roadmap\n\nShip it.' });
    world.pages.set('p2', { title: 'Secret', edited: '2026-01-01T00:00:00Z', markdown: new Error('Insufficient permissions for this page.') });
    world.pages.set('p3', { title: 'Child', edited: '2026-01-01T00:00:00Z', markdown: 'kid', parent: { type: 'page_id', page_id: 'p1' } });
    settings.library.sources = [{ id: 'notion', kind: 'notion', name: 'Notion', enabled: true }];
    const lib = makeLibrary({ notionFetch: world.fetch });
    await lib.init();
    expect((await status(lib, 'notion')).ready).toBe(false);
    await lib.connectNotion('secret_abc');
    await idle(lib);
    expect(world.calls().sort()).toEqual(['p1', 'p2', 'p3']);
    const p1 = lib.document(docIdFor('notion', 'p1'))!;
    expect(p1).toMatchObject({ status: 'ok', type: 'notion', url: 'https://notion.so/p1', title: 'Roadmap', location: '' });
    expect(lib.document(docIdFor('notion', 'p3'))!.location).toBe('Roadmap');
    expect(lib.document(docIdFor('notion', 'p2'))).toMatchObject({ status: 'error', detail: 'Insufficient permissions for this page.' });

    world.reset();
    world.pages.get('p1')!.edited = '2026-02-01T00:00:00Z';
    world.pages.get('p1')!.markdown = '# Roadmap\n\nShip it later.';
    world.pages.get('p2')!.markdown = 'Now readable';
    await sync(lib, 'notion');
    // p3 is unchanged and not fetched again; p2 failed before and is retried.
    expect(world.calls().sort()).toEqual(['p1', 'p2']);
    expect((await lib.documentText(docIdFor('notion', 'p1'))).text).toBe('# Roadmap\n\nShip it later.');

    // An edited page that fails to load keeps its last good text.
    world.reset();
    world.pages.get('p1')!.edited = '2026-03-01T00:00:00Z';
    world.pages.get('p1')!.markdown = new Error('Service temporarily unavailable.');
    await sync(lib, 'notion');
    expect(lib.document(docIdFor('notion', 'p1'))).toMatchObject({
      status: 'ok',
      modifiedAt: '2026-02-01T00:00:00Z',
      detail: 'The latest version could not be read (Service temporarily unavailable); the previous version is still used.',
    });
    expect((await lib.documentText(docIdFor('notion', 'p1'))).text).toBe('# Roadmap\n\nShip it later.');
    world.pages.get('p1')!.markdown = '# Roadmap\n\nShipped.';
    await sync(lib, 'notion');
    expect((await lib.documentText(docIdFor('notion', 'p1'))).text).toBe('# Roadmap\n\nShipped.');

    world.reset();
    world.pages.delete('p3');
    world.failEnumeration(true);
    await sync(lib, 'notion');
    // The enumeration failed, so nothing is deleted.
    expect(lib.document(docIdFor('notion', 'p3'))).not.toBeNull();
    expect((await status(lib, 'notion')).sync.error).toMatch(/Notion did not list every page \(Internal\)/);

    world.failEnumeration(false);
    await sync(lib, 'notion');
    expect(lib.document(docIdFor('notion', 'p3'))).toBeNull();
    expect((await status(lib, 'notion')).sync.error).toBeNull();
  });

  it('caps a very long page before processing it', async () => {
    const world = notionWorld();
    world.pages.set('big', { title: 'Huge', edited: '2026-01-01T00:00:00Z', markdown: `${'a '.repeat(2_600_000)}tail` });
    settings.library.sources = [{ id: 'notion', kind: 'notion', name: 'Notion', enabled: true }];
    const lib = makeLibrary({ notionFetch: world.fetch });
    await lib.init();
    await lib.connectNotion('secret_abc');
    await idle(lib);
    const doc = lib.document(docIdFor('notion', 'big'))!;
    expect(doc.status).toBe('ok');
    expect(doc.chars).toBeLessThanOrEqual(5_000_000);
    expect(doc.detail).toBe(CUT_DETAIL);
  });

  it('adds a Notion source when a token is connected and never stores the token in settings', async () => {
    const world = notionWorld();
    const lib = makeLibrary({ notionFetch: world.fetch });
    await lib.init();
    const st = await lib.connectNotion('ntn_TOPSECRET');
    expect(st).toEqual({ connected: true, workspace: 'Acme', identity: 'Council', error: null });
    expect(settings.library.sources.filter((s) => s.kind === 'notion')).toHaveLength(1);
    expect(JSON.stringify(settings)).not.toContain('ntn_TOPSECRET');
    await idle(lib);
    await lib.disconnectNotion();
    expect(await lib.notionStatus()).toEqual({ connected: false, workspace: '', identity: '', error: null });
    expect(settings.library.sources.filter((s) => s.kind === 'notion')).toHaveLength(1);
  });
});
