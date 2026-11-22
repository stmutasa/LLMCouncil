import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkFolderReady, folderPathProblem, isSkippedName, isWithin, scanFolder } from './folder';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'council-scan-'));
  const w = (rel: string, content = 'x') => writeFile(path.join(root, rel), content);
  await mkdir(path.join(root, 'sub', 'deep'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, '$RECYCLE.BIN'), { recursive: true });
  await w('a.pdf', 'pdf');
  await w('B.docx');
  await w('sub/c.txt', 'hello');
  await w('sub/deep/d.md');
  await w('node_modules/x.txt');
  await w('.git/config');
  await w('.hidden.txt');
  await w('~$lock.docx');
  await w('Thumbs.db');
  await w('desktop.ini');
  await w('Icon\r');
  await w('$RECYCLE.BIN/gone.txt');
  await w('noext');
  await symlink(path.join(root, 'a.pdf'), path.join(root, 'link.pdf'));
  await symlink(path.join(root, 'sub'), path.join(root, 'linkdir'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scanFolder', () => {
  it('lists files recursively with sizes, skipping hidden, system and lock files and symbolic links', async () => {
    const scan = await scanFolder(root);
    expect(scan.readable).toBe(true);
    expect(scan.truncated).toBe(false);
    expect(scan.files.map((f) => f.rel)).toEqual(['B.docx', 'a.pdf', 'noext', 'sub/c.txt', 'sub/deep/d.md']);
    const c = scan.files.find((f) => f.rel === 'sub/c.txt')!;
    expect(c).toMatchObject({ name: 'c.txt', dir: 'sub', type: 'txt', size: 5 });
    expect(c.mtimeMs).toBeGreaterThan(0);
    expect(scan.files.find((f) => f.rel === 'noext')!.type).toBe('');
  });

  it('applies the file and depth limits', async () => {
    const few = await scanFolder(root, { maxFiles: 2 });
    expect(few.truncated).toBe(true);
    expect(few.files).toHaveLength(2);
    const shallow = await scanFolder(root, { maxDepth: 1 });
    expect(shallow.files.map((f) => f.rel)).toEqual(['B.docx', 'a.pdf', 'noext', 'sub/c.txt']);
  });

  it('reports a missing folder as unreadable', async () => {
    const scan = await scanFolder(path.join(root, 'nope'));
    expect(scan.readable).toBe(false);
    expect(scan.error).toMatch(/does not exist/);
  });

  it('notes sub-folders that cannot be listed, and an unlistable top folder makes the scan unreadable', async () => {
    const denied = (which: string) => async (dir: string) => {
      if (dir === which) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return readdir(dir, { withFileTypes: true });
    };
    const scan = await scanFolder(root, { fs: { readdir: denied(path.join(root, 'sub')) } });
    expect(scan.readable).toBe(true);
    expect(scan.unreadableDirs).toEqual(['sub']);
    expect(scan.files.map((f) => f.rel)).toEqual(['B.docx', 'a.pdf', 'noext']);
    const top = await scanFolder(root, { fs: { readdir: denied(root) } });
    expect(top.readable).toBe(false);
    expect(top.error).toMatch(/permission denied/);
  });

  it('gives up on a call that never answers, and keeps what it could not check', async () => {
    const never = () => new Promise<never>(() => undefined);
    const hungDir = await scanFolder(root, {
      callTimeoutMs: 100,
      fs: { readdir: (dir) => (dir === path.join(root, 'sub') ? never() : readdir(dir, { withFileTypes: true })) },
    });
    expect(hungDir.readable).toBe(true);
    expect(hungDir.unreadableDirs).toEqual(['sub']);
    const hungStat = await scanFolder(root, { callTimeoutMs: 100, fs: { lstat: (f) => (f.endsWith('a.pdf') ? never() : lstat(f)) } });
    expect(hungStat.files.map((f) => f.rel)).not.toContain('a.pdf');
    expect(hungStat.unreadableDirs).toEqual(['a.pdf']);
    const hungRoot = await scanFolder(root, { callTimeoutMs: 100, fs: { stat: never } });
    expect(hungRoot.readable).toBe(false);
    expect(hungRoot.error).toMatch(/did not respond/);
  });

  it('stops promptly when cancelled, even while a call hangs', async () => {
    const ctl = new AbortController();
    const started = Date.now();
    const pending = scanFolder(root, { signal: ctl.signal, fs: { readdir: () => new Promise<never>(() => undefined) } });
    setTimeout(() => ctl.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('knows which names to skip', () => {
    for (const n of ['.DS_Store', '~$x.docx', 'node_modules', 'Thumbs.db', 'thumbs.db', 'DESKTOP.INI', 'Icon\r', 'System Volume Information']) {
      expect(isSkippedName(n)).toBe(true);
    }
    for (const n of ['report.pdf', 'Icon', 'a~$b']) expect(isSkippedName(n)).toBe(false);
  });
});

describe('folder readiness', () => {
  it('is ready for a folder and not for a file or a missing path', async () => {
    expect(await checkFolderReady(root)).toEqual({ ready: true, detail: '' });
    expect((await checkFolderReady(path.join(root, 'a.pdf'))).detail).toMatch(/file, not a folder/);
    expect((await checkFolderReady(path.join(root, 'missing'))).ready).toBe(false);
  });
});

describe('folder path rules', () => {
  const data = '/home/u/app/data';
  it('rejects relative paths, roots and the data directory around or inside', () => {
    expect(folderPathProblem('docs', data, 'linux')).toMatch(/not a full path/);
    expect(folderPathProblem('', data, 'linux')).toMatch(/Choose a folder/);
    expect(folderPathProblem('/', data, 'linux')).toMatch(/top of a drive/);
    expect(folderPathProblem('/home/u/app', data, 'linux')).toMatch(/contains the app's own data folder/);
    expect(folderPathProblem('/home/u/app/data', data, 'linux')).toMatch(/contains the app's own data folder/);
    expect(folderPathProblem('/home/u/app/data/library', data, 'linux')).toMatch(/inside the app's own data folder/);
    expect(folderPathProblem('/home/u/Documents', data, 'linux')).toBeNull();
    // A path that does not exist (an unplugged drive) is allowed.
    expect(folderPathProblem('/media/usb/Docs', data, 'linux')).toBeNull();
  });

  it('applies Windows rules on Windows', () => {
    const wdata = 'C:\\Users\\u\\council\\data';
    expect(folderPathProblem('C:\\', wdata, 'win32')).toMatch(/top of a drive/);
    expect(folderPathProblem('D:\\', wdata, 'win32')).toMatch(/top of a drive/);
    expect(folderPathProblem('\\\\server\\share', wdata, 'win32')).toMatch(/top of a drive/);
    expect(folderPathProblem('Docs', wdata, 'win32')).toMatch(/not a full path/);
    expect(folderPathProblem('c:\\users\\U', wdata, 'win32')).toMatch(/contains the app's own data folder/);
    expect(folderPathProblem('G:\\My Drive', wdata, 'win32')).toBeNull();
  });

  it('isWithin compares whole path segments', () => {
    expect(isWithin('/a/bc', '/a/b', 'linux')).toBe(false);
    expect(isWithin('/a/b/c', '/a/b', 'linux')).toBe(true);
    expect(isWithin('/A/B', '/a/b', 'darwin')).toBe(true);
    expect(isWithin('/A/B', '/a/b', 'linux')).toBe(false);
  });
});
