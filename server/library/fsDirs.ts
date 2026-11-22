import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirectoryListing } from '../../shared/types';
import { bounded } from './sources/folder';

const PROBE_MS = 500;
const LIST_MS = 5_000;
const HIDDEN_SYSTEM = new Set(['$recycle.bin', 'system volume information', '$windows.~bt', '$windows.~ws']);

export interface DirOptions {
  home?: string;
  platform?: NodeJS.Platform;
  probeMs?: number;
}

async function isDir(p: string, ms: number): Promise<boolean> {
  try {
    return (await bounded(fs.stat(p), ms)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Home, Desktop, Documents, Downloads and any Google Drive for Desktop folders that exist. Every
 * probe gives up after half a second, so a sleeping network drive cannot hold up the dialog.
 */
export async function folderShortcuts(opts: DirOptions = {}): Promise<{ label: string; path: string }[]> {
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const ms = opts.probeMs ?? PROBE_MS;
  const p = platform === 'win32' ? path.win32 : path.posix;

  const drive: { label: string; path: string }[] = [];
  if (platform === 'darwin') {
    const cloud = p.join(home, 'Library', 'CloudStorage');
    let names: string[] = [];
    try {
      names = await bounded(fs.readdir(cloud), ms);
    } catch {
      names = [];
    }
    for (const name of names.filter((n) => n.startsWith('GoogleDrive-')).sort()) {
      const account = name.slice('GoogleDrive-'.length);
      const base = p.join(cloud, name);
      for (const child of ['My Drive', 'Shared drives']) {
        const full = p.join(base, child);
        if (await isDir(full, ms)) drive.push({ label: `Google Drive (${account}) · ${child}`, path: full });
      }
      if (!drive.some((d) => d.path.startsWith(base)) && (await isDir(base, ms))) {
        drive.push({ label: `Google Drive (${account})`, path: base });
      }
    }
  }
  const candidates: { label: string; path: string }[] = [];
  if (platform === 'win32') {
    for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const letter = String.fromCharCode(c);
      candidates.push({ label: `Google Drive (${letter}:) · My Drive`, path: `${letter}:\\My Drive` });
    }
  }
  candidates.push({ label: 'Google Drive', path: p.join(home, 'Google Drive') });
  candidates.push({ label: 'Google Drive · My Drive', path: p.join(home, 'My Drive') });
  const found = await Promise.all(candidates.map(async (c) => ((await isDir(c.path, ms)) ? c : null)));
  for (const c of found) if (c && !drive.some((d) => d.path === c.path)) drive.push(c);

  const standard = [
    { label: 'Home', path: home },
    { label: 'Desktop', path: p.join(home, 'Desktop') },
    { label: 'Documents', path: p.join(home, 'Documents') },
    { label: 'Downloads', path: p.join(home, 'Downloads') },
  ];
  const present = await Promise.all(standard.map(async (s) => ((await isDir(s.path, ms)) ? s : null)));
  return [...drive, ...present.filter((s): s is { label: string; path: string } => s !== null)];
}

/**
 * The sub-folders of a directory. Only names are read: never a file's contents, and files are
 * not listed at all.
 */
export async function listDirectories(input: string | undefined, opts: DirOptions = {}): Promise<DirectoryListing> {
  const platform = opts.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const home = opts.home ?? os.homedir();
  const shortcuts = await folderShortcuts(opts);
  const raw = input === undefined || input.trim() === '' ? home : input.trim();
  if (!p.isAbsolute(raw)) {
    return { path: raw, parent: null, dirs: [], shortcuts, error: 'Enter a full path, starting from the top of a drive.' };
  }
  const dir = p.resolve(raw);
  const parentDir = p.dirname(dir);
  const parent = parentDir === dir ? null : parentDir;
  try {
    const entries = await bounded(fs.readdir(dir, { withFileTypes: true }), LIST_MS);
    const dirs: { name: string; path: string }[] = [];
    const linked: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || HIDDEN_SYSTEM.has(e.name.toLowerCase())) continue;
      if (e.isDirectory()) dirs.push({ name: e.name, path: p.join(dir, e.name) });
      else if (e.isSymbolicLink()) linked.push(e.name);
    }
    // A link to a folder is offered like a folder; a link to a file is not.
    const linkedDirs = await Promise.all(
      linked.map(async (name) => ((await isDir(p.join(dir, name), opts.probeMs ?? PROBE_MS)) ? name : null)),
    );
    for (const name of linkedDirs) if (name) dirs.push({ name, path: p.join(dir, name) });
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1));
    return { path: dir, parent, dirs, shortcuts, error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const error =
      code === 'ENOENT'
        ? 'This folder does not exist.'
        : code === 'ENOTDIR'
          ? 'This is a file, not a folder.'
          : code === 'EACCES' || code === 'EPERM'
            ? 'This folder cannot be opened: permission denied.'
            : code === 'ETIMEDOUT'
              ? 'This folder did not respond. If it is on a network or external drive, check the connection.'
              : `This folder cannot be opened: ${(err as Error).message}`;
    return { path: dir, parent, dirs: [], shortcuts, error };
  }
}

export type Spawner = (command: string, args: string[]) => void;

const defaultSpawner: Spawner = (command, args) => {
  const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: false });
  child.on('error', (err) => console.warn(`[library] Could not open the file manager: ${err.message}`));
  child.unref();
};

/** The command that shows a file in the system file manager. Never goes through a shell. */
export function revealCommand(file: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: ['-R', file] };
  if (platform === 'win32') return { command: 'explorer.exe', args: [`/select,${file}`] };
  return { command: 'xdg-open', args: [path.dirname(file)] };
}

export function revealFile(file: string, spawner: Spawner = defaultSpawner, platform: NodeJS.Platform = process.platform): void {
  const { command, args } = revealCommand(file, platform);
  spawner(command, args);
}
