import type { Provider } from '../providers/types';

export const PLANNER_TIMEOUT_MS = 45_000;
export const MAX_PLANNER_QUERIES = 6;
const MAX_QUERY_CHARS = 120;
const MAX_EARLIER = 10;
const MAX_EARLIER_CHARS = 300;

export const PLANNER_INTRO =
  "You are preparing keyword searches over a user's private document library. The search engine matches words, not meaning, so the right terms matter.";

export function plannerPrompt(question: string, earlierQuestions: string[]): string {
  const sections = [PLANNER_INTRO];
  const earlier = earlierQuestions
    .map((q) => q.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-MAX_EARLIER)
    .map((q) => (q.length > MAX_EARLIER_CHARS ? `${q.slice(0, MAX_EARLIER_CHARS - 1)}…` : q));
  if (earlier.length > 0) {
    sections.push(`Earlier questions in this conversation, oldest first:\n${earlier.map((q) => `- ${q}`).join('\n')}`);
  }
  sections.push(`The user's question:\n<question>\n${question}\n</question>`);
  sections.push(
    'Write up to 6 short search queries (2 to 6 words each) that together would find the passages needed to answer the question. Use the specific names, terms, numbers and alternative wordings likely to appear in the documents themselves. Reply with a JSON array of strings and nothing else.',
  );
  return sections.join('\n\n');
}

function tidy(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const q = raw.replace(/\s+/g, ' ').trim();
    if (!q) continue;
    out.push(q.length > MAX_QUERY_CHARS ? q.slice(0, MAX_QUERY_CHARS).trim() : q);
    if (out.length >= MAX_PLANNER_QUERIES) break;
  }
  return out;
}

/**
 * Reads the planner's reply leniently: the outermost `[ … ]` if it parses as an array of strings,
 * otherwise one query per non-empty line with list markers and quotes removed.
 */
export function parsePlannerOutput(text: string): string[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return tidy(value as string[]);
    } catch {
      // Fall through to line parsing.
    }
  }
  const lines = text
    .split('\n')
    // Queries are short; a long line is cut before the regexes below look at it.
    .map((l) => l.slice(0, 500).trim())
    .filter((l) => l && !/^```/.test(l) && l !== '[' && l !== ']')
    .map((l) =>
      l
        .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
        .replace(/,$/, '')
        .replace(/^["'“‘`]+|["'”’`]+$/g, '')
        .trim(),
    );
  return tidy(lines);
}

/** The question itself first, then the planner's queries, without repeats. */
export function combineQueries(question: string, planned: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of [question, ...planned]) {
    const key = q.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q.trim());
  }
  return out;
}

/** One planner call. Rejects with a user-presentable error. */
export async function runPlanner(
  provider: Provider,
  opts: { model: string; effort: string; question: string; earlierQuestions: string[]; signal: AbortSignal; timeoutMs?: number },
): Promise<string[]> {
  const out = await provider.run({
    prompt: plannerPrompt(opts.question, opts.earlierQuestions),
    model: opts.model,
    effort: opts.effort,
    webSearch: false,
    timeoutMs: opts.timeoutMs ?? PLANNER_TIMEOUT_MS,
    signal: opts.signal,
    onText: () => undefined,
    onActivity: () => undefined,
  });
  return parsePlannerOutput(out.text);
}
