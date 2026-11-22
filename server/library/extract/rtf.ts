/** Destinations whose content is not document text (tables of fonts, pictures, metadata…). */
const SKIP = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'header',
  'footer',
  'headerl',
  'headerr',
  'headerf',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'xmlnstbl',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'generator',
  'object',
  'fldinst',
  'bkmkstart',
  'bkmkend',
  'filetbl',
  'revtbl',
  'pgdsctbl',
]);

const CODEPAGES: Record<number, string> = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
};

function decoderFor(codepage: number): TextDecoder {
  try {
    return new TextDecoder(CODEPAGES[codepage] ?? 'windows-1252');
  } catch {
    return new TextDecoder('windows-1252');
  }
}

const CONTROL_WORD = /^\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/;

/**
 * Minimal RTF to plain text: groups and ignorable destinations, paragraph and tab controls,
 * `\'hh` bytes in the document's code page (consecutive bytes decoded together, so double-byte
 * code pages work) and `\uN` Unicode escapes with their `\ucN` fallback characters skipped.
 * `src` is the file read as Latin-1, so every byte is one character.
 */
export function rtfToText(src: string): string {
  const out: string[] = [];
  const stack: { skip: boolean; uc: number }[] = [];
  let skip = false;
  let uc = 1;
  let decoder = decoderFor(1252);
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length === 0) return;
    out.push(decoder.decode(Uint8Array.from(bytes)));
    bytes = [];
  };
  const emit = (text: string) => {
    flushBytes();
    out.push(text);
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '{') {
      stack.push({ skip, uc });
      i++;
      if (src[i] === '\\' && src[i + 1] === '*') skip = true;
      continue;
    }
    if (c === '}') {
      const top = stack.pop() ?? { skip: false, uc: 1 };
      skip = top.skip;
      uc = top.uc;
      i++;
      continue;
    }
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) break;
      if (n === '\\' || n === '{' || n === '}') {
        if (!skip) emit(n);
        i += 2;
        continue;
      }
      if (n === "'") {
        const code = parseInt(src.slice(i + 2, i + 4), 16);
        if (!skip && Number.isFinite(code)) bytes.push(code);
        i += 4;
        continue;
      }
      if (n === '~') {
        if (!skip) emit(' ');
        i += 2;
        continue;
      }
      if (n === '_') {
        if (!skip) emit('-');
        i += 2;
        continue;
      }
      if (n === '\n' || n === '\r') {
        // A backslash before a line break is a paragraph mark.
        if (!skip) emit('\n');
        i += 2;
        continue;
      }
      const m = CONTROL_WORD.exec(src.slice(i, i + 48));
      if (!m) {
        i += 2;
        continue;
      }
      const word = m[1]!;
      const param = m[2] === undefined ? null : Number(m[2]);
      i += m[0].length;
      if (SKIP.has(word)) {
        skip = true;
      } else if (word === 'ansicpg' && param !== null) {
        flushBytes();
        decoder = decoderFor(param);
      } else if (word === 'uc' && param !== null) {
        uc = Math.max(0, param);
      } else if (word === 'u' && param !== null) {
        if (!skip) emit(String.fromCharCode(param < 0 ? param + 65536 : param));
        // Skip the fallback characters that follow for readers without Unicode support.
        for (let k = 0; k < uc && i < src.length; k++) {
          if (src[i] === '\\' && src[i + 1] === "'") i += 4;
          else if (src[i] === '{' || src[i] === '}') break;
          else i++;
        }
      } else if (word === 'bin' && param !== null) {
        i += Math.max(0, param);
      } else if (!skip) {
        if (word === 'par' || word === 'line' || word === 'sect' || word === 'row' || word === 'page') emit('\n');
        else if (word === 'tab' || word === 'cell') emit('\t');
        else if (word === 'emdash') emit('—');
        else if (word === 'endash') emit('–');
        else if (word === 'bullet') emit('•');
        else if (word === 'lquote') emit('‘');
        else if (word === 'rquote') emit('’');
        else if (word === 'ldblquote') emit('“');
        else if (word === 'rdblquote') emit('”');
      }
      continue;
    }
    if (c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (!skip) emit(c);
    i++;
  }
  flushBytes();
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
