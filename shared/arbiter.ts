/**
 * The arbiter is asked to write a council analysis, then this marker on its own line, then the
 * final answer. Both the server (to persist) and the web app (while streaming) split on it.
 */
export const ARBITER_MARKER = '===FINAL ANSWER===';

/** Tolerates extra '=' signs, surrounding emphasis, spacing and case. Must sit on its own line. */
const MARKER_RE = /^[ \t]*(?:\*\*|__|`)?={2,}[ \t]*FINAL[ \t]+ANSWER[ \t]*={2,}(?:\*\*|__|`)?[ \t]*$/im;

const ANALYSIS_HEADING_RE = /^\s*#{1,6}\s*council analysis\s*\n+/i;

/**
 * While streaming, the last line may be a marker that is only partly written ("===FIN").
 * Returns the text with such a trailing fragment removed so it never flashes on screen.
 */
function hidePartialMarker(raw: string): string {
  const lineStart = raw.lastIndexOf('\n') + 1;
  const line = raw.slice(lineStart).trim().replace(/^(?:\*\*|__|`)/, '');
  if (!line.startsWith('=')) return raw;
  const words = line
    .replace(/^=+/, '')
    .replace(/=+$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
  return 'FINAL ANSWER'.startsWith(words) ? raw.slice(0, lineStart) : raw;
}

export interface ArbiterSplit {
  /** The council analysis (without its heading). '' when absent. */
  analysis: string;
  /** The final answer for the user. */
  final: string;
  /** True once the marker has been seen. */
  hasMarker: boolean;
}

/**
 * Split raw arbiter output into analysis and final answer.
 *
 * @param raw             text so far (streaming) or the complete text
 * @param analysisEnabled whether the arbiter was asked for an analysis section
 * @param complete        true when `raw` is the complete output
 *
 * Without analysis the whole text is the final answer. With analysis, text before the marker is
 * analysis and text after it is the answer. If the output is complete and the marker never
 * appeared, the model ignored the format and the whole text is treated as the final answer.
 */
export function splitArbiterOutput(raw: string, analysisEnabled: boolean, complete: boolean): ArbiterSplit {
  if (!analysisEnabled) {
    return { analysis: '', final: raw.trim(), hasMarker: false };
  }
  const match = MARKER_RE.exec(raw);
  if (match) {
    const analysis = raw.slice(0, match.index).replace(ANALYSIS_HEADING_RE, '').trim();
    const final = raw.slice(match.index + match[0].length).trim();
    return { analysis, final, hasMarker: true };
  }
  if (complete) {
    return { analysis: '', final: raw.trim(), hasMarker: false };
  }
  // Still streaming the analysis; hide a marker that is only partly written.
  const visible = hidePartialMarker(raw);
  return { analysis: visible.replace(ANALYSIS_HEADING_RE, '').trim(), final: '', hasMarker: false };
}
