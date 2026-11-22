import { promises as fs } from 'node:fs';
import mammoth from 'mammoth';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { extractText, getDocumentProxy } from 'unpdf';
import WordExtractor from 'word-extractor';
import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import type { ExtractResult, Part } from '../types';
import { BinaryDataError, decodeText } from './decode';
import { finishParts, oneLine } from './normalize';
import { DamagedOfficeFileError, extractPptx } from './pptx';
import { rtfToText } from './rtf';

// Without the code page tables, legacy .xls files with non-ASCII text decode incorrectly.
XLSX.set_cptable(cptable);

export const SCAN_DETAIL = 'This PDF has no text layer; it is probably a scan.';
export const PASSWORD_PDF_DETAIL = 'This PDF is password-protected.';
export const DAMAGED_OFFICE_DETAIL = 'The file is damaged or password-protected.';
export const NOT_TEXT_DETAIL = 'This file does not contain text; it looks like binary data.';

const TEXT_TYPES = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'text', 'log']);
const ZIP_TYPES = new Set(['docx', 'pptx', 'xlsx', 'xlsm']);

const EMPTY_DETAIL: Record<string, string> = {
  docx: 'This document has no text.',
  doc: 'This document has no text.',
  pptx: 'This presentation has no text on its slides.',
  xlsx: 'This spreadsheet has no cells with values.',
  xlsm: 'This spreadsheet has no cells with values.',
  xls: 'This spreadsheet has no cells with values.',
  html: 'This page has no text.',
  htm: 'This page has no text.',
  rtf: 'This document has no text.',
};

function emptyDetail(type: string): string {
  return EMPTY_DETAIL[type] ?? 'This file is empty.';
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function pdfParts(bytes: Uint8Array): Promise<Part[]> {
  // unpdf needs a plain Uint8Array (not a Buffer); verbosity 0 keeps pdf.js warnings quiet.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => ({ label: `p. ${i + 1}`, text: t }));
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

const htmlConverter = new NodeHtmlMarkdown({ ignore: ['nav', 'footer', 'script', 'style', 'noscript'] });
const docxConverter = new NodeHtmlMarkdown();
const IMAGE_PLACEHOLDER = 'about:image';
const IMAGE_RE = /!\[([^\]]*)\]\(about:image\)/g;

async function docxText(bytes: Uint8Array): Promise<string> {
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    {
      // Images would otherwise be embedded as base64 data in the text; mammoth adds their alt text.
      convertImage: mammoth.images.imgElement(async () => ({ src: IMAGE_PLACEHOLDER })),
    },
  );
  return docxConverter
    .translate(result.value)
    .replace(IMAGE_RE, (_, alt: string) => (alt.trim() ? `[Image: ${alt.trim()}]` : ''));
}

async function docText(bytes: Uint8Array): Promise<string> {
  const doc = await new WordExtractor().extract(Buffer.from(bytes));
  const sections = [doc.getBody()];
  const footnotes = doc.getFootnotes().trim();
  const endnotes = doc.getEndnotes().trim();
  if (footnotes) sections.push(`Footnotes:\n${footnotes}`);
  if (endnotes) sections.push(`Endnotes:\n${endnotes}`);
  return sections.join('\n\n');
}

function sheetParts(bytes: Uint8Array): Part[] {
  const wb = XLSX.read(bytes, { type: 'buffer', cellDates: true });
  const parts: Part[] = [];
  wb.SheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name];
    if (!ws) return;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, blankrows: false });
    const lines = rows
      .map((row) =>
        (Array.isArray(row) ? row : [])
          .map((cell) => (cell === null || cell === undefined ? '' : String(cell).replace(/\s*\n\s*/g, ' ')))
          .join(' | ')
          .replace(/(?: \| )+$/, ''),
      )
      .filter((line) => line.replace(/[\s|]/g, '') !== '');
    if (lines.length === 0) return;
    const hidden = (wb.Workbook?.Sheets?.[i]?.Hidden ?? 0) > 0;
    parts.push({ label: `sheet ${name}${hidden ? ' (hidden)' : ''}`, text: lines.join('\n') });
  });
  return parts;
}

function decoded(bytes: Uint8Array): string {
  return decodeText(bytes).text;
}

/** Text of one file, read from bytes already in memory. Never throws. */
export async function extractBytes(bytes: Uint8Array, type: string): Promise<ExtractResult> {
  try {
    if (ZIP_TYPES.has(type) && !isZip(bytes)) return { status: 'error', detail: DAMAGED_OFFICE_DETAIL };
    switch (type) {
      case 'pdf': {
        const parts = await pdfParts(bytes);
        const visible = parts.reduce((n, p) => n + p.text.replace(/\s+/g, '').length, 0);
        if (visible < 20) return { status: 'empty', detail: SCAN_DETAIL };
        return finishParts(parts, SCAN_DETAIL);
      }
      case 'docx':
        return finishParts([{ label: '', text: await docxText(bytes) }], emptyDetail(type));
      case 'doc':
        return finishParts([{ label: '', text: await docText(bytes) }], emptyDetail(type));
      case 'pptx':
        return finishParts(extractPptx(bytes), emptyDetail(type));
      case 'xlsx':
      case 'xlsm':
      case 'xls': {
        const parts = sheetParts(bytes);
        if (parts.length === 0) return { status: 'empty', detail: emptyDetail(type) };
        return finishParts(parts, emptyDetail(type));
      }
      case 'html':
      case 'htm':
        return finishParts([{ label: '', text: htmlConverter.translate(decoded(bytes)) }], emptyDetail(type));
      case 'rtf':
        return finishParts([{ label: '', text: rtfToText(Buffer.from(bytes).toString('latin1')) }], emptyDetail(type));
      default:
        if (TEXT_TYPES.has(type)) return finishParts([{ label: '', text: decoded(bytes) }], emptyDetail(type));
        return { status: 'unsupported', detail: 'Files of this type are not read.' };
    }
  } catch (err) {
    return describeFailure(err, type);
  }
}

export function describeFailure(err: unknown, type: string): ExtractResult {
  const e = err instanceof Error ? err : new Error(String(err));
  if (e.name === 'PasswordException') return { status: 'error', detail: PASSWORD_PDF_DETAIL };
  if (e instanceof BinaryDataError) return { status: 'unsupported', detail: NOT_TEXT_DETAIL };
  if (e instanceof DamagedOfficeFileError) return { status: 'error', detail: DAMAGED_OFFICE_DETAIL };
  if (ZIP_TYPES.has(type) && /zip|central directory/i.test(e.message)) {
    return { status: 'error', detail: DAMAGED_OFFICE_DETAIL };
  }
  return { status: 'error', detail: `The file could not be read: ${oneLine(e.message)}` };
}

/** Reads and extracts one file. Never throws. */
export async function extractFile(file: string, type: string): Promise<ExtractResult> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(file);
  } catch (err) {
    return describeFailure(err, type);
  }
  return extractBytes(bytes, type);
}
