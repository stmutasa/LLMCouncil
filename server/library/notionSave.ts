import type { Conversation, Turn } from '../../shared/types';
import type { NotionClient } from './notionClient';

export const MAX_NOTION_MARKDOWN = 400_000;
export const DELIBERATION_DROPPED =
  '*The deliberation was left out because the page would have been too long for Notion.*';

function sourceLines(turn: Turn): string[] {
  const lib = turn.library;
  if (!lib) return [];
  const lines: string[] = [];
  for (const e of lib.excerpts) {
    const where = [e.location, e.part].filter((p) => p.trim() !== '').join(', ');
    lines.push(`- [${e.id}] ${e.title}${where ? ` — ${where}` : ''}`);
  }
  for (const a of lib.attachments) {
    if (a.problem) continue;
    lines.push(`- [${a.id}] ${a.title}${a.location ? ` — ${a.location}` : ''} (attached)`);
  }
  return lines;
}

function deliberation(turn: Turn): string {
  const names = new Map(turn.members.map((m) => [m.id, m.name]));
  const sections: string[] = [];
  if (turn.analysisText.trim()) sections.push(`## Council analysis\n\n${turn.analysisText.trim()}`);
  const rounds: string[] = [];
  for (const round of turn.rounds) {
    const responses = round.responses
      .filter((r) => r.status === 'done' && r.text.trim())
      .map((r) => `#### ${names.get(r.memberId) ?? r.memberId}\n\n${r.text.trim()}`);
    if (responses.length === 0) continue;
    rounds.push(`### Round ${round.index + 1} · ${round.title}\n\n${responses.join('\n\n')}`);
  }
  if (rounds.length > 0) sections.push(`## Deliberation\n\n${rounds.join('\n\n')}`);
  return sections.join('\n\n');
}

function footer(turn: Turn): string {
  const members = turn.members.map((m) => m.name).join(', ');
  const date = (turn.finishedAt ?? turn.createdAt).slice(0, 10);
  return `*Answered by LLM Council · ${members} · ${turn.protocolName} · ${date}*`;
}

/** The page body: question, answer, sources, optionally the deliberation, and a footer. */
export function notionMarkdown(turn: Turn, includeDeliberation: boolean): string {
  const head: string[] = [`## Question\n\n${turn.userMessage.trim()}`, `## Answer\n\n${turn.finalText.trim()}`];
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

export function notionPageTitle(conversation: Conversation): string {
  const t = conversation.title.trim() || 'Council answer';
  return t.length <= 200 ? t : `${t.slice(0, 199)}…`;
}

export function createPageBody(parentId: string, title: string, markdown: string): Record<string, unknown> {
  return {
    parent: { page_id: parentId },
    properties: { title: { title: [{ text: { content: title } }] } },
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
