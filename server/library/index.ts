import { chunkText } from './chunk';
import { tokenize } from './tokenize';
import type { Part } from './types';

export interface IndexDocInput {
  id: string;
  sourceId: string;
  title: string;
  location: string;
  parts: Part[];
}

/** A chunk's place: its document, its part, its number within the document and its character range. */
export interface ChunkRef {
  doc: number;
  part: number;
  /** Position among all chunks of the document, in document order. */
  chunk: number;
  start: number;
  end: number;
}

interface Posting {
  chunks: number[];
  tfs: number[];
}

const K1 = 1.2;
const B = 0.75;
/** A title or location word counts as this many occurrences in every chunk of the document. */
const TITLE_WEIGHT = 2;
const YIELD_EVERY = 200;

/** Length plus FNV-1a hash: cheap, and enough to tell that a part's text is not the indexed one. */
export function textPrint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length}:${h.toString(16)}`;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * An in-memory BM25 index over chunks. It keeps only postings and chunk positions; excerpt text
 * is read from the text files when excerpts are assembled. Built in one go and never mutated, so
 * a new index can be swapped in atomically.
 */
export class LibraryIndex {
  /** partPrints: a fingerprint of each part's text when indexed, to detect text that changed since. */
  readonly docs: { id: string; sourceId: string; partPrints: string[] }[] = [];
  readonly chunks: ChunkRef[] = [];
  private readonly byId = new Map<string, number>();
  private readonly postings = new Map<string, Posting>();
  private readonly lengths: number[] = [];
  private avgLength = 1;

  static empty(): LibraryIndex {
    return new LibraryIndex();
  }

  /**
   * Builds an index, yielding to the event loop every few hundred chunks (inside a large
   * document as well as between documents) so the server stays responsive.
   */
  static async build(
    inputs: AsyncIterable<IndexDocInput> | Iterable<IndexDocInput>,
    opts: { signal?: AbortSignal; yieldEvery?: number } = {},
  ): Promise<LibraryIndex> {
    const index = new LibraryIndex();
    const every = opts.yieldEvery ?? YIELD_EVERY;
    let sinceYield = 0;
    const tick = async () => {
      if (++sinceYield < every) return;
      sinceYield = 0;
      await yieldToEventLoop();
      if (opts.signal?.aborted) throw new Error('Index build cancelled.');
    };
    for await (const input of inputs) {
      if (opts.signal?.aborted) throw new Error('Index build cancelled.');
      await index.add(input, tick);
    }
    index.finish();
    return index;
  }

  private async add(input: IndexDocInput, tick: () => Promise<void>): Promise<void> {
    if (this.byId.has(input.id)) return;
    const docIndex = this.docs.length;
    this.docs.push({ id: input.id, sourceId: input.sourceId, partPrints: input.parts.map((p) => textPrint(p.text)) });
    this.byId.set(input.id, docIndex);

    const titleCounts = new Map<string, number>();
    const titleTokens = tokenize(`${input.title} ${input.location}`);
    for (const t of titleTokens) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);

    let n = 0;
    for (let partIndex = 0; partIndex < input.parts.length; partIndex++) {
      const part = input.parts[partIndex]!;
      for (const range of chunkText(part.text)) {
        await tick();
        const tokens = tokenize(part.text.slice(range.start, range.end));
        if (tokens.length === 0) continue;
        const chunkId = this.chunks.length;
        this.chunks.push({ doc: docIndex, part: partIndex, chunk: n, start: range.start, end: range.end });
        n++;
        const counts = new Map<string, number>();
        for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
        for (const [t, c] of titleCounts) counts.set(t, (counts.get(t) ?? 0) + TITLE_WEIGHT * c);
        this.lengths.push(tokens.length + TITLE_WEIGHT * titleTokens.length);
        for (const [t, tf] of counts) {
          let p = this.postings.get(t);
          if (!p) {
            p = { chunks: [], tfs: [] };
            this.postings.set(t, p);
          }
          p.chunks.push(chunkId);
          p.tfs.push(tf);
        }
      }
    }
  }

  private finish(): void {
    const total = this.lengths.reduce((a, b) => a + b, 0);
    this.avgLength = this.lengths.length > 0 ? total / this.lengths.length : 1;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  /** Document order (by document id, then position), independent of the order of indexing. */
  compareChunks(a: number, b: number): number {
    const ca = this.chunks[a]!;
    const cb = this.chunks[b]!;
    if (ca.doc !== cb.doc) {
      const ia = this.docs[ca.doc]!.id;
      const ib = this.docs[cb.doc]!.id;
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    }
    return ca.chunk - cb.chunk;
  }

  /**
   * The best chunks for the given (already tokenised) terms among documents `allow` accepts,
   * best first; ties broken by document id and position so results are deterministic.
   */
  query(terms: string[], allow: (doc: number) => boolean, limit: number): { chunk: number; score: number }[] {
    const n = this.chunks.length;
    if (n === 0) return [];
    const scores = new Map<number, number>();
    for (const term of new Set(terms)) {
      const p = this.postings.get(term);
      if (!p) continue;
      const df = p.chunks.length;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < p.chunks.length; i++) {
        const c = p.chunks[i]!;
        if (!allow(this.chunks[c]!.doc)) continue;
        const tf = p.tfs[i]!;
        const norm = tf + K1 * (1 - B + (B * this.lengths[c]!) / this.avgLength);
        scores.set(c, (scores.get(c) ?? 0) + (idf * tf * (K1 + 1)) / norm);
      }
    }
    return [...scores.entries()]
      .map(([chunk, score]) => ({ chunk, score }))
      .sort((a, b) => b.score - a.score || this.compareChunks(a.chunk, b.chunk))
      .slice(0, limit);
  }
}
