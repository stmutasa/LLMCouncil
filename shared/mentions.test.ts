import { describe, expect, it } from 'vitest';
import { mentionHandle, parseMentions } from './mentions';
import { ROUND_TYPE_META, roundTitle } from './defaults';

const members = [
  { id: 'c', name: 'Claude' },
  { id: 'g', name: 'GPT 6.2' },
  { id: 'm', name: 'Gemini' },
];

describe('mentionHandle', () => {
  it('lower-cases and removes everything but letters and digits', () => {
    expect(mentionHandle('GPT 6.2')).toBe('gpt62');
    expect(mentionHandle('Zoë-Bot')).toBe('zoëbot');
    expect(mentionHandle('!!!')).toBe('');
  });
});

describe('parseMentions', () => {
  it('returns the message unchanged when nothing is mentioned', () => {
    expect(parseMentions('  hello @nobody  ', members)).toEqual({ memberIds: [], cleaned: '  hello @nobody  ' });
  });

  it('finds mentions in first-mention order without duplicates and removes them', () => {
    expect(parseMentions('@gemini and @Claude, what about @gemini?', members)).toEqual({
      memberIds: ['m', 'c'],
      cleaned: 'what about?',
    });
  });

  it('matches handles with punctuation removed and keeps sentence punctuation', () => {
    expect(parseMentions('Ask @gpt62. Then decide.', members)).toEqual({ memberIds: ['g'], cleaned: 'Ask. Then decide.' });
  });

  it('ignores e-mail addresses and unknown handles', () => {
    expect(parseMentions('mail me@claude.com', members).memberIds).toEqual([]);
    expect(parseMentions('@claude ask @someone', members)).toEqual({ memberIds: ['c'], cleaned: 'ask @someone' });
  });

  it('strips leading punctuation left behind by a leading mention', () => {
    expect(parseMentions('@claude: what is 2+2?', members)).toEqual({ memberIds: ['c'], cleaned: 'what is 2+2?' });
    expect(parseMentions('(@gemini) hi', members).memberIds).toEqual(['m']);
  });

  it('leaves the rest of the message exactly as typed', () => {
    const code = 'why does this fail?\n```py\ndef f():\n    if x :\n        return 1\n```\nand `ls -la .`';
    expect(parseMentions(`@claude ${code}`, members)).toEqual({ memberIds: ['c'], cleaned: code });
    expect(parseMentions('.env is committed @claude', members).cleaned).toBe('.env is committed');
    expect(parseMentions('. hi @claude', members).cleaned).toBe('. hi');
    expect(parseMentions('a  b @gemini c  d', members).cleaned).toBe('a  b c  d');
  });

  it('tidies only the text touching a removed mention', () => {
    expect(parseMentions('ask @gemini now', members).cleaned).toBe('ask now');
    expect(parseMentions('first line\n@claude second line', members).cleaned).toBe('first line\nsecond line');
    expect(parseMentions('@claude, @gemini: compare X , Y', members)).toEqual({ memberIds: ['c', 'm'], cleaned: 'compare X , Y' });
  });

  it('gives an empty question when only mentions were typed', () => {
    expect(parseMentions('@claude @gemini', members)).toEqual({ memberIds: ['c', 'm'], cleaned: '' });
  });
});

describe('roundTitle', () => {
  it('uses the custom title when set, else the type default', () => {
    expect(roundTitle({ type: 'review', title: '  Cross-exam  ' })).toBe('Cross-exam');
    expect(roundTitle({ type: 'review', title: '   ' })).toBe(ROUND_TYPE_META.review.title);
    expect(roundTitle({ type: 'answer', title: '' })).toBe('Independent answers');
    expect(roundTitle({ type: 'revise', title: '' })).toBe('Rebuttal & revision');
  });
});
