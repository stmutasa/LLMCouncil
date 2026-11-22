export type TextEncodingName =
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16le'
  | 'utf-16be'
  | 'utf-16le-nobom'
  | 'utf-16be-nobom'
  | 'windows-1252';

/** Thrown for bytes that are not text in any encoding the decoder knows. */
export class BinaryDataError extends Error {
  constructor() {
    super('The file contains binary data, not text.');
    this.name = 'BinaryDataError';
  }
}

/** Swaps byte pairs into a fresh array; a Buffer slice is a view, so it must not be swapped in place. */
function swapped(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i]!;
    out[i] = out[i + 1]!;
    out[i + 1] = t;
  }
  return out;
}

/**
 * Decodes a text file: byte-order marks first, then BOM-less UTF-16 (recognised by NUL bytes at
 * only even or only odd positions), then strict UTF-8, then Windows-1252 (a superset of
 * Latin-1 for printable text). NUL bytes in anything else mean binary data.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  const b = bytes;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8-bom' };
  }
  if (b[0] === 0xff && b[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le' };
  }
  if (b[0] === 0xfe && b[1] === 0xff) {
    return { text: new TextDecoder('utf-16le').decode(swapped(b.subarray(2))), encoding: 'utf-16be' };
  }
  const n = Math.min(b.length, 4096);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    if (b[i] === 0) {
      if (i % 2 === 0) even++;
      else odd++;
    }
  }
  if (n > 1 && odd > n / 4 && even === 0) {
    return { text: new TextDecoder('utf-16le').decode(b), encoding: 'utf-16le-nobom' };
  }
  if (n > 1 && even > n / 4 && odd === 0) {
    return { text: new TextDecoder('utf-16le').decode(swapped(b)), encoding: 'utf-16be-nobom' };
  }
  if (even + odd > 0) throw new BinaryDataError();
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(b), encoding: 'windows-1252' };
  }
}
