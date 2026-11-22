import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readFileIfExists, writeFileAtomic } from '../util/fileQueue';
import { partNoun, renderParts, where } from './render';
import type { LibraryStore } from './store';
import type { DocRecord, Part } from './types';

export const INDEX_FILE = 'INDEX.md';
const MAX_SEGMENT = 120;
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * One path segment that is valid on Windows, macOS and Linux: no reserved characters or control
 * characters, no trailing dots or spaces, not a reserved device name, not hidden, at most
 * `max` characters.
 */
export function safeSegment(name: string, max = MAX_SEGMENT): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim();
  s = s.replace(/^\.+/, (dots) => '_'.repeat(dots.length));
  if (s.length > max) {
    let end = max;
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    s = s.slice(0, end);
  }
  s = s.replace(/[. ]+$/, '');
  if (s === '') s = '_';
  const base = s.split('.')[0]!;
  if (RESERVED.test(base)) s = `${base}_${s.slice(base.length)}`;
  return s;
}

/** Adds "-2", "-3"… before the extension until the name is unused (case-insensitively). */
function unique(name: string, used: Set<string>, ext: string): string {
  let candidate = name + ext;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = `-${n}`;
    candidate = name.slice(0, MAX_SEGMENT - ext.length - suffix.length) + suffix + ext;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export interface MirrorSource {
  id: string;
  name: string;
  kind: 'folder' | 'notion';
}

export interface MirrorEntry {
  path: string;
  record: DocRecord;
  source: MirrorSource;
}

/**
 * Where each document goes in the mirror. Documents are laid out in a fixed order (sources in
 * the given order, then by key), so collisions always resolve the same way.
 */
export function layoutMirror(sources: MirrorSource[], records: DocRecord[]): MirrorEntry[] {
  const usedTop = new Set<string>([INDEX_FILE.toLowerCase()]);
  const used = new Map<string, Set<string>>();
  const usedIn = (dir: string) => {
    let set = used.get(dir.toLowerCase());
    if (!set) {
      set = new Set();
      used.set(dir.toLowerCase(), set);
    }
    return set;
  };
  const out: MirrorEntry[] = [];
  for (const source of sources) {
    const top = unique(safeSegment(source.name, MAX_SEGMENT), usedTop, '');
    const docs = records
      .filter((r) => r.sourceId === source.id)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    // Directory names are mapped once per original directory, so all its files stay together.
    const dirMap = new Map<string, string>();
    const mapDir = (rel: string): string => {
      if (rel === '') return top;
      const known = dirMap.get(rel);
      if (known) return known;
      const slash = rel.lastIndexOf('/');
      const parent = mapDir(slash < 0 ? '' : rel.slice(0, slash));
      const mapped = `${parent}/${unique(safeSegment(rel.slice(slash + 1)), usedIn(parent), '')}`;
      dirMap.set(rel, mapped);
      return mapped;
    };
    for (const record of docs) {
      let rel: string;
      if (source.kind === 'folder') {
        const slash = record.key.lastIndexOf('/');
        const dir = mapDir(slash < 0 ? '' : record.key.slice(0, slash));
        const name = safeSegment(record.key.slice(slash + 1), MAX_SEGMENT - 3);
        rel = `${dir}/${unique(name, usedIn(dir), '.md')}`;
      } else {
        const id8 = record.key.replace(/-/g, '').slice(0, 8);
        const name = `${safeSegment(record.title.replace(/\s+/g, ' '), MAX_SEGMENT - 12)}-${id8}`;
        rel = `${top}/${unique(name, usedIn(top), '.md')}`;
      }
      out.push({ path: rel, record, source });
    }
  }
  return out;
}

function dateOnly(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0] ?? iso;
}

export function mirrorFileContent(entry: MirrorEntry, parts: Part[] | null): string {
  const r = entry.record;
  const head = [`# ${r.title}`, `Source: ${where(entry.source.name, r.location)}`, `Modified: ${dateOnly(r.modifiedAt)}`];
  const body = parts
    ? renderParts(parts)
    : 'The extracted text of this document is missing. Ask the user to check the library for changes again.';
  return `${head.join('\n')}\n\n${body}\n`;
}

export function indexContent(entries: MirrorEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = sorted.map((e) => {
    const r = e.record;
    const bits = [e.source.name];
    if (r.parts > 0) bits.push(partNoun(r.type, r.parts));
    bits.push(`${r.chars.toLocaleString('en-US')} characters`);
    return `- ${e.path} — ${r.title} (${bits.join(', ')})`;
  });
  const n = entries.length;
  return (
    `# Document library\n\n${n.toLocaleString('en-US')} document${n === 1 ? '' : 's'}. Each file holds the text extracted from one of the user's documents.\n\n` +
    (lines.length ? `${lines.join('\n')}\n` : '')
  );
}

function fingerprint(entry: MirrorEntry): string {
  const r = entry.record;
  return createHash('sha1')
    .update(
      JSON.stringify([r.id, r.title, r.location, r.modifiedAt, r.chars, r.parts, r.extractorVersion, r.size, r.mtimeMs, entry.source.name]),
    )
    .digest('hex');
}

interface FileState {
  fp: string;
  size: number;
  mtimeMs: number;
}

interface Actual {
  files: Map<string, { size: number; mtimeMs: number }>;
  /** Anything else: symbolic links, devices, directories nobody expects. */
  others: string[];
  dirs: string[];
}

