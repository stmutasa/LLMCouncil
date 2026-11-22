/** A chunk is [start, end) of its part's text. A part's chunks are contiguous and cover it all. */
export interface ChunkRange {
  start: number;
  end: number;
}

export const CHUNK_TARGET = 1_200;

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
// Scripts written without spaces: a boundary between two of their characters does not split a word.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

function charBefore(text: string, i: number): string {
  const c = text.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) return text.slice(i - 2, i);
  return text[i - 1] ?? '';
}

function charAt(text: string, i: number): string {
  const c = text.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff) return text.slice(i, i + 2);
  return text[i] ?? '';
}

/** Whether a chunk may end at `i` without cutting a word (or a surrogate pair) in two. */
export function canBreakAt(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return true;
  const code = text.charCodeAt(i);
  if (code >= 0xdc00 && code <= 0xdfff) return false;
  const a = charBefore(text, i);
  const b = charAt(text, i);
  if (!WORD_CHAR.test(a) || !WORD_CHAR.test(b)) return true;
  return UNSPACED.test(a) && UNSPACED.test(b);
}

const PARAGRAPH = /\n[ \t]*\n\s*/g;
const SENTENCE = /[.!?。！？](?:["'”’)\]]*)\s+/g;
const SPACE = /\s+/g;

/** The candidate closest to `target` among the matches' end positions within [lo, hi]. */
function nearestBreak(text: string, re: RegExp, lo: number, hi: number, target: number): number | null {
  re.lastIndex = lo;
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const at = m.index + m[0].length;
    if (m.index > hi) break;
    if (at >= lo && at <= hi && at < text.length) {
      if (best === null || Math.abs(at - target) < Math.abs(best - target)) best = at;
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return best;
}

/**
 * Splits text into chunks of about `target` characters, breaking at a paragraph boundary when
 * there is one nearby, otherwise at a sentence end, then at whitespace, then between characters
 * of a script written without spaces or at punctuation. A word is never cut: a chunk that has no
 * permitted break nearby grows until the next one.
 */
export function chunkText(text: string, target = CHUNK_TARGET): ChunkRange[] {
  const out: ChunkRange[] = [];
  const min = Math.floor(target * 0.5);
  const max = Math.ceil(target * 1.25);
  let pos = 0;
  while (pos < text.length) {
    if (text.length - pos <= max) {
      out.push({ start: pos, end: text.length });
      break;
    }
    const lo = pos + min;
    const hi = pos + max;
    const goal = pos + target;
    let at =
      nearestBreak(text, PARAGRAPH, lo, hi, goal) ??
      nearestBreak(text, SENTENCE, lo, hi, goal) ??
      nearestBreak(text, SPACE, lo, hi, goal);
    if (at === null) {
      for (let d = 0; d <= max - min && at === null; d++) {
        if (goal - d >= lo && canBreakAt(text, goal - d)) at = goal - d;
        else if (goal + d <= hi && canBreakAt(text, goal + d)) at = goal + d;
      }
    }
    if (at === null) {
      at = hi;
      while (at < text.length && !canBreakAt(text, at)) at++;
    }
    out.push({ start: pos, end: at });
    pos = at;
  }
  return out;
}
