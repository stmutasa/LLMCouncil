import { describe, expect, it } from 'vitest';
import { parseMentions } from '../../../shared/mentions';
import { splitMentions } from './mentionSegments';

const members = [
  { id: 'c', name: 'Claude' },
  { id: 'g', name: 'GPT 6.2' },
];

describe('splitMentions', () => {
  it('returns one text segment when there are no mentions', () => {
    expect(splitMentions('Hello there', members)).toEqual([{ kind: 'text', text: 'Hello there' }]);
    expect(splitMentions('', members)).toEqual([]);
  });

  it('marks recognised mentions and keeps the rest as text', () => {
    expect(splitMentions('@claude what do you think?', members)).toEqual([
      { kind: 'mention', text: '@claude', memberId: 'c' },
      { kind: 'text', text: ' what do you think?' },
    ]);
    expect(splitMentions('Ask @gpt62 and @Claude.', members)).toEqual([
      { kind: 'text', text: 'Ask ' },
      { kind: 'mention', text: '@gpt62', memberId: 'g' },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', text: '@Claude', memberId: 'c' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('leaves unknown mentions and e-mail addresses as text', () => {
    expect(splitMentions('mail me@claude.com or @nobody', members)).toEqual([{ kind: 'text', text: 'mail me@claude.com or @nobody' }]);
  });

  it('recognises mentions after brackets and newlines', () => {
    const segments = splitMentions('line\n(@claude)', members);
    expect(segments.filter((s) => s.kind === 'mention')).toHaveLength(1);
    expect(segments.map((s) => s.text).join('')).toBe('line\n(@claude)');
  });

  it('always reassembles to the original text', () => {
    const samples = ['@claude, @gpt62! @x', '  @claude-  hi', '@claude_', 'a@claude @claude@claude'];
    for (const s of samples) expect(splitMentions(s, members).map((x) => x.text).join('')).toBe(s);
  });

  it('agrees with shared parseMentions about which members are mentioned', () => {
    const samples = ['@claude hi', 'cc @gpt62, @claude.', 'none here', 'x@claude', '[@gpt62]'];
    for (const s of samples) {
      const ids = splitMentions(s, members).flatMap((seg) => (seg.kind === 'mention' ? [seg.memberId] : []));
      expect([...new Set(ids)]).toEqual(parseMentions(s, members).memberIds);
    }
  });
});
