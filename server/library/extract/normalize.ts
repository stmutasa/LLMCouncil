import { MAX_DOCUMENT_CHARS, type ExtractResult, type Part } from '../types';

// Control characters other than tab and newline (carriage returns are converted before this).
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * NFC, \n line ends, no control characters, at most two blank lines in a row, no trailing
 * spaces. Every step is a single linear pass: a regex anchored at a line end backtracks over
 * each run of spaces once per position, which turns a file of long space runs into minutes.
 */
export function normalizeText(text: string): string {
  const lines = text.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').split('\n');
  const out: string[] = [];
  let blank = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === '') {
      // Leading blank lines are dropped; inside the text at most two in a row are kept.
      if (out.length === 0) continue;
      blank++;
      if (blank > 2) continue;
    } else {
      blank = 0;
    }
    out.push(line);
  }
  return out.join('\n').trimEnd();
}

/** The lines of a cell or property value joined by single spaces, in one linear pass. */
export function joinLines(value: string): string {
  return value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ');
}

export const CUT_DETAIL = `Only the first ${MAX_DOCUMENT_CHARS.toLocaleString('en-US')} characters were kept; the document is longer.`;

/**
 * Normalises every part and applies the per-document size cap. Parts that are empty after
 * normalisation keep their place (a blank page is still page 3), but a document whose parts are
 * all empty becomes `empty` with the given detail.
 */
export function finishParts(raw: Part[], emptyDetail: string, maxChars = MAX_DOCUMENT_CHARS): ExtractResult {
  const parts = raw.map((p) => ({ label: p.label, text: normalizeText(p.text) }));
  if (parts.every((p) => p.text === '')) return { status: 'empty', detail: emptyDetail };
  let remaining = maxChars;
  let cut = false;
  const kept: Part[] = [];
  for (const p of parts) {
    if (remaining <= 0) {
      cut = true;
      break;
    }
    if (p.text.length > remaining) {
      // Do not leave half a surrogate pair at the cut.
      let end = remaining;
      const code = p.text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
      kept.push({ label: p.label, text: p.text.slice(0, end) });
      remaining = 0;
      cut = true;
      continue;
    }
    kept.push(p);
    remaining -= p.text.length;
  }
  return { status: 'ok', parts: kept, detail: cut ? CUT_DETAIL : '' };
}

/** A library's error message as one short line. */
export function oneLine(message: string, max = 200): string {
  const line = message.replace(/\s+/g, ' ').trim() || 'unknown error';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
