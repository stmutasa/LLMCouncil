import type { Root } from 'mdast';
import type { TurnLibrary } from '../../../shared/types';
import { whereText } from './library';

/**
 * Citations of the user's documents: models cite passages as [S3] and attached documents as
 * [D1], sometimes several at once ([S1, S4]). In rendered Markdown these become chips, but only
 * in prose: code spans, code blocks, math and link text are left exactly as written.
 */

const GROUP = /\[([SD]\d{1,5}(?:\s*[,;]\s*[SD]\d{1,5})*)\]/g;
const ID = /[SD]\d{1,5}/g;

export type CitationSegment = { type: 'text'; value: string } | { type: 'cite'; ids: string[]; raw: string };

/** Splits prose into plain text and citation groups. Text without citations comes back as one segment. */
export function splitCitations(text: string): CitationSegment[] {
  if (!text.includes('[')) return [{ type: 'text', value: text }];
  const out: CitationSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(GROUP)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({ type: 'cite', ids: match[1]!.match(ID) ?? [], raw: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out.length > 0 ? out : [{ type: 'text', value: text }];
}

/** Element name the plugin gives citation groups in the HTML tree; the renderer maps it to chips. */
export const CITATION_ELEMENT = 'cite';
/** Property carrying the space-separated ids of a citation group. */
export const CITATION_PROPERTY = 'dataCitation';
/** The same property as the renderer receives it. */
export const CITATION_ATTRIBUTE = 'data-citation';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** Link text is already interactive; a chip inside a link would nest controls. */
const SKIP = new Set(['link', 'linkReference', 'definition']);

function transform(node: MdNode): void {
  const children = node.children;
  if (!children || SKIP.has(node.type)) return;
  let changed = false;
  const next: MdNode[] = [];
  for (const child of children) {
    if (child.type !== 'text' || typeof child.value !== 'string' || !child.value.includes('[')) {
      transform(child);
      next.push(child);
      continue;
    }
    const segments = splitCitations(child.value);
    if (segments.length === 1 && segments[0]!.type === 'text') {
      next.push(child);
      continue;
    }
    changed = true;
    for (const seg of segments) {
      if (seg.type === 'text') next.push({ type: 'text', value: seg.value });
      else
        next.push({
          type: 'text',
          value: seg.raw,
          data: { hName: CITATION_ELEMENT, hProperties: { [CITATION_PROPERTY]: seg.ids.join(' ') } },
        });
    }
  }
  if (changed) node.children = next;
}

/**
 * Remark plugin. Only `text` nodes are touched, so inline code, fenced code and math (which are
 * separate node types holding their own `value`) are never rewritten. Whether an id is known is
 * decided when rendering, so the plugin stays static and memoised Markdown does not re-parse when
 * the library of a turn arrives.
 */
export function remarkCitations() {
  return (tree: Root) => {
    transform(tree as unknown as MdNode);
  };
}

export interface CitationInfo {
  id: string;
  kind: 'passage' | 'document';
  /** The turn whose Sources block lists it. */
  turnId: string;
  title: string;
  where: string;
}

export type CitationLookup = ReadonlyMap<string, CitationInfo>;

export const EMPTY_LOOKUP: CitationLookup = new Map();

function ownCitations(turnId: string, library: TurnLibrary | null): CitationInfo[] {
  if (!library) return [];
  const out: CitationInfo[] = [];
  for (const e of library.excerpts ?? []) {
    out.push({ id: e.id, kind: 'passage', turnId, title: e.title, where: whereText([e.sourceName, e.location, e.part]) });
  }
  for (const a of library.attachments ?? []) {
    out.push({ id: a.id, kind: 'document', turnId, title: a.title, where: whereText([a.sourceName, a.location]) });
  }
  return out;
}

/**
 * For each turn, the citation ids its text may use: its own library first, then earlier turns of
 * the conversation (ids are unique within a conversation and reused when the same passage or
 * document comes up again, so the most recent turn that lists an id owns it).
 */
export function buildCitationLookups(entries: { turnId: string; library: TurnLibrary | null }[]): Map<string, CitationLookup> {
  const result = new Map<string, CitationLookup>();
  let earlier: Map<string, CitationInfo> = new Map();
  for (const { turnId, library } of entries) {
    const own = ownCitations(turnId, library);
    if (own.length === 0) {
      result.set(turnId, earlier.size === 0 ? EMPTY_LOOKUP : earlier);
      continue;
    }
    const combined = new Map(earlier);
    for (const c of own) combined.set(c.id, c);
    result.set(turnId, combined);
    earlier = combined;
  }
  return result;
}
