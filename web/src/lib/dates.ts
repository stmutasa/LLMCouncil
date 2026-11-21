import type { ConversationSummary } from '../../../shared/types';

export type DateGroupLabel = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

export interface DateGroup {
  label: DateGroupLabel;
  items: ConversationSummary[];
}

const ORDER: DateGroupLabel[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

function localMidnight(now: Date, daysAgo: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
}

/** Calendar-day bucket in local time. Future timestamps (clock skew) count as today. */
export function dateGroupFor(iso: string, now: Date): DateGroupLabel {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Older';
  if (t >= localMidnight(now, 0)) return 'Today';
  if (t >= localMidnight(now, 1)) return 'Yesterday';
  if (t >= localMidnight(now, 7)) return 'Previous 7 days';
  return 'Older';
}

/** Groups conversations, most recent first within each group; empty groups are omitted. */
export function groupConversations(list: ConversationSummary[], now: Date): DateGroup[] {
  const sorted = [...list].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  const buckets = new Map<DateGroupLabel, ConversationSummary[]>();
  for (const item of sorted) {
    const label = dateGroupFor(item.updatedAt, now);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(item);
    else buckets.set(label, [item]);
  }
  return ORDER.filter((label) => buckets.has(label)).map((label) => ({ label, items: buckets.get(label)! }));
}
