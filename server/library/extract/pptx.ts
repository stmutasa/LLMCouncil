import { strFromU8, unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { Part } from '../types';

const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (_, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? '';
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  });
}

/** Paragraphs of a DrawingML part, in document order: `<a:p>` with its `<a:t>` runs, breaks and tabs. */
export function drawingParagraphs(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)) {
    let line = '';
    for (const t of m[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>|<a:tab\s*\/>/g)) {
      if (t[0].startsWith('<a:br')) line += '\n';
      else if (t[0].startsWith('<a:tab')) line += '\t';
      else line += decodeEntities(t[1] ?? '');
    }
    if (line.trim()) out.push(line);
  }
  return out;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function list<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

type Rel = Record<string, unknown>;

function relationships(xml: string | undefined): Rel[] {
  if (!xml) return [];
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = doc.Relationships as Record<string, unknown> | undefined;
  return list(root?.Relationship as Rel | Rel[] | undefined);
}

/** Resolves a relationship target against the directory of the part that declares it. */
function resolvePart(baseDir: string, target: string): string {
  const raw = target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`;
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

export class DamagedOfficeFileError extends Error {
  constructor() {
    super('The file is damaged or password-protected.');
    this.name = 'DamagedOfficeFileError';
  }
}

const PART_RE =
  /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(_rels\/)?slide\d+\.xml(\.rels)?|notesSlides\/notesSlide\d+\.xml)$/;

/**
 * One part per slide, in presentation order (`p:sldIdLst` resolved through the presentation's
 * relationships; file names are not a reliable order). Speaker notes follow as "Notes: …".
 */
export function extractPptx(bytes: Uint8Array): Part[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => PART_RE.test(f.name) });
  } catch {
    throw new DamagedOfficeFileError();
  }
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : undefined);
  const presentation = text('ppt/presentation.xml');
  if (!presentation) throw new DamagedOfficeFileError();

  const rels = new Map<string, string>();
  for (const r of relationships(text('ppt/_rels/presentation.xml.rels'))) {
    if (typeof r['@_Id'] === 'string' && typeof r['@_Target'] === 'string') rels.set(r['@_Id'], r['@_Target']);
  }
  const doc = parser.parse(presentation) as Record<string, Record<string, Record<string, unknown>> | undefined>;
  const ids = list(doc['p:presentation']?.['p:sldIdLst']?.['p:sldId'] as Rel | Rel[] | undefined)
    .map((s) => s['@_r:id'])
    .filter((id): id is string => typeof id === 'string');

  const parts: Part[] = [];
  ids.forEach((id, i) => {
    const target = rels.get(id);
    const slidePart = target ? resolvePart('ppt', target) : '';
    const slideXml = slidePart ? text(slidePart) : undefined;
    const body = slideXml ? drawingParagraphs(slideXml).join('\n') : '';
    let notes = '';
    const slideRels = slidePart.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels';
    const notesRel = relationships(text(slideRels)).find(
      (r) => typeof r['@_Type'] === 'string' && /\/notesSlide$/.test(r['@_Type']),
    );
    if (notesRel && typeof notesRel['@_Target'] === 'string') {
      const notesXml = text(resolvePart('ppt/slides', notesRel['@_Target']));
      // The notes page repeats the slide number in a placeholder; it is not part of the notes.
      if (notesXml) notes = drawingParagraphs(notesXml).filter((p) => !/^\d+$/.test(p.trim())).join('\n');
    }
    parts.push({ label: `slide ${i + 1}`, text: notes ? `${body}\n\nNotes: ${notes}` : body });
  });
  return parts;
}
