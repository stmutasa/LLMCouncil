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
  /** The message with recognised mentions removed. Everything else is left exactly as typed. */
  cleaned: string;
}

/** A mention must start the text or follow whitespace/an opening bracket, so emails are ignored. */
const MENTION_RE = /(^|[\s([{])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;

/** Nothing but whitespace and the words that join a list of mentions ("@a and @b, …"). */
const ONLY_JOINERS_RE = /^\s*(?:(?:and|&|,)\s*)*$/i;

const SPACES_AFTER_RE = /^[ \t]+/;
const SEPARATOR_AFTER_RE = /^[ \t]*[,:;]?[ \t]*/;
const SPACES_BEFORE_RE = /[ \t]+$/;

export function parseMentions(message: string, members: MentionTarget[]): ParsedMentions {
  const byHandle = new Map<string, string>();
  for (const m of members) {
    const handle = mentionHandle(m.name);
    if (handle && !byHandle.has(handle)) byHandle.set(handle, m.id);
  }

  const memberIds: string[] = [];
  let out = '';
  let cursor = 0;
  const skip = (re: RegExp) => {
    cursor += re.exec(message.slice(cursor))?.[0].length ?? 0;
  };

  for (const match of message.matchAll(MENTION_RE)) {
    const lead = match[1]!;
    const token = match[2]!;
    // Trailing punctuation such as "@claude," or "@claude." belongs to the sentence.
    const trailing = /[._-]+$/.exec(token)?.[0] ?? '';
    const core = trailing ? token.slice(0, -trailing.length) : token;
    const id = byHandle.get(mentionHandle(core));
    if (!id) continue;
    if (!memberIds.includes(id)) memberIds.push(id);

    const at = match.index + lead.length;
    out += message.slice(cursor, at);
    cursor = at + 1 + core.length;

    // Only the text touching the removed mention is tidied. The rest of the message, such as
    // code or deliberate spacing, must reach the models exactly as the user typed it.
    const next = message[cursor];
    if (ONLY_JOINERS_RE.test(out)) {
      // The message opens with mentions: the question starts after them and their separator.
      out = '';
      skip(SEPARATOR_AFTER_RE);
    } else if (out.endsWith('\n')) {
      skip(SPACES_AFTER_RE);
    } else if (next === undefined || /[\s,.;:!?)\]}]/.test(next)) {
      // "what about @gemini?" -> "what about?", "ask @gemini now" -> "ask now"
      out = out.replace(SPACES_BEFORE_RE, '');
    }
  }

  if (memberIds.length === 0) return { memberIds, cleaned: message };
  return { memberIds, cleaned: (out + message.slice(cursor)).trim() };
}
