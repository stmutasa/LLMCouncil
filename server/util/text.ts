// CSI (colours, cursor movement), OSC (titles, hyperlinks) and two-character escape sequences.
const ANSI_RE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

// Control characters other than tab and newline; carriage returns are handled separately.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Makes raw CLI output safe and readable for display: escape sequences and stray control
 * characters removed, progress-bar carriage returns resolved, runs of blank lines collapsed.
 */
export function cleanCliText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      // A bare carriage return redraws the line; only what was drawn last is visible.
      const parts = line.split('\r');
      return parts[parts.length - 1]!;
    })
    .join('\n')
    .replace(CONTROL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Keeps the end of long output, where CLIs print the actual error. */
export function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return '…' + text.slice(text.length - maxChars + 1);
}

/** CLI output turned into a one-paragraph-ish message suitable for an error card. */
export function cliMessage(raw: string, maxChars = 1200): string {
  return tail(cleanCliText(raw), maxChars);
}

/** Appends a sentence, adding the full stop the first part may lack. */
export function joinSentences(...parts: string[]): string {
  const kept = parts.map((p) => p.trim()).filter(Boolean);
  return kept
    .map((p, i) => (i < kept.length - 1 && !/[.!?:]$/.test(p) ? p + '.' : p))
    .join(' ');
}

/** Removes a trailing full stop so the text can be embedded in a longer sentence. */
export function withoutFinalPeriod(text: string): string {
  return text.trim().replace(/\.+$/, '');
}

/** Bounded buffer of the most recent output, for diagnostics. */
export class TailBuffer {
  private text = '';
  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.maxChars * 2) this.text = this.text.slice(-this.maxChars);
  }

  toString(): string {
    return this.text.length > this.maxChars ? this.text.slice(-this.maxChars) : this.text;
  }
}
