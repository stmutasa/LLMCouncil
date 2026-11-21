import { describe, expect, it } from 'vitest';
import { buildLeaderboard, parseRanking } from './ranking';

const ABC = ['A', 'B', 'C'];

describe('parseRanking', () => {
  it('reads the standard block', () => {
    expect(parseRanking('Critique.\n\nFINAL RANKING:\n1. Response B\n2. Response A\n3. Response C', ABC)).toEqual(['B', 'A', 'C']);
  });

  it.each([
    '**FINAL RANKING:**',
    '**FINAL RANKING**:',
    '## FINAL RANKING',
    '### **Final Ranking:**',
    'final ranking',
    '__FINAL RANKING__',
  ])('tolerates the decorated marker %j', (marker) => {
    expect(parseRanking(`text\n${marker}\n1. **Response C**\n2. Response A`, ABC)).toEqual(['C', 'A']);
  });

  it('uses the last marker and ignores labels discussed before it', () => {
    const text =
      'Response A is best. The FINAL RANKING below reflects this.\nFINAL RANKING:\n1. Response A\n\nOn reflection:\nFINAL RANKING:\n1. Response C\n2. Response B\n3. Response A';
    expect(parseRanking(text, ABC)).toEqual(['C', 'B', 'A']);
  });

  it('drops duplicates (first wins) and labels the reviewer was not shown', () => {
    expect(parseRanking('FINAL RANKING:\n1. Response B\n2. Response D\n3. Response B\n4. Response A', ABC)).toEqual(['B', 'A']);
    expect(parseRanking('FINAL RANKING:\n1. Response A\n2. Response B', ['B', 'C'])).toEqual(['B']);
  });

  it('is case-insensitive about the label word and letter', () => {
    expect(parseRanking('final ranking:\n1. response c\n2. RESPONSE a', ABC)).toEqual(['C', 'A']);
  });

  it('accepts bare numbered lines when no "Response X" appears', () => {
    expect(parseRanking('FINAL RANKING:\n1. C\n2) **A**\n3. B', ABC)).toEqual(['C', 'A', 'B']);
  });

  it('does not take words for labels', () => {
    expect(parseRanking('FINAL RANKING:\n1. Apples are best\n2. Bananas', ABC)).toBeNull();
    expect(parseRanking('FINAL RANKING:\n1. Response Alpha', ABC)).toBeNull();
  });

  it('returns null without a marker, never guessing from the critique', () => {
    expect(parseRanking('Response A is better than Response B.', ABC)).toBeNull();
    expect(parseRanking('', ABC)).toBeNull();
  });

  it('returns null when nothing valid follows the marker', () => {
    expect(parseRanking('FINAL RANKING:\nI cannot decide.', ABC)).toBeNull();
    expect(parseRanking('FINAL RANKING:\n1. Response Z', ABC)).toBeNull();
  });
});

describe('buildLeaderboard', () => {
  const labels = { A: 'm-a', B: 'm-b', C: 'm-c' };

  it('computes average rank, votes and first-place votes, sorted best first', () => {
    const board = buildLeaderboard(
      [
        { reviewerId: 'r1', ranking: ['B', 'A', 'C'] },
        { reviewerId: 'r2', ranking: ['A', 'B', 'C'] },
        { reviewerId: 'r3', ranking: ['B', 'C', 'A'] },
      ],
      labels,
    );
    expect(board).toEqual([
      { memberId: 'm-b', label: 'B', averageRank: 1.33, votes: 3, firstPlaceVotes: 2 },
      { memberId: 'm-a', label: 'A', averageRank: 2, votes: 3, firstPlaceVotes: 1 },
      { memberId: 'm-c', label: 'C', averageRank: 2.67, votes: 3, firstPlaceVotes: 0 },
    ]);
  });

  it('breaks ties by first-place votes, then by label', () => {
    const tieFirst = buildLeaderboard(
      [
        { reviewerId: 'r1', ranking: ['B', 'A'] },
        { reviewerId: 'r2', ranking: ['C', 'B'] },
        { reviewerId: 'r3', ranking: ['A', 'C'] },
      ],
      labels,
    );
    // Every label averages 1.5 with one first place: alphabetical.
    expect(tieFirst!.map((e) => e.label)).toEqual(['A', 'B', 'C']);

    const byFirst = buildLeaderboard(
      [
        { reviewerId: 'r1', ranking: ['A', 'B', 'C'] },
        { reviewerId: 'r2', ranking: ['C', 'B', 'A'] },
      ],
      labels,
    );
    // All average 2; A and C have a first place each (alphabetical between them), B has none.
    expect(byFirst!.map((e) => [e.label, e.averageRank, e.firstPlaceVotes])).toEqual([
      ['A', 2, 1],
      ['C', 2, 1],
      ['B', 2, 0],
    ]);
  });

  it('omits labels nobody ranked and labels outside the map', () => {
    const board = buildLeaderboard([{ reviewerId: 'r1', ranking: ['C', 'Z'] }], labels);
    expect(board).toEqual([{ memberId: 'm-c', label: 'C', averageRank: 1, votes: 1, firstPlaceVotes: 1 }]);
  });

  it('returns null without rankings', () => {
    expect(buildLeaderboard([], labels)).toBeNull();
  });
});

describe('parseRanking with reviewer wording around the list', () => {
  const valid = ['A', 'B', 'C'];
  const cases: [string, string, string[] | null][] = [
    [
      'prose after the list that repeats the words "final ranking"',
      'FINAL RANKING:\n1. Response C\n2. Response A\n3. Response B\n\nThis final ranking reflects accuracy.',
      ['C', 'A', 'B'],
    ],
    [
      'another label mentioned as commentary on an item',
      'FINAL RANKING:\n1. Response C (better than Response B)\n2. Response A\n3. Response B',
      ['C', 'A', 'B'],
    ],
    ['a one-line list', 'FINAL RANKING: 1. Response A, 2. Response B, 3. Response C', ['A', 'B', 'C']],
    ['an item whose label is not its first word', 'FINAL RANKING:\n1. A thorough answer wins: Response B\n2. Response A', ['B', 'A']],
    ['a quoted block', '> FINAL RANKING:\n> 1. Response C\n> 2. Response B', ['C', 'B']],
    ['an unnumbered chain', 'FINAL RANKING:\nResponse B > Response A > Response C', ['B', 'A', 'C']],
    ['Windows line endings', 'FINAL RANKING:\r\n1. Response C\r\n2. Response A\r\n', ['C', 'A']],
    ['the words in prose only', 'My final ranking is hard to give.\nResponse A, then Response B.', null],
  ];
  it.each(cases)('handles %s', (_name, text, expected) => {
    expect(parseRanking(text, valid)).toEqual(expected);
  });
});
