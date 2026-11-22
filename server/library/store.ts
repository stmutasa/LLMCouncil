import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readFileIfExists, withFileLock, writeFileAtomic } from '../util/fileQueue';
import type { DocRecord, Manifest, Part, SourceSyncRecord } from './types';

export const DOC_ID_RE = /^[0-9a-f]{20}$/;

/** Stable id of a document: its source plus its path in the folder (or its Notion page id). */
export function docIdFor(sourceId: string, key: string): string {
  return createHash('sha256').update(`${sourceId}\0${key}`).digest('hex').slice(0, 20);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const STATUSES = new Set(['ok', 'empty', 'unsupported', 'stub', 'too-large', 'error']);

/** Accepts a stored record only when every field has the right type; anything else is dropped. */
function readRecord(value: unknown): DocRecord | null {
  if (!isObject(value)) return null;
  const s = (k: string) => (typeof value[k] === 'string' ? (value[k] as string) : null);
  const n = (k: string) => (typeof value[k] === 'number' && Number.isFinite(value[k]) ? (value[k] as number) : null);
  const id = s('id');
  const sourceId = s('sourceId');
  const key = s('key');
  const status = s('status');
  if (!id || !DOC_ID_RE.test(id) || !sourceId || key === null || !status || !STATUSES.has(status)) return null;
  const url = value.url === null ? null : s('url');
  return {
    id,
    sourceId,
    key,
    title: s('title') ?? key,
    location: s('location') ?? '',
    type: s('type') ?? '',
    status: status as DocRecord['status'],
    detail: s('detail') ?? '',
    chars: n('chars') ?? 0,
    parts: n('parts') ?? 0,
    modifiedAt: s('modifiedAt') ?? '',
    url,
    size: n('size') ?? 0,
    mtimeMs: n('mtimeMs') ?? 0,
    extractorVersion: n('extractorVersion') ?? 0,
  };
}

export function emptyManifest(): Manifest {
  return { version: 1, documents: [], sources: {} };
}

/** Parses a manifest file; null when it is not one. Malformed records are skipped one by one. */
export function parseManifest(raw: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || !Array.isArray(value.documents)) return null;
  const documents: DocRecord[] = [];
  const seen = new Set<string>();
  for (const item of value.documents) {
    const r = readRecord(item);
    if (r && !seen.has(r.id)) {
      seen.add(r.id);
      documents.push(r);
    }
  }
  const sources: Record<string, SourceSyncRecord> = {};
  if (isObject(value.sources)) {
    for (const [id, v] of Object.entries(value.sources)) {
      if (!isObject(v)) continue;
      sources[id] = {
        lastSyncedAt: typeof v.lastSyncedAt === 'string' ? v.lastSyncedAt : null,
        error: typeof v.error === 'string' ? v.error : null,
        path: typeof v.path === 'string' ? v.path : null,
      };
    }
  }
  return { version: 1, documents, sources };
}

function parseParts(raw: string): Part[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value) || !Array.isArray(value.parts)) return null;
    const parts: Part[] = [];
    for (const p of value.parts) {
      if (!isObject(p) || typeof p.label !== 'string' || typeof p.text !== 'string') return null;
      parts.push({ label: p.label, text: p.text });
    }
    return parts;
  } catch {
    return null;
  }
}

/** Files under <data>/library: the manifest and one text file per document. */
export class LibraryStore {
  readonly root: string;
  readonly manifestFile: string;
  readonly textDir: string;
  readonly browseDir: string;
  readonly mirrorStateFile: string;

  constructor(readonly dataDir: string) {
    this.root = path.join(dataDir, 'library');
    this.manifestFile = path.join(this.root, 'manifest.json');
    this.textDir = path.join(this.root, 'text');
    this.browseDir = path.join(this.root, 'browse');
    this.mirrorStateFile = path.join(this.root, 'mirror-state.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.textDir, { recursive: true });
    await fs.mkdir(this.browseDir, { recursive: true });
  }

  /** A missing or unusable manifest starts the library empty; it is reported once, never thrown. */
  async loadManifest(): Promise<Manifest> {
    let raw: string | null;
    try {
      raw = await withFileLock(this.manifestFile, () => readFileIfExists(this.manifestFile));
    } catch (err) {
      console.warn(`[library] The manifest could not be read (${(err as Error).message}); starting with an empty library.`);
      return emptyManifest();
    }
    if (raw === null) return emptyManifest();
    const manifest = parseManifest(raw);
    if (!manifest) {
      console.warn(`[library] ${this.manifestFile} is not a valid manifest; starting with an empty library.`);
      return emptyManifest();
    }
    return manifest;
  }

  async saveManifest(manifest: Manifest): Promise<void> {
    const content = JSON.stringify(manifest);
    await withFileLock(this.manifestFile, () => writeFileAtomic(this.manifestFile, content));
  }

  textFile(id: string): string {
    if (!DOC_ID_RE.test(id)) throw new Error('Invalid document id.');
    return path.join(this.textDir, `${id}.json`);
  }

  async writeParts(id: string, parts: Part[]): Promise<void> {
    const file = this.textFile(id);
    await withFileLock(file, () => writeFileAtomic(file, JSON.stringify({ parts })));
  }

  /** null when the text file is missing or unreadable. */
  async readParts(id: string): Promise<Part[] | null> {
    const file = this.textFile(id);
    try {
      const raw = await withFileLock(file, () => readFileIfExists(file));
      return raw === null ? null : parseParts(raw);
    } catch {
      return null;
    }
  }

  async deleteParts(id: string): Promise<void> {
    const file = this.textFile(id);
    await withFileLock(file, () => fs.rm(file, { force: true })).catch(() => undefined);
  }

  /** Ids of the text files on disk. */
  async storedTextIds(): Promise<Set<string>> {
    try {
      const names = await fs.readdir(this.textDir);
      return new Set(
        names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => DOC_ID_RE.test(id)),
      );
    } catch {
      return new Set();
    }
  }
}
