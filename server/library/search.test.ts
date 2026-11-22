import { describe, expect, it } from 'vitest';
import { canBreakAt, chunkText } from './chunk';
import { LibraryIndex, type IndexDocInput } from './index';
import { searchIndex } from './search';
import { fold, queryTerms, stem, tokenize } from './tokenize';
import type { Part } from './types';

function words(n: number, seed: string): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`${seed}${i % 17}`);
  return out.join(' ');
}

describe('chunking', () => {
  it('covers the text contiguously and never splits a word', () => {
    const text = `${words(300, 'alpha')}. ${words(300, 'beta')}! ${words(250, 'gamma')}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(text.length);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end);
    for (const c of chunks) {
      expect(canBreakAt(text, c.start)).toBe(true);
      expect(/\w/.test(text[c.start - 1] ?? ' ') && /\w/.test(text[c.start] ?? ' ')).toBe(false);
      expect(c.end - c.start).toBeLessThanOrEqual(1_500);
    }
  });

  it('prefers paragraph boundaries, then sentence ends', () => {
    const para = `${'Lorem ipsum dolor sit amet. '.repeat(30).trim()}\n\n${'Second paragraph text here. '.repeat(30).trim()}`;
    const chunks = chunkText(para);
    expect(para.slice(chunks[0]!.start, chunks[0]!.end).endsWith('\n\n')).toBe(true);
    const sentences = 'This is a sentence that goes on. '.repeat(80);
    for (const c of chunkText(sentences).slice(0, -1)) expect(sentences.slice(c.start, c.end)).toMatch(/\. $/);
  });

  it('keeps a word longer than the chunk size whole', () => {
    const giant = `start ${'x'.repeat(3_000)} end`;
    const chunks = chunkText(giant);
    const pieces = chunks.map((c) => giant.slice(c.start, c.end).trim());
    expect(pieces.some((p) => p === 'x'.repeat(3_000) || p.includes('x'.repeat(3_000)))).toBe(true);
  });

  it('breaks text written without spaces between characters, and never inside a surrogate pair', () => {
    const cjk = '日本語の文章'.repeat(400);
    const chunks = chunkText(cjk);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(1_500);
    const emoji = '😀'.repeat(2_000);
    for (const c of chunkText(emoji)) expect(emoji.charCodeAt(c.start) >= 0xdc00 && emoji.charCodeAt(c.start) <= 0xdfff).toBe(false);
  });

  it('returns no chunks for empty text and one for short text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('short')).toEqual([{ start: 0, end: 5 }]);
  });
});

describe('tokenizer', () => {
  it('folds case and diacritics and drops stop words and single letters', () => {
    expect(fold('Zürich CAFÉ')).toBe('zurich cafe');
    expect(tokenize('The Café in Zürich is a 5 star place')).toEqual(['cafe', 'zurich', '5', 'star', 'place']);
    expect(queryTerms('the of and')).toEqual([]);
    expect(queryTerms('')).toEqual([]);
  });

  it('stems plurals and -ing/-ed/-ly consistently', () => {
    expect(stem('renewals')).toBe(stem('renewal'));
    expect(stem('renewing')).toBe(stem('renewed'));
    expect(stem('renewing')).toBe(stem('renew'));
    expect(stem('policies')).toBe(stem('policy'));
    expect(stem('files')).toBe(stem('file'));
    expect(stem('boxes')).toBe(stem('box'));
    expect(stem('running')).toBe(stem('run'));
    expect(stem('speeds')).toBe(stem('speed'));
    expect(stem('quickly')).toBe(stem('quick'));
    expect(stem('class')).toBe('class');
    expect(stem('status')).toBe('status');
    expect(stem('sing')).toBe('sing');
    expect(stem('2024')).toBe('2024');
  });
});

function doc(id: string, title: string, parts: string[], sourceId = 'src', location = ''): IndexDocInput {
  return { id, sourceId, title, location, parts: parts.map((text, i) => ({ label: parts.length > 1 ? `p. ${i + 1}` : '', text })) };
}

async function setup(docs: IndexDocInput[]) {
  const index = await LibraryIndex.build(docs, { yieldEvery: 3 });
  const byId = new Map(docs.map((d) => [d.id, d.parts]));
  const load = async (id: string): Promise<Part[] | null> => byId.get(id) ?? null;
  return { index, load };
}

const filler = (word: string) => `${word} `.repeat(5) + words(200, 'pad');

describe('index and search', () => {
  it('finds chunks by the document title and location, not just the text', async () => {
    const { index, load } = await setup([
      doc('d1', 'Acme MSA.pdf', ['The parties agree on a renewal term of two years.'], 'src', 'Contracts/Clients'),
      doc('d2', 'Notes.txt', ['Nothing about that company here.']),
    ]);
    const found = await searchIndex(index, ['the Acme contract'], { budgetChars: 10_000, sourceIds: ['src'] }, load);
    expect(found[0]!.documentId).toBe('d1');
    const byLocation = await searchIndex(index, ['clients'], { budgetChars: 10_000, sourceIds: ['src'] }, load);
    expect(byLocation.map((f) => f.documentId)).toEqual(['d1']);
  });

  it('matches across diacritics and word forms', async () => {
    const { index, load } = await setup([doc('d1', 'x', ['Meeting in Zürich about contract renewals.'])]);
    for (const q of ['zurich', 'ZÜRICH', 'renewal', 'renewing contracts']) {
      const found = await searchIndex(index, [q], { budgetChars: 10_000, sourceIds: ['src'] }, load);
      expect(found).toHaveLength(1);
    }
  });

  it('searches only the given sources', async () => {
    const { index, load } = await setup([doc('d1', 'a', ['budget figures'], 'one'), doc('d2', 'b', ['budget figures'], 'two')]);
    const found = await searchIndex(index, ['budget'], { budgetChars: 10_000, sourceIds: ['two'] }, load);
    expect(found.map((f) => f.documentId)).toEqual(['d2']);
    expect(await searchIndex(index, ['budget'], { budgetChars: 10_000, sourceIds: [] }, load)).toEqual([]);
  });

  it('ignores empty and stop-word-only queries', async () => {
    const { index, load } = await setup([doc('d1', 'a', ['budget figures'])]);
    expect(await searchIndex(index, ['', 'the and of'], { budgetChars: 10_000, sourceIds: ['src'] }, load)).toEqual([]);
  });

  it('fuses several queries by reciprocal rank', async () => {
    const { index, load } = await setup([
      doc('d1', 'x', ['apples apples apples']),
      doc('d2', 'y', ['pears pears pears']),
      doc('d3', 'z', ['apples and pears together']),
    ]);
    const found = await searchIndex(index, ['apples', 'pears'], { budgetChars: 10_000, sourceIds: ['src'] }, load);
    // d3 appears in both result lists, so it outranks documents found by one query only.
    expect(found[0]!.documentId).toBe('d3');
    expect(found.map((f) => f.documentId).sort()).toEqual(['d1', 'd2', 'd3']);
  });

  it('caps a document at four chunks while others compete, then relaxes the cap', async () => {
    const big = Array.from({ length: 10 }, (_, i) => `Section ${i}. ${filler('turbine')}`).join('\n\n');
    const { index, load } = await setup([doc('big', 'Manual', [big]), doc('small', 'Memo', ['turbine maintenance'])]);
    const chunksOfBig = index.chunks.filter((c) => index.docs[c.doc]!.id === 'big').length;
    expect(chunksOfBig).toBeGreaterThan(5);
    // A budget that fits about five chunks: four from "big", then "small", before the cap relaxes.
    const tight = await searchIndex(index, ['turbine'], { budgetChars: 4 * 1_500 + 100, sourceIds: ['src'] }, load);
    expect(tight.some((f) => f.documentId === 'small')).toBe(true);
    // With room to spare the cap is relaxed and more of "big" comes in.
    const roomy = await searchIndex(index, ['turbine'], { budgetChars: 100_000, sourceIds: ['src'] }, load);
    const bigChars = roomy.filter((f) => f.documentId === 'big').reduce((n, f) => n + f.text.length, 0);
    expect(bigChars).toBeGreaterThan(big.length * 0.9);
  });

  it('merges adjacent chunks into one passage and respects the budget', async () => {
    const text = Array.from({ length: 6 }, () => filler('reactor')).join('\n\n');
    const { index, load } = await setup([doc('d1', 'Reactor', [text])]);
    const all = await searchIndex(index, ['reactor'], { budgetChars: 1_000_000, sourceIds: ['src'] }, load);
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toBe(text.trim());
    expect(all[0]!.firstChunk).toBe(0);
    for (const budget of [2_000, 3_000, 5_000]) {
      const some = await searchIndex(index, ['reactor'], { budgetChars: budget, sourceIds: ['src'] }, load);
      expect(some.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(budget);
      expect(some.length).toBeGreaterThan(0);
    }
  });

  it('labels passages with their part and does not merge across parts', async () => {
    const { index, load } = await setup([doc('d1', 'Report', ['Revenue grew by 7 percent.', 'Revenue grew by 14 percent.'])]);
    const found = await searchIndex(index, ['revenue'], { budgetChars: 10_000, sourceIds: ['src'] }, load);
    expect(found.map((f) => f.part).sort()).toEqual(['p. 1', 'p. 2']);
  });

  it('is deterministic', async () => {
    const docs = Array.from({ length: 20 }, (_, i) => doc(`d${String(i).padStart(2, '0')}`, `Doc ${i}`, [filler('lithium')]));
    const a = await setup(docs);
    const b = await setup([...docs].reverse());
    const r1 = await searchIndex(a.index, ['lithium battery'], { budgetChars: 8_000, sourceIds: ['src'] }, a.load);
    const r2 = await searchIndex(a.index, ['lithium battery'], { budgetChars: 8_000, sourceIds: ['src'] }, a.load);
    const r3 = await searchIndex(b.index, ['lithium battery'], { budgetChars: 8_000, sourceIds: ['src'] }, b.load);
    expect(r2).toEqual(r1);
    expect(r3.map((r) => r.documentId)).toEqual(r1.map((r) => r.documentId));
  });

  it('skips a passage whose document changed after the index was built', async () => {
    const { index } = await setup([doc('d1', 'x', ['alpha beta gamma'])]);
    const changed = async () => [{ label: '', text: 'completely different text now' }];
    expect(await searchIndex(index, ['alpha'], { budgetChars: 10_000, sourceIds: ['src'] }, changed)).toEqual([]);
  });

  it('yields to the event loop while building', async () => {
    const docs = Array.from({ length: 50 }, (_, i) => doc(`d${i}`, 't', [filler('word')]));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const built = LibraryIndex.build(docs, { yieldEvery: 5 });
    const order: string[] = [];
    void built.then(() => order.push('built'));
    await new Promise((r) => setImmediate(r));
    order.push('tick');
    await built;
    clearInterval(timer);
    expect(order[0]).toBe('tick');
  });
});
