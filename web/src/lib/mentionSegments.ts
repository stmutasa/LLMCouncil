import { mentionHandle } from '../../../shared/mentions';

export type MessageSegment = { kind: 'text'; text: string } | { kind: 'mention'; text: string; memberId: string };

/** Same grammar as shared/mentions.ts: a mention starts the text or follows whitespace/an opening bracket. */
const MENTION_RE = /(^|[\s([{])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;

/**
 * Splits a user message into plain text and recognised @mentions, for rendering mentions as
 * chips. Unrecognised mentions stay plain text; trailing sentence punctuation is not part of
 * the chip ("@claude," → chip "@claude" + ",").
 */
export function splitMentions(message: string, members: { id: string; name: string }[]): MessageSegment[] {
  const byHandle = new Map<string, string>();
  for (const m of members) {
    const handle = mentionHandle(m.name);
    if (handle && !byHandle.has(handle)) byHandle.set(handle, m.id);
  }
  const segments: MessageSegment[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.kind === 'text') prev.text += text;
    else segments.push({ kind: 'text', text });
  };
  for (const match of message.matchAll(MENTION_RE)) {
    const lead = match[1]!;
    const token = match[2]!;
    const trailing = /[._-]+$/.exec(token)?.[0] ?? '';
    const core = trailing ? token.slice(0, -trailing.length) : token;
    const id = byHandle.get(mentionHandle(core));
    if (!id) continue;
    const at = match.index + lead.length;
    pushText(message.slice(last, at));
    segments.push({ kind: 'mention', text: `@${core}`, memberId: id });
    last = at + 1 + core.length;
  }
  pushText(message.slice(last));
  return segments;
}
