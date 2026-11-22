import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowseMirror, indexContent, layoutMirror, safeSegment, type MirrorSource } from './browse';
import { LibraryStore } from './store';
import type { DocRecord, Part } from './types';

function rec(over: Partial<DocRecord> & { id: string; key: string; sourceId: string }): DocRecord {
  return {
    title: over.key.split('/').pop()!,
    location: over.key.includes('/') ? over.key.slice(0, over.key.lastIndexOf('/')) : '',
    type: 'pdf',
    status: 'ok',
    detail: '',
    chars: 100,
    parts: 0,
    modifiedAt: '2026-03-04T05:06:07.000Z',
    url: null,
    size: 1,
    mtimeMs: 1,
    extractorVersion: 1,
    ...over,
  };
}

describe('safe path segments', () => {
  it('replaces reserved characters, trims trailing dots and spaces, avoids device names and hidden names', () => {
    expect(safeSegment('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(safeSegment('tab\there\u0001')).toBe('tab_here_');
    expect(safeSegment('name. . ')).toBe('name');
    expect(safeSegment('CON')).toBe('CON_');
    expect(safeSegment('con.txt')).toBe('con_.txt');
    expect(safeSegment('LPT1.md')).toBe('LPT1_.md');
    expect(safeSegment('Console')).toBe('Console');
    expect(safeSegment('.env')).toBe('_env');
    expect(safeSegment('...')).toBe('___');
    expect(safeSegment('   ')).toBe('_');
    expect(safeSegment('x'.repeat(300))).toHaveLength(120);
    expect(safeSegment(`${'x'.repeat(119)}😀`)).toHaveLength(119);
  });
});

const sources: MirrorSource[] = [
  { id: 'f', name: 'My Docs', kind: 'folder' },
  { id: 'n', name: 'Notion', kind: 'notion' },
];

describe('mirror layout', () => {
  it('places folder documents by path and Notion pages by title and id', () => {
    const entries = layoutMirror(sources, [
      rec({ id: 'a'.repeat(20), sourceId: 'f', key: 'Reports/2025/q3.pdf' }),
      rec({ id: 'b'.repeat(20), sourceId: 'f', key: 'top.docx', type: 'docx' }),
      rec({ id: 'c'.repeat(20), sourceId: 'n', key: '1234abcd-0000-0000-0000-000000000000', title: 'Team: Plan?', type: 'notion' }),
    ]);
    expect(entries.map((e) => e.path)).toEqual([
      'My Docs/Reports/2025/q3.pdf.md',
      'My Docs/top.docx.md',
      'Notion/Team_ Plan_-1234abcd.md',
    ]);
  });

  it('disambiguates collisions, case-insensitively, the same way every time', () => {
    const records = [
      rec({ id: '1'.repeat(20), sourceId: 'f', key: 'a:b.pdf' }),
      rec({ id: '2'.repeat(20), sourceId: 'f', key: 'a_b.pdf' }),
      rec({ id: '3'.repeat(20), sourceId: 'f', key: 'A_B.pdf' }),
      rec({ id: '4'.repeat(20), sourceId: 'f', key: 'Dir/x.pdf' }),
      rec({ id: '5'.repeat(20), sourceId: 'f', key: 'dir/y.pdf' }),
      rec({ id: '6'.repeat(20), sourceId: 'f', key: `${'n'.repeat(200)}.pdf` }),
      rec({ id: '7'.repeat(20), sourceId: 'f', key: `${'n'.repeat(200)}.docx` }),
    ];
    const paths = layoutMirror([{ id: 'f', name: 'S', kind: 'folder' }], records).map((e) => e.path);
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(paths.length);
    expect(paths).toContain('S/A_B.pdf.md');
    expect(paths).toContain('S/a_b.pdf-2.md');
    expect(paths).toContain('S/a_b.pdf-3.md');
    expect(paths).toContain('S/Dir/x.pdf.md');
    expect(paths).toContain('S/dir-2/y.pdf.md');
    for (const p of paths) for (const seg of p.split('/')) expect(seg.length).toBeLessThanOrEqual(120);
    expect(layoutMirror([{ id: 'f', name: 'S', kind: 'folder' }], [...records].reverse()).map((e) => e.path).sort()).toEqual(
      [...paths].sort(),
    );
  });

  it('keeps source folders apart from INDEX.md and from each other', () => {
    const entries = layoutMirror(
      [
        { id: 'a', name: 'INDEX.md', kind: 'folder' },
        { id: 'b', name: 'X/Y', kind: 'folder' },
        { id: 'c', name: 'X_Y', kind: 'folder' },
      ],
      [
        rec({ id: '1'.repeat(20), sourceId: 'a', key: 'f.pdf' }),
        rec({ id: '2'.repeat(20), sourceId: 'b', key: 'f.pdf' }),
        rec({ id: '3'.repeat(20), sourceId: 'c', key: 'f.pdf' }),
      ],
    );
    expect(entries.map((e) => e.path)).toEqual(['INDEX.md-2/f.pdf.md', 'X_Y/f.pdf.md', 'X_Y-2/f.pdf.md']);
  });

  it('writes INDEX.md sorted by path, with part counts and sizes', () => {
    const entries = layoutMirror(sources, [
      rec({ id: 'a'.repeat(20), sourceId: 'f', key: 'z.pdf', parts: 3, chars: 1234 }),
      rec({ id: 'b'.repeat(20), sourceId: 'f', key: 'a.pptx', type: 'pptx', parts: 1, chars: 10 }),
      rec({ id: 'c'.repeat(20), sourceId: 'f', key: 'm.txt', type: 'txt', chars: 5 }),
    ]);
    expect(indexContent(entries)).toBe(
      "# Document library\n\n3 documents. Each file holds the text extracted from one of the user's documents.\n\n" +
        '- My Docs/a.pptx.md — a.pptx (My Docs, 1 slide, 10 characters)\n' +
        '- My Docs/m.txt.md — m.txt (My Docs, 5 characters)\n' +
        '- My Docs/z.pdf.md — z.pdf (My Docs, 3 pages, 1,234 characters)\n',
    );
  });
});

describe('BrowseMirror', () => {
  let dataDir: string;
  let store: LibraryStore;
  const parts = new Map<string, Part[]>();
  const load = async (id: string) => parts.get(id) ?? null;
  const records = [
    rec({ id: 'a'.repeat(20), sourceId: 'f', key: 'Sub/report.pdf', parts: 2 }),
    rec({ id: 'b'.repeat(20), sourceId: 'f', key: 'memo.txt', type: 'txt' }),
  ];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'council-mirror-'));
    store = new LibraryStore(dataDir);
    await store.init();
    parts.set('a'.repeat(20), [
      { label: 'p. 1', text: 'First page.' },
      { label: 'p. 2', text: 'Second page.' },
    ]);
    parts.set('b'.repeat(20), [{ label: '', text: 'Just a memo.' }]);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const listAll = async (dir: string, rel = ''): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await listAll(dir, child)));
      else out.push(child);
    }
    return out.sort();
  };

  it('writes read-only text files with a header and part headings', async () => {
    const mirror = new BrowseMirror(store);
    const res = await mirror.update([sources[0]!], records, load);
    expect(res).toMatchObject({ documents: 2, written: 3 });
    expect(await listAll(store.browseDir)).toEqual(['INDEX.md', 'My Docs/Sub/report.pdf.md', 'My Docs/memo.txt.md']);
    const report = await readFile(path.join(store.browseDir, 'My Docs/Sub/report.pdf.md'), 'utf8');
    expect(report).toBe(
      '# report.pdf\nSource: My Docs · Sub\nModified: 2026-03-04\n\n## Page 1\n\nFirst page.\n\n## Page 2\n\nSecond page.\n',
    );
    const memo = await readFile(path.join(store.browseDir, 'My Docs/memo.txt.md'), 'utf8');
    expect(memo).toBe('# memo.txt\nSource: My Docs\nModified: 2026-03-04\n\nJust a memo.\n');
    expect((await stat(path.join(store.browseDir, 'My Docs/memo.txt.md'))).mode & 0o777).toBe(0o444);
    // Nothing else lives in the mirror directory.
    expect(await readdir(store.browseDir)).toEqual(['INDEX.md', 'My Docs']);
  });

  it('rewrites only what changed and repairs anything a CLI altered', async () => {
    const mirror = new BrowseMirror(store);
    await mirror.update([sources[0]!], records, load);
    expect((await mirror.update([sources[0]!], records, load)).written).toBe(0);

    const memo = path.join(store.browseDir, 'My Docs/memo.txt.md');
    await chmod(memo, 0o644);
    await writeFile(memo, 'tampered with');
    await writeFile(path.join(store.browseDir, 'notes-from-cli.txt'), 'scratch');
    await mkdir(path.join(store.browseDir, 'My Docs', 'new-dir'), { recursive: true });
    await symlink('/etc/passwd', path.join(store.browseDir, 'escape'));
    await rm(path.join(store.browseDir, 'My Docs/Sub/report.pdf.md'), { force: true });

    const res = await mirror.update([sources[0]!], records, load);
    expect(res.written).toBe(2);
    expect(res.removed).toBe(3);
    expect(await readFile(memo, 'utf8')).toContain('Just a memo.');
    expect(await listAll(store.browseDir)).toEqual(['INDEX.md', 'My Docs/Sub/report.pdf.md', 'My Docs/memo.txt.md']);
  });

  it('replaces a directory that a CLI created where a document belongs', async () => {
    const mirror = new BrowseMirror(store);
    await mirror.update([sources[0]!], records, load);
    const memo = path.join(store.browseDir, 'My Docs/memo.txt.md');
    await rm(memo, { force: true });
    await mkdir(path.join(memo, 'inner'), { recursive: true });
    await mirror.update([sources[0]!], records, load);
    expect(await readFile(memo, 'utf8')).toContain('Just a memo.');
  });

  it('removes documents that leave the library, and survives a lost state file', async () => {
    const mirror = new BrowseMirror(store);
    await mirror.update([sources[0]!], records, load);
    await mirror.update([sources[0]!], [records[1]!], load);
    expect(await listAll(store.browseDir)).toEqual(['INDEX.md', 'My Docs/memo.txt.md']);
    await rm(store.mirrorStateFile, { force: true });
    const fresh = new BrowseMirror(store);
    const res = await fresh.update([sources[0]!], [records[1]!], load);
    expect(res.documents).toBe(1);
    expect(await readFile(path.join(store.browseDir, 'INDEX.md'), 'utf8')).toContain('1 document.');
  });

  it('keeps long non-ASCII names within 255 bytes and writes them', async () => {
    const title = '日本語のとても長いタイトル'.repeat(8);
    const notion = rec({ id: 'c'.repeat(20), sourceId: 'n', key: 'abcdef12-0000', title, type: 'notion' });
    const file = rec({ id: 'd'.repeat(20), sourceId: 'f', key: `${'é'.repeat(130)}/${'ü'.repeat(200)}.pdf` });
    parts.set('c'.repeat(20), [{ label: '', text: 'notion text' }]);
    parts.set('d'.repeat(20), [{ label: '', text: 'pdf text' }]);
    const mirror = new BrowseMirror(store);
    const res = await mirror.update(sources, [notion, file], load);
    expect(res.documents).toBe(2);
    for (const p of await listAll(store.browseDir)) {
      for (const seg of p.split('/')) expect(Buffer.byteLength(seg) + 14).toBeLessThanOrEqual(255);
    }
    expect(safeSegment('😀'.repeat(100)).length).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(safeSegment('😀'.repeat(100)))).toBeLessThanOrEqual(200);
  });

  it('leaves out a document that cannot be written and still writes the rest', async () => {
    const mirror = new BrowseMirror(store);
    const failing = async (id: string) => {
      if (id === 'a'.repeat(20)) throw new Error('ENAMETOOLONG: name too long');
      return load(id);
    };
    const res = await mirror.update([sources[0]!], records, failing);
    expect(res.documents).toBe(1);
    expect(await listAll(store.browseDir)).toEqual(['INDEX.md', 'My Docs/memo.txt.md']);
    const index = await readFile(path.join(store.browseDir, 'INDEX.md'), 'utf8');
    expect(index).toContain('1 document.');
    expect(index).not.toContain('report.pdf');
    // It is tried again next time.
    expect((await mirror.update([sources[0]!], records, load)).documents).toBe(2);
  });

  it('notes a document whose text is missing instead of failing', async () => {
    const mirror = new BrowseMirror(store);
    parts.delete('b'.repeat(20));
    await mirror.update([sources[0]!], records, load);
    expect(await readFile(path.join(store.browseDir, 'My Docs/memo.txt.md'), 'utf8')).toContain('text of this document is missing');
  });
});
