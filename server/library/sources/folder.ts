import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { extensionOf, MAX_FILES_PER_SOURCE, MAX_FOLDER_DEPTH } from '../types';

export interface ScannedFile {
  /** Path relative to the folder, with '/' separators. */
  rel: string;
  name: string;
  /** Relative directory ('' at the top). */
  dir: string;
  type: string;
  size: number;
  mtimeMs: number;
}

export interface FolderScan {
  /** False when the folder itself could not be read; nothing may be deleted then. */
  readable: boolean;
  error: string | null;
  files: ScannedFile[];
  /** More than the file limit: the rest were not looked at. */
  truncated: boolean;
  /** Relative directories that could not be listed; files under them must not be deleted. */
  unreadableDirs: string[];
}

export const TOO_MANY_FILES = `This folder has more than ${MAX_FILES_PER_SOURCE.toLocaleString('en-US')} files; only the first ${MAX_FILES_PER_SOURCE.toLocaleString('en-US')} were read.`;

const SKIP_NAMES = new Set(['node_modules', '$recycle.bin', 'system volume information', 'thumbs.db', 'desktop.ini']);

/** Names a library scan never looks at: hidden files, system folders, Office lock files. */
export function isSkippedName(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('~$')) return true;
  if (name === 'Icon\r') return true;
  return SKIP_NAMES.has(name.toLowerCase());
}

function describeFsError(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  switch (e.code) {
    case 'ENOENT':
      return 'The folder does not exist. If it is on an external drive, connect the drive.';
    case 'EACCES':
    case 'EPERM':
      return 'The folder cannot be read: permission denied.';
    case 'ENOTDIR':
      return 'This path is a file, not a folder.';
    case 'ETIMEDOUT':
      return 'The folder did not respond. If it is on a network or external drive, check the connection.';
    default:
      return `The folder cannot be read: ${e.message}`;
  }
}

function timeoutError(): NodeJS.ErrnoException {
  const err = new Error('timed out') as NodeJS.ErrnoException;
  err.code = 'ETIMEDOUT';
  return err;
}

/** A filesystem call that gives up after `ms` (an unplugged network drive can block for minutes). */
export function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(timeoutError()), ms);
    t.unref?.();
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/** Whether the folder exists and can be listed; the reason when it cannot. */
export async function checkFolderReady(folder: string, timeoutMs = 2_000): Promise<{ ready: boolean; detail: string }> {
  try {
    const stat = await bounded(fs.stat(folder), timeoutMs);
    if (!stat.isDirectory()) return { ready: false, detail: describeFsError({ code: 'ENOTDIR' }) };
    const dir = await bounded(fs.opendir(folder), timeoutMs);
    await dir.close().catch(() => undefined);
    return { ready: true, detail: '' };
  } catch (err) {
    return { ready: false, detail: describeFsError(err) };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Lists the files under `root`, depth first in name order, without following symbolic links
 * and without reading any file. Never throws.
 */
export async function scanFolder(
  root: string,
  opts: {
    signal?: AbortSignal;
    maxFiles?: number;
    maxDepth?: number;
    /** Replaces directory listing (tests simulate folders that cannot be read). */
    readdir?: (dir: string) => Promise<Dirent[]>;
  } = {},
): Promise<FolderScan> {
  const readdir = opts.readdir ?? ((dir: string) => fs.readdir(dir, { withFileTypes: true }));
  const maxFiles = opts.maxFiles ?? MAX_FILES_PER_SOURCE;
  const maxDepth = opts.maxDepth ?? MAX_FOLDER_DEPTH;
  const scan: FolderScan = { readable: true, error: null, files: [], truncated: false, unreadableDirs: [] };
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return { ...scan, readable: false, error: describeFsError({ code: 'ENOTDIR' }) };
  } catch (err) {
    return { ...scan, readable: false, error: describeFsError(err) };
  }

  const walk = async (relDir: string, depth: number): Promise<void> => {
    if (scan.truncated || opts.signal?.aborted) return;
    let entries: Dirent[];
    try {
      entries = await readdir(relDir ? path.join(root, ...relDir.split('/')) : root);
    } catch (err) {
      if (relDir === '') {
        scan.readable = false;
        scan.error = describeFsError(err);
      } else {
        scan.unreadableDirs.push(relDir);
      }
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const files: Dirent[] = [];
    const dirs: Dirent[] = [];
    for (const e of entries) {
      if (isSkippedName(e.name) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) dirs.push(e);
      else if (e.isFile()) files.push(e);
      else if (!e.isFIFO() && !e.isSocket() && !e.isBlockDevice() && !e.isCharacterDevice()) {
        // Some file systems do not report entry types; ask for each such entry.
        try {
          const st = await fs.lstat(path.join(root, ...(relDir ? `${relDir}/${e.name}` : e.name).split('/')));
          if (st.isDirectory()) dirs.push(e);
          else if (st.isFile()) files.push(e);
        } catch {
          // Vanished between listing and checking.
        }
      }
    }
    const room = maxFiles - scan.files.length;
    if (files.length > room) {
      files.length = Math.max(0, room);
      scan.truncated = true;
    }
    const stats = await mapLimit(files, 16, async (e) => {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      try {
        const st = await fs.lstat(path.join(root, ...rel.split('/')));
        return st.isFile() ? { rel, e, size: st.size, mtimeMs: st.mtimeMs } : null;
      } catch {
        return { rel, e, size: 0, mtimeMs: 0 };
      }
    });
    for (const s of stats) {
      if (!s) continue;
      scan.files.push({
        rel: s.rel,
        name: s.e.name,
        dir: relDir,
        type: extensionOf(s.e.name),
        size: s.size,
        mtimeMs: s.mtimeMs,
      });
    }
    if (scan.truncated || depth >= maxDepth) return;
    for (const d of dirs) {
      await walk(relDir ? `${relDir}/${d.name}` : d.name, depth + 1);
      if (scan.truncated) return;
    }
  };
  await walk('', 0);
  return scan;
}

/** Case-insensitive file systems (the defaults on Windows and macOS). */
function sameFsPath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `inner` is `outer` or lies inside it. */
export function isWithin(inner: string, outer: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const a = p.resolve(inner);
  const b = p.resolve(outer);
  if (sameFsPath(a, b, platform)) return true;
  const prefix = b.endsWith(p.sep) ? b : b + p.sep;
  return sameFsPath(a.slice(0, prefix.length), prefix, platform);
}

/**
 * Why a folder cannot be a library source, or null when it can. A path that does not exist is
 * allowed: an external drive may simply be unplugged.
 */
export function folderPathProblem(
  folder: string,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (folder.trim() === '') return 'Choose a folder.';
  if (!p.isAbsolute(folder)) return `"${folder}" is not a full path. Use the complete path of the folder, starting from the drive or the top of the file system.`;
  const resolved = p.resolve(folder);
  if (p.parse(resolved).root === resolved || (platform === 'win32' && /^\\\\[^\\]+\\[^\\]+\\?$/.test(resolved))) {
    return `"${folder}" is the top of a drive. Choose a folder inside it, such as your Documents folder.`;
  }
  if (isWithin(dataDir, resolved, platform)) {
    return `"${folder}" contains the app's own data folder, so it cannot be a library source. Choose a folder that holds only your documents.`;
  }
  if (isWithin(resolved, dataDir, platform)) {
    return `"${folder}" is inside the app's own data folder, so it cannot be a library source.`;
  }
  return null;
}
