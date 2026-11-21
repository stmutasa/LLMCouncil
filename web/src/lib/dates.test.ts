import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../../../shared/types';
import { dateGroupFor, groupConversations } from './dates';

function local(y: number, m: number, d: number, h = 12, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

function summary(id: string, updatedAt: string): ConversationSummary {
  return { id, title: id, createdAt: updatedAt, updatedAt, turnCount: 1, running: false };
}

const now = new Date(2026, 2, 15, 9, 30); // 15 March 2026, 09:30 local time

describe('dateGroupFor', () => {
  it('buckets by local calendar day', () => {
    expect(dateGroupFor(local(2026, 3, 15, 0, 0), now)).toBe('Today');
    expect(dateGroupFor(local(2026, 3, 14, 23, 59), now)).toBe('Yesterday');
    expect(dateGroupFor(local(2026, 3, 14, 0, 0), now)).toBe('Yesterday');
    expect(dateGroupFor(local(2026, 3, 13, 23, 0), now)).toBe('Previous 7 days');
    expect(dateGroupFor(local(2026, 3, 8, 0, 0), now)).toBe('Previous 7 days');
    expect(dateGroupFor(local(2026, 3, 7, 23, 59), now)).toBe('Older');
  });

  it('crosses month and year boundaries', () => {
    const jan1 = new Date(2026, 0, 1, 8, 0);
    expect(dateGroupFor(local(2025, 12, 31, 22, 0), jan1)).toBe('Yesterday');
    expect(dateGroupFor(local(2025, 12, 26, 12, 0), jan1)).toBe('Previous 7 days');
  });

  it('counts future timestamps as today and invalid ones as older', () => {
    expect(dateGroupFor(local(2026, 3, 16), now)).toBe('Today');
    expect(dateGroupFor('not a date', now)).toBe('Older');
  });
});

describe('groupConversations', () => {
  it('groups in fixed order, sorts newest first and omits empty groups', () => {
    const list = [
      summary('old', local(2025, 1, 1)),
      summary('today-early', local(2026, 3, 15, 1)),
      summary('week', local(2026, 3, 10)),
      summary('today-late', local(2026, 3, 15, 9)),
    ];
    const groups = groupConversations(list, now);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Previous 7 days', 'Older']);
    expect(groups[0]!.items.map((c) => c.id)).toEqual(['today-late', 'today-early']);
    expect(groups[1]!.items.map((c) => c.id)).toEqual(['week']);
    expect(groups[2]!.items.map((c) => c.id)).toEqual(['old']);
  });

  it('returns no groups for an empty list and does not mutate its input', () => {
    expect(groupConversations([], now)).toEqual([]);
    const list = [summary('a', local(2026, 3, 1)), summary('b', local(2026, 3, 15))];
    groupConversations(list, now);
    expect(list.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
