import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderSource } from '../../shared/types';
import type { FolderScan, ScannedFile } from './sources/folder';
import { TOO_MANY_FILES } from './sources/folder';
import { docIdFor, LibraryStore } from './store';
import { idleState, syncFolder, type SyncContext } from './sync';
import { EXTRACTOR_VERSION, type DocRecord } from './types';

let dataDir: string;
let ctx: SyncContext;
let reads: string[];
const source: FolderSource = { id: 's', kind: 'folder', name: 'S', enabled: true, path: '/docs' };

function file(rel: string): ScannedFile {
  const slash = rel.lastIndexOf('/');
  return { rel, name: rel.slice(slash + 1), dir: slash < 0 ? '' : rel.slice(0, slash), type: 'txt', size: 3, mtimeMs: 1000 };
}

function record(rel: string): DocRecord {
  const f = file(rel);
  return {
    id: docIdFor('s', rel),
    sourceId: 's',
    key: rel,
    title: f.name,
    location: f.dir,
    type: 'txt',
    status: 'empty',
    detail: 'This file is empty.',
    chars: 0,
    parts: 0,
    modifiedAt: new Date(1000).toISOString(),
    url: null,
    size: 3,
    mtimeMs: 1000,
    extractorVersion: EXTRACTOR_VERSION,
  };
}

const scanOf = (over: Partial<FolderScan>) => async (): Promise<FolderScan> => ({
  readable: true,
  error: null,
  files: [],
  truncated: false,
  unreadableDirs: [],
  ...over,
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'council-sync-'));
  const store = new LibraryStore(dataDir);
  await store.init();
  reads = [];
  ctx = {
    store,
    records: new Map(),
    extractor: {
      extract: async (f) => {
        reads.push(f);
        return { status: 'empty', detail: 'This file is empty.' };
      },
      stop: () => undefined,
    },
    persist: async () => undefined,
    notionClient: async () => null,
    onNotionRejected: () => undefined,
  };
  for (const rel of ['a.txt', 'locked/b.txt', 'locked/deeper/c.txt', 'gone.txt']) ctx.records.set(docIdFor('s', rel), record(rel));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('syncFolder deletions', () => {
  it('keeps documents under sub-folders that could not be listed', async () => {
    const out = await syncFolder(ctx, source, new AbortController().signal, { state: idleState() }, scanOf({ files: [file('a.txt')], unreadableDirs: ['locked'] }));
    expect(out.changed).toBe(true);
    expect([...ctx.records.values()].map((r) => r.key).sort()).toEqual(['a.txt', 'locked/b.txt', 'locked/deeper/c.txt']);
    // Unchanged files are not read again.
    expect(reads).toEqual([]);
  });

  it('deletes nothing when the file limit cut the listing short, and says so', async () => {
    const out = await syncFolder(ctx, source, new AbortController().signal, { state: idleState() }, scanOf({ files: [file('a.txt')], truncated: true }));
    expect(out.warning).toBe(TOO_MANY_FILES);
    expect(ctx.records.size).toBe(4);
  });

  it('deletes nothing when the folder itself could not be read', async () => {
    await expect(
      syncFolder(ctx, source, new AbortController().signal, { state: idleState() }, scanOf({ readable: false, error: 'The folder does not exist.' })),
    ).rejects.toThrow('The folder does not exist.');
    expect(ctx.records.size).toBe(4);
  });

  it('re-reads a file whose size or modification time changed', async () => {
    const changed = { ...file('a.txt'), mtimeMs: 2000 };
    await syncFolder(ctx, source, new AbortController().signal, { state: idleState() }, scanOf({ files: [changed, { ...file('gone.txt'), size: 9 }] }));
    expect(reads.map((r) => path.basename(r)).sort()).toEqual(['a.txt', 'gone.txt']);
  });
});
