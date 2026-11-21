import type { LeaderboardEntry } from '../../shared/types';

// "FINAL RANKING", optionally wrapped in **, __ or preceded by #s, optionally followed by a colon
// (inside or outside the emphasis).
const MARKER_RE = /(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*FINAL[ \t]+RANKING[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?/gi;
const RESPONSE_LABEL_RE = /\bResponse[ \t]+\**[ \t]*([A-Za-z])(?![A-Za-z0-9])/gi;
const NUMBERED_LINE_RE = /^[ \t]*\d+[ \t]*[.)][ \t]*(?:\*\*|__|\*|_)?[ \t]*([A-Za-z])(?![A-Za-z0-9])/gm;

/**
 * Extracts the ranked labels (best first) from a review. Only the text after the last ranking
 * marker counts, so labels discussed in the critique are never mistaken for a ranking.
 */
export function parseRanking(text: string, validLabels: string[]): string[] | null {
  let lastEnd = -1;
  for (const match of text.matchAll(MARKER_RE)) lastEnd = match.index + match[0].length;
  if (lastEnd < 0) return null;
  const after = text.slice(lastEnd);

  let found = [...after.matchAll(RESPONSE_LABEL_RE)].map((m) => m[1]!.toUpperCase());
  if (found.length === 0) found = [...after.matchAll(NUMBERED_LINE_RE)].map((m) => m[1]!.toUpperCase());

  const valid = new Set(validLabels);
  const ranking: string[] = [];
  for (const label of found) {
    if (valid.has(label) && !ranking.includes(label)) ranking.push(label);
  }
  return ranking.length > 0 ? ranking : null;
}

export interface ReviewerRanking {
  reviewerId: string;
  ranking: string[];
}

export function buildLeaderboard(
  rankings: ReviewerRanking[],
  labels: Record<string, string>,
): LeaderboardEntry[] | null {
  const stats = new Map<string, { sum: number; votes: number; first: number }>();
  for (const { ranking } of rankings) {
    ranking.forEach((label, position) => {
      if (!(label in labels)) return;
      const s = stats.get(label) ?? { sum: 0, votes: 0, first: 0 };
      s.sum += position + 1;
      s.votes += 1;
      if (position === 0) s.first += 1;
      stats.set(label, s);
    });
  }
  if (stats.size === 0) return null;
  const entries: LeaderboardEntry[] = [...stats.entries()].map(([label, s]) => ({
    memberId: labels[label]!,
    label,
    averageRank: Math.round((s.sum / s.votes) * 100) / 100,
    votes: s.votes,
    firstPlaceVotes: s.first,
  }));
  entries.sort(
    (a, b) =>
      a.averageRank - b.averageRank ||
      b.firstPlaceVotes - a.firstPlaceVotes ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  return entries;
}
