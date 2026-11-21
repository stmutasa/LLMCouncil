/**
 * @mentions direct a message at specific council members: "@gemini what do you think?".
 * A member's handle is its name lower-cased with everything except letters and digits removed,
 * so "GPT 6.2" is addressed as "@gpt62".
 */

export function mentionHandle(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export interface MentionTarget {
  id: string;
  name: string;
}

export interface ParsedMentions {
  /** Ids of the mentioned members, in first-mention order, without duplicates. */
  memberIds: string[];
  /** The message with recognised mentions removed and whitespace tidied. */
  cleaned: string;
}

/** A mention must start the text or follow whitespace/an opening bracket, so emails are ignored. */
const MENTION_RE = /(^|[\s([{])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;

export function parseMentions(message: string, members: MentionTarget[]): ParsedMentions {
  const byHandle = new Map<string, string>();
  for (const m of members) {
    const handle = mentionHandle(m.name);
    if (handle && !byHandle.has(handle)) byHandle.set(handle, m.id);
  }

  const memberIds: string[] = [];
  const cleaned = message.replace(MENTION_RE, (whole: string, lead: string, token: string) => {
    // Trailing punctuation such as "@claude," or "@claude." belongs to the sentence.
    const trailing = /[._-]+$/.exec(token)?.[0] ?? '';
    const core = trailing ? token.slice(0, -trailing.length) : token;
    const id = byHandle.get(mentionHandle(core));
    if (!id) return whole;
    if (!memberIds.includes(id)) memberIds.push(id);
    return lead + trailing;
  });

  if (memberIds.length === 0) return { memberIds, cleaned: message };
  return {
    memberIds,
    cleaned: cleaned
      .replace(/[ \t]{2,}/g, ' ')
      // "@a and @b, what…" leaves "and , what…": close the gap before punctuation.
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .replace(/^[ \t]*(?:and\b[ \t]*)?[,:;.]+[ \t]*/i, '')
      .trim(),
  };
}
