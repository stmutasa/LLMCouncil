import { textPrint, type LibraryIndex } from './index';
import { queryTerms } from './tokenize';
import type { Part } from './types';

export const PER_QUERY = 40;
export const RRF_K = 60;
export const PER_DOCUMENT_CAP = 4;

/** A passage before it is given a citation id: one or more adjacent chunks of one part. */
export interface FoundPassage {
  documentId: string;
  partIndex: number;
  /** The part's label ('' when the document is not divided). */
  part: string;
  firstChunk: number;
  lastChunk: number;
  text: string;
  /** Best fused score among its chunks. */
  score: number;
}

export interface SearchOptions {
  budgetChars: number;
  /** Only documents of these sources are searched. */
  sourceIds: string[];
  /** Documents left out (attached in full already, so passages from them would repeat them). */
  excludeDocumentIds?: string[];
}

interface Picked {
  chunk: number;
  score: number;
}

/**
 * Searches with several queries at once: each query's best chunks are fused by reciprocal rank,
 * chunks are taken best first (at most four per document while others compete) until the
 * character budget is used, and adjacent chunks are merged into one passage. The result depends
 * only on the index and the input.
 */
export async function searchIndex(
  index: LibraryIndex,
  queries: string[],
  opts: SearchOptions,
  loadParts: (documentId: string) => Promise<Part[] | null>,
): Promise<FoundPassage[]> {
  const allowedSources = new Set(opts.sourceIds);
  const excluded = new Set(opts.excludeDocumentIds ?? []);
  const allowedDocs = new Set<number>();
  index.docs.forEach((d, i) => {
    if (allowedSources.has(d.sourceId) && !excluded.has(d.id)) allowedDocs.add(i);
  });
  if (allowedDocs.size === 0 || opts.budgetChars <= 0) return [];
  const allow = (doc: number) => allowedDocs.has(doc);

  const fused = new Map<number, number>();
  const seenQueries = new Set<string>();
  for (const q of queries) {
    const terms = queryTerms(q);
    if (terms.length === 0) continue;
    const key = [...terms].sort().join(' ');
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);
    index.query(terms, allow, PER_QUERY).forEach((hit, i) => {
      fused.set(hit.chunk, (fused.get(hit.chunk) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  const ranked: Picked[] = [...fused.entries()]
    .map(([chunk, score]) => ({ chunk, score }))
    .sort((a, b) => b.score - a.score || index.compareChunks(a.chunk, b.chunk));

  const lengthOf = (c: number) => index.chunks[c]!.end - index.chunks[c]!.start;
  const selected: Picked[] = [];
  const taken = new Set<number>();
  const perDoc = new Map<number, number>();
  let used = 0;
  const pass = (cap: number) => {
    for (const p of ranked) {
      if (taken.has(p.chunk)) continue;
      const doc = index.chunks[p.chunk]!.doc;
      if ((perDoc.get(doc) ?? 0) >= cap) continue;
      const len = lengthOf(p.chunk);
      if (used + len > opts.budgetChars) continue;
      taken.add(p.chunk);
      selected.push(p);
      perDoc.set(doc, (perDoc.get(doc) ?? 0) + 1);
      used += len;
    }
  };
  pass(PER_DOCUMENT_CAP);
  pass(Infinity);
  if (selected.length === 0) return [];

  // Group runs of adjacent chunks (same document and part, touching ranges) into passages.
  const inOrder = [...selected].sort((a, b) => index.compareChunks(a.chunk, b.chunk));
  const groups: Picked[][] = [];
  for (const p of inOrder) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    const a = prev ? index.chunks[prev.chunk]! : null;
    const b = index.chunks[p.chunk]!;
    if (last && a && a.doc === b.doc && a.part === b.part && a.end === b.start) last.push(p);
    else groups.push([p]);
  }

  const partsCache = new Map<string, Part[] | null>();
  const out: FoundPassage[] = [];
  for (const g of groups) {
    const first = index.chunks[g[0]!.chunk]!;
    const last = index.chunks[g[g.length - 1]!.chunk]!;
    const documentId = index.docs[first.doc]!.id;
    if (!partsCache.has(documentId)) partsCache.set(documentId, await loadParts(documentId));
    const part = partsCache.get(documentId)?.[first.part];
    // The document was read again after the index was built; its ranges no longer apply.
    if (!part || textPrint(part.text) !== index.docs[first.doc]!.partPrints[first.part]) continue;
    const text = part.text.slice(first.start, last.end).trim();
    if (!text) continue;
    out.push({
      documentId,
      partIndex: first.part,
      part: part.label,
      firstChunk: first.chunk,
      lastChunk: last.chunk,
      text,
      score: Math.max(...g.map((p) => p.score)),
    });
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0) ||
      a.firstChunk - b.firstChunk,
  );
  return out;
}
