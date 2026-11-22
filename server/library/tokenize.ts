const STOP_WORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is ' +
    'it its me my of on or our she should so than that the their them then there these they this those to us was we ' +
    'were what when where which who whom why will with would you your'
  ).split(' '),
);

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const COMBINING_RE = /\p{M}+/gu;
const DIGITS_RE = /^\p{N}+$/u;
const VOWEL_RE = /[aeiouy]/;

/**
 * A light English suffix stemmer: plural s/es/ies, -ing, -ed and -ly, keeping at least three
 * characters of stem. Applied identically at index and query time, so it only has to be
 * consistent, not linguistically exact.
 */
export function stem(word: string): string {
  if (word.length <= 3 || DIGITS_RE.test(word)) return word;
  let w = word;
  const keep = (s: string) => s.length >= 3;
  if (w.endsWith('ies') && keep(w.slice(0, -3) + 'y')) w = w.slice(0, -3) + 'y';
  else if (/(?:ss|x|z|ch|sh)es$/.test(w) && keep(w.slice(0, -2))) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w) && keep(w.slice(0, -1))) w = w.slice(0, -1);
  // Then the verb and adverb endings, so "speeds" and "speed" (and "feelings", "feeling") agree.
  for (const suffix of ['ing', 'ed', 'ly']) {
    if (!w.endsWith(suffix)) continue;
    const base = w.slice(0, -suffix.length);
    // "sing", "red", "fly": without a vowel in what remains, the ending is part of the word.
    if (!keep(base) || !VOWEL_RE.test(base)) return w;
    w = base;
    // running → runn → run; but keep "ll", "ss", "zz" (calling → call).
    if (suffix !== 'ly' && /([bcdfghjkmnpqrtvwx])\1$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  return w;
}

/** Folds case and diacritics: "Zürich" → "zurich". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(COMBINING_RE, '').toLowerCase();
}

/** Index terms of a text, in order (duplicates kept). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of fold(text).matchAll(TOKEN_RE)) {
    const t = m[0];
    if (t.length === 1 && !DIGITS_RE.test(t)) continue;
    if (STOP_WORDS.has(t)) continue;
    out.push(stem(t));
  }
  return out;
}

/** Distinct terms of a query; [] for an empty or stop-word-only query. */
export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query))];
}
