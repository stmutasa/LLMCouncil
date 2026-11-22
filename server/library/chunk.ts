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

/** ASCII is answered without a regex; this is called for every character of an unbreakable run. */
function isWordChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c < 0x80) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return WORD_CHAR.test(ch);
}

/** Whether a chunk may end at `i` without cutting a word (or a surrogate pair) in two. */
export function canBreakAt(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return true;
  const code = text.charCodeAt(i);
  if (code >= 0xdc00 && code <= 0xdfff) return false;
  const a = charBefore(text, i);
  const b = charAt(text, i);
  if (!isWordChar(a) || !isWordChar(b)) return true;
  return a.charCodeAt(0) >= 0x80 && UNSPACED.test(a) && UNSPACED.test(b);
}

const PARAGRAPH = /\n[ \t]*\n\s*/g;
// Western sentence ends need a following space; CJK ones (。！？) do not.
const SENTENCE = /[.!?]["'”’)\]]*\s+|[。！？][」』）"”’]*\s*/g;
const SPACE = /\s+/g;

/**
 * The break closest to `goal` among the end positions of `re`'s matches inside the window
 * [lo, hi]. Only the window is searched (a regex left to scan to the end of a long text for every
 * chunk makes chunking quadratic). Positions are absolute.
 */
function nearestBreak(text: string, re: RegExp, from: number, lo: number, hi: number, goal: number): number | null {
  const window = text.slice(from, hi + 1);
  re.lastIndex = 0;
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const at = from + m.index + m[0].length;
    if (at >= lo && at <= hi && at < text.length && (best === null || Math.abs(at - goal) < Math.abs(best - goal))) {
      best = at;
    }
  }
  return best;
}

/**
 * Splits text into chunks of about `target` characters, breaking at a paragraph boundary when
 * there is one nearby, otherwise at a sentence end, then at whitespace, then between characters
 * of a script written without spaces or at punctuation. A word is never cut: a chunk that has no
 * permitted break nearby grows until the next one. Linear in the length of the text.
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
      nearestBreak(text, PARAGRAPH, pos, lo, hi, goal) ??
      nearestBreak(text, SENTENCE, pos, lo, hi, goal) ??
      nearestBreak(text, SPACE, pos, lo, hi, goal);
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
