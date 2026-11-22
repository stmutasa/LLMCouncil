import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ARBITER_MARKER } from '../../shared/arbiter';
import type { ProviderInfo } from '../../shared/types';
import { PLANNER_INTRO } from '../library/planner';
import { abortError, ProviderError, type Provider, type RunRequest } from './types';

export const MOCK_ID = 'mock';

/** Small deterministic string hash (FNV-1a). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function speakerName(prompt: string): string {
  return /^You are ([^,\n]+),/.exec(prompt)?.[1]?.trim() ?? 'Demo';
}

function question(prompt: string): string {
  return /<question>\n([\s\S]*?)\n<\/question>/.exec(prompt)?.[1] ?? '';
}

/** The task section is the last "## Your task" heading and everything after it. */
function taskSection(prompt: string): string {
  const at = prompt.lastIndexOf('## Your task');
  return at >= 0 ? prompt.slice(at) : '';
}

function shownLabels(prompt: string): string[] {
  const labels: string[] = [];
  for (const m of prompt.matchAll(/<response label="Response ([A-Z])"/g)) {
    if (!labels.includes(m[1]!)) labels.push(m[1]!);
  }
  return labels;
}

const CRITIQUES = [
  'It is well organised and answers the question directly.',
  'Some claims would benefit from a source or a concrete figure.',
  'It overlooks an important edge case the user is likely to hit.',
  'The reasoning is sound, though the conclusion could be stated more plainly.',
  'It is thorough but longer than the question needs.',
  'The recommendation is practical and easy to act on.',
];

function reviewText(name: string, prompt: string): string {
  const labels = shownLabels(prompt);
  const parts = labels.map((label) => {
    const h = hash(name + label);
    const a = CRITIQUES[h % CRITIQUES.length]!;
    const b = CRITIQUES[(h >>> 8) % CRITIQUES.length]!;
    const extra = h % 2 === 0 ? ` Overall, ${name} finds it ${h % 3 === 0 ? 'convincing' : 'useful'}.` : '';
    return `**Response ${label}.** ${a} ${b === a ? CRITIQUES[(h + 1) % CRITIQUES.length]! : b}${extra}`;
  });
  if (!taskSection(prompt).includes('FINAL RANKING:')) return parts.join('\n\n');
  const order = [...labels].sort((x, y) => hash(name + x) - hash(name + y) || (x < y ? -1 : 1));
  const ranking = order.map((label, i) => `${i + 1}. Response ${label}`).join('\n');
  return `${parts.join('\n\n')}\n\nFINAL RANKING:\n${ranking}`;
}

/** Context the mock picks up outside the prompt text. */
export interface MockContext {
  /** Browse mode: the number of documents INDEX.md in the working directory lists. */
  browseDocuments?: number | null;
}

/** A sentence citing the first passage and attachment the prompt offers, so citations can be exercised. */
function citations(prompt: string): string {
  const s = /<source id="(S\d+)"/.exec(prompt)?.[1];
  const d = /<document id="(D\d+)"/.exec(prompt)?.[1];
  const refs = [s, d].filter(Boolean).map((id) => `[${id}]`);
  return refs.length ? `The user's documents bear on this ${refs.join(' ')}.` : '';
}

function browseNote(name: string, ctx: MockContext): string {
  const n = ctx.browseDocuments;
  if (n === undefined || n === null) return '';
  return `${name} looked through the library: INDEX.md lists ${n} document${n === 1 ? '' : 's'}.`;
}

const PLAN_STOP = new Set(['what', 'which', 'when', 'where', 'does', 'have', 'with', 'that', 'this', 'from', 'about', 'should', 'would', 'could', 'there', 'their', 'they', 'were', 'will', 'your']);

/** The mock's answer to the search planner: a JSON array built from the question's words. */
export function plannerReply(prompt: string): string {
  const q = question(prompt);
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4 && !PLAN_STOP.has(w)))];
  const queries: string[] = [];
  for (let i = 0; i < words.length && queries.length < 3; i += 2) queries.push(words.slice(i, i + 2).join(' '));
  return JSON.stringify(queries);
}

function arbiterText(name: string, prompt: string, withMarker: boolean, ctx: MockContext): string {
  const q = question(prompt).slice(0, 80);
  const extra = [citations(prompt), browseNote(name, ctx)].filter(Boolean);
  const final = [
    '## Verdict',
    '',
    `After weighing the council's answers, ${name} recommends the following for “${q}”:`,
    ...(extra.length ? ['', ...extra] : []),
    '',
    '- Start with the option the members agreed on.',
    '- Check the one point where they disagreed before committing.',
    '- Revisit the decision once real data is available.',
    '',
    '| Option | Strength | Risk |',
    '| --- | --- | --- |',
    '| Recommended | High | Low |',
    '| Alternative | Medium | Medium |',
    '',
    '```ts',
    "const decision = { option: 'recommended', confidence: 0.8 };",
    '```',
  ].join('\n');
  if (!withMarker || !taskSection(prompt).includes(ARBITER_MARKER)) return final;
  const analysis = [
    '## Council analysis',
    '**Consensus:** The members agree on the main recommendation, and the agreement rests on independent reasoning.',
    '**Contradictions:** They differ on how much risk is acceptable; the more cautious view is better supported.',
    '**Unique insights:** One member pointed out a practical edge case the others missed.',
    '**Blind spots:** None',
  ].join('\n');
  return `${analysis}\n\n${ARBITER_MARKER}\n\n${final}`;
}

