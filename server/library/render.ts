import type { Part } from './types';

/** "p. 4" → "Page 4", "slide 3" → "Slide 3", "sheet Budget" → "Sheet Budget". */
export function partHeading(label: string): string {
  const page = /^p\.\s*(.+)$/.exec(label);
  if (page) return `Page ${page[1]}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * A document's text with a `## Page 4` style heading before each labelled part, as the browse
 * mirror, attachments and the text viewer show it.
 */
export function renderParts(parts: Part[]): string {
  return parts
    .map((p) => (p.label ? `## ${partHeading(p.label)}\n\n${p.text}` : p.text))
    .filter((s) => s.trim() !== '')
    .join('\n\n');
}

/** What a document's parts are called, for "3 pages" style counts. */
export function partNoun(type: string, count: number): string {
  const one = type === 'pptx' ? 'slide' : type === 'xlsx' || type === 'xlsm' || type === 'xls' ? 'sheet' : 'page';
  return `${count.toLocaleString('en-US')} ${one}${count === 1 ? '' : 's'}`;
}

/** Joins the non-empty pieces with " · ". */
export function where(...pieces: string[]): string {
  return pieces.filter((p) => p.trim() !== '').join(' · ');
}

/**
 * Cuts text to at most `max` characters at the last paragraph boundary (or, failing that, line
 * break, then space) within the limit. Returns '' when nothing sensible fits.
 */
export function cutAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  const room = text.slice(0, max);
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = room.lastIndexOf(sep);
    // A boundary in the first quarter would throw away most of what fits.
    if (at > max / 4) return room.slice(0, at).trimEnd();
  }
  return '';
}