async function walk(root: string): Promise<Actual> {
  const actual: Actual = { files: new Map(), others: [], dirs: [] };
  const visit = async (rel: string) => {
    let entries;
    try {
      entries = await fs.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        actual.dirs.push(child);
        await visit(child);
      } else if (e.isFile()) {
        try {
          const st = await fs.lstat(path.join(root, child));
          actual.files.set(child, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // Gone already.
        }
      } else {
        actual.others.push(child);
      }
    }
  };
  await visit('');
  return actual;
}

async function forceRemove(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    // Read-only entries (a CLI may have changed permissions): make them writable, then retry.
    await fs.chmod(target, 0o755).catch(() => undefined);
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Replaces a file with read-only content. The new file is written beside it and renamed over
 * it, so a CLI reading the mirror never finds the file missing.
 */
async function writeReadOnly(file: string, content: string): Promise<{ size: number; mtimeMs: number }> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o444 });
    // The mode given at creation is reduced by the umask; set it explicitly. On Windows this
    // sets the read-only attribute.
    await fs.chmod(tmp, 0o444);
    // Windows refuses to rename over a read-only file; POSIX does not mind either way.
    await fs.chmod(file, 0o644).catch(() => undefined);
    try {
      await fs.rename(tmp, file);
    } catch {
      // Something other than a file stands in the way (a CLI made a directory there).
      await forceRemove(file);
      await fs.rename(tmp, file);
    }
  } catch (err) {
    await forceRemove(tmp);
    throw err;
  }
  const st = await fs.lstat(file);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

/**
 * The generated, read-only text copy of the library that browse-mode CLIs open. Each update
 * compares what is on disk with what should be there (by size and modification time, so files
 * a CLI altered are noticed) and rewrites only the differences.
 */
export class BrowseMirror {
  private state = new Map<string, FileState>();
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: LibraryStore) {}

  get dir(): string {
    return this.store.browseDir;
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFileIfExists(this.store.mirrorStateFile);
      if (!raw) return;
      const value = JSON.parse(raw) as { files?: Record<string, FileState> };
      for (const [rel, s] of Object.entries(value.files ?? {})) {
        if (s && typeof s.fp === 'string' && typeof s.size === 'number' && typeof s.mtimeMs === 'number') {
          this.state.set(rel, s);
        }
      }
    } catch {
      // A lost state file only means every file is written again.
      this.state.clear();
    }
  }

  private async saveState(): Promise<void> {
    const files: Record<string, FileState> = {};
    for (const [rel, s] of this.state) files[rel] = s;
    await writeFileAtomic(this.store.mirrorStateFile, JSON.stringify({ version: 1, files }));
  }

  /**
   * Brings the mirror in line with the given documents. Returns the number of documents in it
   * and how many files had to be written or removed.
   */
  update(
    sources: MirrorSource[],
    records: DocRecord[],
    loadParts: (id: string) => Promise<Part[] | null>,
    signal?: AbortSignal,
  ): Promise<{ documents: number; written: number; removed: number }> {
    const run = this.chain.then(() => this.updateNow(sources, records, loadParts, signal));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async updateNow(
    sources: MirrorSource[],
    records: DocRecord[],
    loadParts: (id: string) => Promise<Part[] | null>,
    signal?: AbortSignal,
  ): Promise<{ documents: number; written: number; removed: number }> {
    await this.loadState();
    const root = this.store.browseDir;
    await fs.mkdir(root, { recursive: true });
    const entries = layoutMirror(sources, records);
    const expected = new Map<string, { fp: string; content: () => Promise<string> }>();
    const index = indexContent(entries);
    expected.set(INDEX_FILE, {
      fp: createHash('sha1').update(index).digest('hex'),
      content: async () => index,
    });
    for (const e of entries) {
      expected.set(e.path, {
        fp: fingerprint(e),
        content: async () => mirrorFileContent(e, await loadParts(e.record.id)),
      });
    }

    const actual = await walk(root);
    let written = 0;
    let removed = 0;
    // Removals first: an unexpected file may stand where a directory has to be created.
    for (const rel of actual.files.keys()) {
      if (expected.has(rel)) continue;
      await forceRemove(path.join(root, ...rel.split('/')));
      removed++;
    }
    for (const rel of actual.others) {
      await forceRemove(path.join(root, ...rel.split('/')));
      removed++;
    }
    const neededDirs = new Set<string>();
    for (const rel of expected.keys()) {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) neededDirs.add(parts.slice(0, i).join('/'));
    }
    // Deepest first, so a parent is only removed after its children.
    for (const rel of [...actual.dirs].sort((a, b) => b.length - a.length)) {
      if (neededDirs.has(rel)) continue;
      await forceRemove(path.join(root, ...rel.split('/')));
      removed++;
    }

    for (const [rel, want] of expected) {
      if (signal?.aborted) throw new Error('The mirror update was cancelled.');
      const known = this.state.get(rel);
      const onDisk = actual.files.get(rel);
      if (known && onDisk && known.fp === want.fp && known.size === onDisk.size && known.mtimeMs === onDisk.mtimeMs) {
        continue;
      }
      const stat = await writeReadOnly(path.join(root, ...rel.split('/')), await want.content());
      this.state.set(rel, { fp: want.fp, ...stat });
      written++;
    }
    for (const rel of [...this.state.keys()]) if (!expected.has(rel)) this.state.delete(rel);
    if (written > 0 || removed > 0) await this.saveState();
    return { documents: entries.length, written, removed };
  }
}