function answerText(name: string, prompt: string, ctx: MockContext): string {
  const q = question(prompt).slice(0, 80);
  const revising = prompt.includes('## Your current answer');
  const extra = [citations(prompt), browseNote(name, ctx)].filter(Boolean);
  return [
    revising ? `**What changed:** ${name} tightened the recommendation after reading the other answers.` : '',
    `### ${name}'s answer`,
    '',
    `${name} considered the question: “${q}”.`,
    '',
    ...(extra.length ? [...extra, ''] : []),
    '- The main option is sound for most situations.',
    '- One risk deserves attention before deciding.',
    '',
    `In short, ${name} recommends the straightforward approach.`,
  ]
    .filter((line, i) => i > 0 || line)
    .join('\n');
}

/** What the mock writes for a prompt; exported for tests. */
export function mockResponse(prompt: string, flags: Set<string>, ctx: MockContext = {}): string {
  if (prompt.startsWith(PLANNER_INTRO)) return plannerReply(prompt);
  const name = speakerName(prompt);
  if (/^You are [^\n]+, the arbiter of a council/.test(prompt)) {
    return arbiterText(name, prompt, !flags.has('plain'), ctx);
  }
  if (prompt.includes('## Responses under review')) return reviewText(name, prompt);
  return answerText(name, prompt, ctx);
}

/** Counts the documents INDEX.md lists, as a CLI browsing the mirror would see them. */
async function browseCount(dir: string | undefined): Promise<number | null> {
  if (!dir) return null;
  try {
    const index = await fs.readFile(path.join(dir, 'INDEX.md'), 'utf8');
    return index.split('\n').filter((l) => l.startsWith('- ')).length;
  } catch {
    return 0;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Deterministic demo provider. The model field doubles as a switch (several may be combined
 * with "+" or ","): fail, slow, hang, instant, plain.
 */
export function mockProvider(): Provider {
  return {
    id: MOCK_ID,
    async info(): Promise<ProviderInfo> {
      return {
        id: MOCK_ID,
        label: 'Demo',
        cliName: 'Built-in demo provider',
        vendor: 'LLM Council',
        kind: 'mock',
        command: '(built in)',
        installed: true,
        version: 'mock-1',
        auth: 'ok',
        authDetail: 'The demo provider needs no sign-in.',
        billing: 'subscription',
        warnings: [],
        effortLevels: ['low', 'medium', 'high'],
        webSearch: 'none',
        streams: true,
        browse: 'yes',
        modelSuggestions: ['instant', 'slow', 'fail', 'hang', 'plain'],
        canListModels: false,
        installHint: '',
        loginHint: '',
        docsUrl: '',
      };
    },
    async run(req: RunRequest) {
      const flags = new Set(req.model.toLowerCase().split(/[\s,+]+/).filter(Boolean));
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const signal = AbortSignal.any([req.signal, timeout]);
      const wait = async (ms: number) => {
        try {
          await sleep(ms, signal);
        } catch (err) {
          if (timeout.aborted && !req.signal.aborted) {
            throw new ProviderError(`Demo provider timed out after ${Math.round(req.timeoutMs / 1000)} s.`);
          }
          throw err;
        }
      };
      const instant = flags.has('instant');
      if (req.signal.aborted) throw abortError();

      if (!instant) {
        req.onActivity('Thinking…');
        await wait(100);
        req.onActivity('');
      }
      if (flags.has('fail')) {
        throw new ProviderError('Mock failure');
      }
      const text = mockResponse(req.prompt, flags, { browseDocuments: await browseCount(req.browseDir) });
      const words = text.split(/(?<=\s)/);
      const name = speakerName(req.prompt);
      const totalMs = flags.has('slow') ? 8_000 : 600 + (hash(name + req.prompt.length) % 800);
      const perWord = totalMs / Math.max(1, words.length);
      const hangAfter = flags.has('hang') ? Math.min(words.length, 5) : Infinity;

      // Delays accumulate fractionally so many short words still add up to the total.
      let debt = 0;
      for (let i = 0; i < words.length; i++) {
        if (i === hangAfter) {
          await wait(2 ** 31 - 1);
        }
        req.onText(words[i]!, false);
        if (instant) {
          if (i % 16 === 15) await wait(0);
          continue;
        }
        debt += perWord;
        if (debt >= 15) {
          await wait(Math.floor(debt));
          debt -= Math.floor(debt);
        }
      }
      if (flags.has('hang')) await wait(2 ** 31 - 1);
      return { text, model: 'mock-1', billing: 'subscription', diagnostics: '' };
    },
  };
}
