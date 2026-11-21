import type { LeaderboardEntry } from '../../shared/types';

// "FINAL RANKING" at the start of a line, optionally decorated (#s, **, __, a quote mark) and
// followed by a colon. The rest of the line must be empty or begin the list itself, so prose
// such as "This final ranking reflects accuracy." is not taken for the marker.
const MARKER_RE =
  /^[ \t>]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*FINAL[ \t]+RANKING[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*(?=$|\d|[-*•][ \t]|(?:\*\*|__)?Response\b)/gim;
// An item number at the start of a line, or after a comma/semicolon in a one-line list.
const ITEM_NUMBER_RE = /(?:^|[,;])[ \t>]*\d+[ \t]*[.):]/gm;
// "1. C" on a line of its own.
const NUMBERED_BARE_RE = /^[ \t>]*\d+[ \t]*[.):][ \t]*(?:\*\*|__|\*|_)?[ \t]*([A-Za-z])(?:\*\*|__|\*|_)?[ \t]*[.,;]?[ \t]*$/gm;
const RESPONSE_LABEL_RE = /\bResponse[ \t]+\**[ \t]*([A-Za-z])(?![A-Za-z0-9])/gi;
const FIRST_RESPONSE_LABEL_RE = /\bResponse[ \t]+\**[ \t]*([A-Za-z])(?![A-Za-z0-9])/i;

function labels(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]!.toUpperCase());
}

/**
 * The first label of each numbered item. A label mentioned later in the same item
 * ("1. Response C (better than Response B)") is commentary, not a rank.
 */
function numberedItemLabels(section: string): string[] {
  const items = [...section.matchAll(ITEM_NUMBER_RE)];
  const found: string[] = [];
  items.forEach((item, i) => {
    const from = item.index + item[0].length;
    const to = i + 1 < items.length ? items[i + 1]!.index : section.length;
    const label = FIRST_RESPONSE_LABEL_RE.exec(section.slice(from, to))?.[1];
    if (label) found.push(label.toUpperCase());
  });
  return found;
}

/**
 * Extracts the ranked labels (best first) from a review. Only the text after the last ranking
 * marker counts, so labels discussed in the critique are never mistaken for a ranking.
 */
export function parseRanking(text: string, validLabels: string[]): string[] | null {
  let lastEnd = -1;
  for (const match of text.matchAll(MARKER_RE)) lastEnd = match.index + match[0].length;
  if (lastEnd < 0) return null;
  const after = text.slice(lastEnd);

  // Numbered items first; an unnumbered list ("- Response C", "C > A > B") is the last resort.
  let found = numberedItemLabels(after);
  if (found.length === 0) found = labels(after, NUMBERED_BARE_RE);
  if (found.length === 0) found = labels(after, RESPONSE_LABEL_RE);

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
