import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyWithoutReading, MAX_FILE_BYTES, PPT_DETAIL, STUB_DETAIL, UNSUPPORTED_DETAIL, type ExtractResult } from '../types';
import { BinaryDataError, decodeText } from './decode';
import { DAMAGED_OFFICE_DETAIL, extractBytes, extractFile, NOT_TEXT_DETAIL, PASSWORD_PDF_DETAIL, SCAN_DETAIL } from './formats';
import { CUT_DETAIL, finishParts, normalizeText, oneLine } from './normalize';
import { rtfToText } from './rtf';
import { readFileSync } from 'node:fs';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fx = (name: string) => path.join(FIXTURES, name);
const SAMPLE = 'Héllo wörld – café naïve “quotes” €5\nLine two: Zürich';

function ok(r: ExtractResult) {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}: ${r.detail}`);
  return r;
}

describe('extraction of every supported format', () => {
  it('reads a PDF page by page', async () => {
    const r = ok(await extractFile(fx('report.pdf'), 'pdf'));
    expect(r.parts.map((p) => p.label)).toEqual(['p. 1', 'p. 2', 'p. 3']);
    expect(r.parts[0]!.text.startsWith('Chapter 1: Quarterly Findings\nThis is page 1.')).toBe(true);
    expect(r.parts[0]!.text).toContain('Revenue grew by 7 percent.');
    expect(r.parts[1]!.text).toContain('Revenue grew by 14 percent.');
    expect(r.parts[2]!.text).toContain('Revenue grew by 21 percent.');
    expect(r.detail).toBe('');
  });

  it('reports a scanned PDF as empty, a locked one as password-protected and a broken one as an error', async () => {
    expect(await extractFile(fx('scan.pdf'), 'pdf')).toEqual({ status: 'empty', detail: SCAN_DETAIL });
    expect(await extractFile(fx('locked.pdf'), 'pdf')).toEqual({ status: 'error', detail: PASSWORD_PDF_DETAIL });
    expect(await extractFile(fx('broken.pdf'), 'pdf')).toEqual({
      status: 'error',
      detail: 'The file could not be read: Invalid PDF structure.',
    });
  });

  it('reads DOCX as Markdown, keeping headings, lists and tables', async () => {
    const r = ok(await extractFile(fx('report.docx'), 'docx'));
    expect(r.parts).toEqual([
      {
        label: '',
        text: '# Annual Report\n\nIntro with **bold** and _italic_ text. Café Zürich 日本語.\n\n## Methods\n\n* First bullet\n* Second bullet\n\n| Name  | Score |\n| ----- | ----- |\n| Alice | 90    |\n\nConclusion text here.',
      },
    ]);
  });

  it('reports a damaged DOCX (and an Office file that is not a zip) as damaged or password-protected', async () => {
    expect(await extractFile(fx('broken.docx'), 'docx')).toEqual({ status: 'error', detail: DAMAGED_OFFICE_DETAIL });
    expect(await extractBytes(new TextEncoder().encode('not a zip at all'), 'xlsx')).toEqual({
      status: 'error',
      detail: DAMAGED_OFFICE_DETAIL,
    });
    expect(await extractBytes(new TextEncoder().encode('PK\u0003\u0004garbage'), 'pptx')).toEqual({
      status: 'error',
      detail: DAMAGED_OFFICE_DETAIL,
    });
  });

  it('reads a legacy .doc', async () => {
    const r = ok(await extractFile(fx('memo.doc'), 'doc'));
    expect(r.parts[0]!.text).toBe(
      'Annual Report\nIntro with bold and italic text. Café Zürich 日本語.\nMethods\nFirst bullet\nSecond bullet\nName\tScore\nAlice\t90\nConclusion text here.',
    );
  });

  it('reads PPTX slides in presentation order, with speaker notes', async () => {
    const r = ok(await extractFile(fx('deck.pptx'), 'pptx'));
    expect(r.parts).toHaveLength(11);
    expect(r.parts[0]).toEqual({
      label: 'slide 1',
      text: 'Title Slide: Roadmap\nBullet one\nBullet two\n\nNotes: Speaker note for slide one: mention budget.',
    });
    expect(r.parts[1]).toEqual({ label: 'slide 2', text: 'Slide Two: Metrics\nQ1\nQ2\n10\n20\n\nNotes: Notes two.' });
    expect(r.parts[2]).toEqual({ label: 'slide 3', text: 'Slide Three: Wrap-up' });
    for (let n = 4; n <= 11; n++) expect(r.parts[n - 1]).toEqual({ label: `slide ${n}`, text: `Filler slide number ${n}` });
  });

  it('reads spreadsheets sheet by sheet, marking hidden sheets', async () => {
    const x = ok(await extractFile(fx('sales.xlsx'), 'xlsx'));
    expect(x.parts).toEqual([
      {
        label: 'sheet Sales',
        text: 'Region | Units | Price | Date | Total\nNorth | 10 | 2.5 | 1/15/26 | 25\nSouth | 7 | 3.25 | 2/1/26 | 22.75',
      },
      { label: 'sheet Notes', text: 'Comment\nCafé, with "quotes" and newline\nHyperlink' },
      { label: 'sheet Hidden (hidden)', text: 'hidden data' },
    ]);
    const xls = ok(await extractFile(fx('sales.xls'), 'xls'));
    expect(xls.parts.map((p) => p.label)).toEqual(['sheet Sales', 'sheet Notes', 'sheet Hidden (hidden)']);
    expect(xls.parts[0]!.text).toContain('North | 10 | 2.5 | 46037 | 25');
    expect(xls.parts[1]!.text).toContain('Café');
  });

  it('reads HTML without navigation and footers', async () => {
    const r = ok(await extractFile(fx('page.html'), 'html'));
    expect(r.parts[0]!.text).toBe(
      '# Main Heading\n\nParagraph with [a link](https://example.com) and **bold**.\n\n## Sub\n\n* One\n* Two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```\nconst x = 1;\n```',
    );
    expect(r.parts[0]!.text).not.toContain('Menu');
    expect(r.parts[0]!.text).not.toContain('Footer junk');
  });

  it('reads RTF, including \\u escapes', async () => {
    expect(ok(await extractFile(fx('letter.rtf'), 'rtf')).parts[0]!.text).toBe(
      'Heading\nHello world, café and € euro 日本.\nSecond paragraph.',
    );
    const u = ok(await extractFile(fx('unicode.rtf'), 'rtf')).parts[0]!.text;
    expect(u.startsWith('AéB')).toBe(true);
    expect(u.includes('😀E')).toBe(true);
  });

  it('rtfToText decodes double-byte code pages and skips destinations', () => {
    // Shift-JIS bytes for 日本 (93 fa 96 7b) after \ansicpg932.
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg932{\\fonttbl{\\f0 MS Gothic;}}\\'93\\'fa\\'96\\'7b\\par end}")).toBe('日本\nend');
    expect(rtfToText('{\\rtf1{\\*\\generator Word;}{\\info{\\title T}}Body\\tab x}')).toBe('Body\tx');
  });

  it('reads CSV and plain text as they are', async () => {
    expect(ok(await extractFile(fx('table.csv'), 'csv')).parts[0]!.text).toBe(
      'Name,City,Note\nAlice,Zürich,"has, comma"\nBob,Paris,"multi\nline"',
    );
    for (const f of ['utf8.txt', 'utf8bom.txt', 'utf16le.txt', 'utf16be.txt', 'utf16le-nobom.txt']) {
      expect(ok(await extractFile(fx(f), 'txt')).parts[0]!.text).toBe(SAMPLE);
    }
    expect(ok(await extractFile(fx('latin1.txt'), 'txt')).parts[0]!.text).toBe('Héllo wörld - café naïve Zürich');
    expect(ok(await extractFile(fx('cp1252.txt'), 'txt')).parts[0]!.text).toBe('Smart “quotes” € café');
  });

  it('treats binary data in a text file as unsupported', async () => {
    expect(await extractFile(fx('binary.bin'), 'txt')).toEqual({ status: 'unsupported', detail: NOT_TEXT_DETAIL });
  });

  it('reports a file that cannot be opened as an error', async () => {
    const r = await extractFile(fx('does-not-exist.pdf'), 'pdf');
    expect(r.status).toBe('error');
    expect(r.detail).toMatch(/^The file could not be read: ENOENT/);
  });
});

describe('decodeText', () => {
  it('recognises every encoding', () => {
    const cases: [string, string][] = [
      ['utf8.txt', 'utf-8'],
      ['utf8bom.txt', 'utf-8-bom'],
      ['utf16le.txt', 'utf-16le'],
      ['utf16be.txt', 'utf-16be'],
      ['utf16le-nobom.txt', 'utf-16le-nobom'],
      ['latin1.txt', 'windows-1252'],
      ['cp1252.txt', 'windows-1252'],
    ];
    for (const [file, encoding] of cases) expect(decodeText(readFileSync(fx(file))).encoding).toBe(encoding);
  });

  it('does not change the caller’s buffer when byte-swapping a Buffer slice', () => {
    const whole = readFileSync(fx('utf16be.txt'));
    const view = whole.subarray(0);
    const before = Buffer.from(whole);
    decodeText(view);
    expect(whole.equals(before)).toBe(true);
  });

  it('throws for binary data', () => {
    expect(() => decodeText(readFileSync(fx('binary.bin')))).toThrow(BinaryDataError);
  });
});

describe('normalisation', () => {
  it('applies NFC, line ends, control characters, blank lines and trailing spaces', () => {
    expect(normalizeText('Café\r\nline\u0000 two  \r\n\n\n\n\nend\u0007\t ')).toBe('Café\nline two\n\n\nend');
    expect(normalizeText('\n\n  a\tb  ')).toBe('  a\tb');
  });

  it('marks a document whose parts are all empty', () => {
    expect(finishParts([{ label: 'p. 1', text: ' \n ' }], 'nothing')).toEqual({ status: 'empty', detail: 'nothing' });
  });

  it('cuts a long document and says so, keeping status ok', () => {
    const r = finishParts(
      [
        { label: 'p. 1', text: 'a'.repeat(6) },
        { label: 'p. 2', text: 'b'.repeat(6) },
        { label: 'p. 3', text: 'c'.repeat(6) },
      ],
      'x',
      10,
    );
    expect(r).toEqual({
      status: 'ok',
      parts: [
        { label: 'p. 1', text: 'aaaaaa' },
        { label: 'p. 2', text: 'bbbb' },
      ],
      detail: CUT_DETAIL,
    });
    // A surrogate pair is never split by the cut.
    const emoji = finishParts([{ label: '', text: 'ab😀' }], 'x', 3);
    expect(emoji.status === 'ok' && emoji.parts[0]!.text).toBe('ab');
  });

  it('shortens library messages to one line', () => {
    expect(oneLine('a\n  b')).toBe('a b');
    expect(oneLine('x'.repeat(300))).toHaveLength(200);
  });
});

describe('files that are never read', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'council-ppt-'));
    await writeFile(path.join(dir, 'old.ppt'), 'not really a presentation');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('classifies link files, old PowerPoint, unknown types and oversized files', () => {
    expect(classifyWithoutReading('gdoc', 100)).toEqual({ status: 'stub', detail: STUB_DETAIL });
    expect(classifyWithoutReading('gsheet', 100)?.status).toBe('stub');
    expect(classifyWithoutReading('ppt', 100)).toEqual({ status: 'unsupported', detail: PPT_DETAIL });
    expect(classifyWithoutReading('exe', 100)).toEqual({ status: 'unsupported', detail: UNSUPPORTED_DETAIL });
    expect(classifyWithoutReading('', 100)?.status).toBe('unsupported');
    expect(classifyWithoutReading('pdf', MAX_FILE_BYTES + 1)?.status).toBe('too-large');
    expect(classifyWithoutReading('pdf', MAX_FILE_BYTES)).toBeNull();
  });

  it('never parses a .ppt even if asked to extract it', async () => {
    expect(await extractFile(path.join(dir, 'old.ppt'), 'ppt')).toEqual({
      status: 'unsupported',
      detail: 'Files of this type are not read.',
    });
  });
});
