import type { Conversation, Turn } from '../../shared/types';
import type { NotionClient } from './notionClient';

export const MAX_NOTION_MARKDOWN = 400_000;

/** Escapes a `<` that begins something tag-like in prose (code spans are left alone). */
function escapeTagsInProse(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = text.indexOf(fence, i + run);
      // A code span runs to the next run of exactly as many backticks.
      let end = close;
      while (end >= 0 && text[end + run] === '`') end = text.indexOf(fence, end + run + 1);
      if (end >= 0) {
        out += text.slice(i, end + run);
        i = end + run;
        continue;
      }
      out += fence;
      i += run;
      continue;
    }
    const c = text[i]!;
    out += c === '<' && /[A-Za-z/!?]/.test(text[i + 1] ?? '') ? '\\<' : c;
    i++;
  }
  return out;
}

/**
 * Text going into a Notion page body. Notion's Markdown reads tags such as `<page url="…">` and
 * mentions, so an answer steered by a hostile document could otherwise link or move the user's
 * pages: outside fenced code blocks and inline code, a `<` that begins something tag-like is
 * escaped as `\<`.
 */
export function escapeNotionText(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  return lines
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return escapeTagsInProse(line);
    })
    .join('\n');
}

/** A single-line value (a title, a name) for the page body. */
function inline(text: string): string {
  return escapeNotionText(text.replace(/[\r\n]+/g, ' '));
}
export const DELIBERATION_DROPPED =
  '*The deliberation was left out because the page would have been too long for Notion.*';

function sourceLines(turn: Turn): string[] {
  const lib = turn.library;
  if (!lib) return [];
  const lines: string[] = [];
  for (const e of lib.excerpts) {
    const where = [e.location, e.part].filter((p) => p.trim() !== '').join(', ');
    lines.push(`- [${e.id}] ${inline(e.title)}${where ? ` — ${inline(where)}` : ''}`);
  }
  for (const a of lib.attachments) {
    if (a.problem) continue;
    lines.push(`- [${a.id}] ${inline(a.title)}${a.location ? ` — ${inline(a.location)}` : ''} (attached)`);
  }
  return lines;
}

function deliberation(turn: Turn): string {
  const names = new Map(turn.members.map((m) => [m.id, m.name]));
  const sections: string[] = [];
  if (turn.analysisText.trim()) sections.push(`## Council analysis\n\n${escapeNotionText(turn.analysisText.trim())}`);
  const rounds: string[] = [];
  for (const round of turn.rounds) {
    const responses = round.responses
      .filter((r) => r.status === 'done' && r.text.trim())
      .map((r) => `#### ${inline(names.get(r.memberId) ?? r.memberId)}\n\n${escapeNotionText(r.text.trim())}`);
    if (responses.length === 0) continue;
    rounds.push(`### Round ${round.index + 1} · ${inline(round.title)}\n\n${responses.join('\n\n')}`);
  }
  if (rounds.length > 0) sections.push(`## Deliberation\n\n${rounds.join('\n\n')}`);
  return sections.join('\n\n');
}

function footer(turn: Turn): string {
  const members = turn.members.map((m) => inline(m.name)).join(', ');
  const date = (turn.finishedAt ?? turn.createdAt).slice(0, 10);
  return `*Answered by LLM Council · ${members} · ${inline(turn.protocolName)} · ${date}*`;
}

/** The page body: question, answer, sources, optionally the deliberation, and a footer. */
export function notionMarkdown(turn: Turn, includeDeliberation: boolean): string {
  const head: string[] = [
    `## Question\n\n${escapeNotionText(turn.userMessage.trim())}`,
    `## Answer\n\n${escapeNotionText(turn.finalText.trim())}`,
  ];
  const sources = sourceLines(turn);
  if (sources.length > 0) head.push(`## Sources\n\n${sources.join('\n')}`);
  const tail = footer(turn);
  if (includeDeliberation) {
    const full = [...head, deliberation(turn), tail].filter(Boolean).join('\n\n');
    if (full.length <= MAX_NOTION_MARKDOWN) return full;
    return [...head, DELIBERATION_DROPPED, tail].join('\n\n');
  }
  return [...head, tail].join('\n\n');
}

/** The title property: plain text (Notion does not read Markdown or tags there), one line. */
export function notionPageTitle(conversation: Conversation): string {
  const t = conversation.title.replace(/[\r\n\t]+/g, ' ').trim() || 'Council answer';
  return t.length <= 200 ? t : `${t.slice(0, 199)}…`;
}

export function createPageBody(parentId: string, title: string, markdown: string): Record<string, unknown> {
  return {
    parent: { page_id: parentId },
    properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
    markdown,
    markdown_version: 'v2',
  };
}

export async function saveTurnToNotion(
  client: NotionClient,
  parentId: string,
  conversation: Conversation,
  turn: Turn,
  includeDeliberation: boolean,
  signal?: AbortSignal,
): Promise<{ url: string; title: string }> {
  const title = notionPageTitle(conversation);
  const res = await client.createPage(createPageBody(parentId, title, notionMarkdown(turn, includeDeliberation)), signal);
  const url = typeof res.url === 'string' ? res.url : typeof res.id === 'string' ? `https://www.notion.so/${res.id.replace(/-/g, '')}` : '';
  return { url, title };
}
