/**
 * Models often write LaTeX with \[…\] and \(…\) delimiters, which remark-math does not know.
 * Convert them to $$…$$ outside code so KaTeX renders them, leaving code untouched.
 *
 * - \[…\] that occupies its own lines becomes a display block ($$ on separate lines, indented
 *   so it stays inside list items and block quotes); elsewhere it becomes inline $$…$$.
 * - \(…\) becomes inline $$…$$.
 * - Fenced code blocks and inline code spans are copied verbatim.
 * - A delimiter preceded by an odd number of backslashes is escaped (e.g. LaTeX's \\[2pt]) and
 *   is not treated as a delimiter.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes('\\[') && !markdown.includes('\\(')) return markdown;
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; length: number } | null = null;

  const flushProse = () => {
    if (prose.length > 0) {
      out.push(convertProse(prose.join('\n')));
      prose = [];
    }
  };

  for (const line of markdown.split('\n')) {
    if (fence) {
      out.push(line);
      const close = /^[\s>]*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    const open = /^[\s>]*(?:(?:[-*+]|\d{1,9}[.)])\s+)*(`{3,}|~{3,})/.exec(line);
    if (open) {
      flushProse();
      out.push(line);
      fence = { char: open[1]![0]!, length: open[1]!.length };
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return out.join('\n');
}

function precededByOddBackslashes(text: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

/** Finds the closing delimiter (`\]` or `\)`) that is not itself escaped. */
function findClose(text: string, from: number, closer: string): number {
  let i = text.indexOf(closer, from);
  while (i !== -1 && precededByOddBackslashes(text, i)) i = text.indexOf(closer, i + 1);
  return i;
}

/** Index just past the inline code span opened at `start`, or -1 when the run is unmatched. */
function codeSpanEnd(text: string, start: number): { run: number; end: number } {
  let run = 1;
  while (text[start + run] === '`') run++;
  let search = start + run;
  while (search < text.length) {
    const candidate = text.indexOf('`'.repeat(run), search);
    if (candidate === -1) break;
    let after = candidate + run;
    if (text[after] !== '`') return { run, end: after };
    while (text[after] === '`') after++;
    search = after;
  }
  return { run, end: -1 };
}

function convertProse(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '`') {
      const span = codeSpanEnd(text, i);
      const stop = span.end === -1 ? i + span.run : span.end;
      result += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '\\' && (text[i + 1] === '[' || text[i + 1] === '(') && !precededByOddBackslashes(text, i)) {
      const display = text[i + 1] === '[';
      const close = findClose(text, i + 2, display ? '\\]' : '\\)');
      const inner = close === -1 ? '' : text.slice(i + 2, close);
      if (close !== -1 && inner.trim() !== '') {
        result += display ? displayMath(text, i, close, inner) : `$$${inner.trim()}$$`;
        i = close + 2;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

function displayMath(text: string, open: number, close: number, inner: string): string {
  const lineStart = text.lastIndexOf('\n', open - 1) + 1;
  const before = text.slice(lineStart, open);
  const lineEnd = text.indexOf('\n', close);
  const after = text.slice(close + 2, lineEnd === -1 ? text.length : lineEnd);
  // A block needs the delimiters to own their lines: only indentation, quote and list markers
  // may precede the opener, and nothing may follow the closer.
  if (!/^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?$/.test(before) || after.trim() !== '') {
    return `$$${inner.trim()}$$`;
  }
  const prefix = before.replace(/[^\s>]/g, ' ');
  // Continuation lines already carry their container's markers; replace them with ours.
  const containerMarkers = prefix.includes('>') ? /^[ \t>]*/ : /^[ \t]*/;
  const lines = inner.split('\n').map((l) => l.replace(containerMarkers, '').trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((l) => prefix + l).join('\n');
  // The opening $$ takes the delimiter's place (after any list marker already emitted); the
  // body and closing fence carry the same prefix so they stay in the same container.
  return `$$\n${body}\n${prefix}$$`;
}
