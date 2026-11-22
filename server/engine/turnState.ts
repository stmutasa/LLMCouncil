import type { Turn } from '../../shared/types';

export const INTERRUPTED_MESSAGE = 'The server stopped while this turn was running.';

/**
 * Closes everything still open in a turn that is ending: calls that never finished become
 * 'skipped', rounds that ran become 'done', rounds that never started become 'skipped', and an
 * unfinished library search becomes an error.
 */
export function settleOpenParts(turn: Turn): void {
  for (const round of turn.rounds) {
    for (const r of round.responses) {
      if (r.status === 'pending' || r.status === 'running') {
        r.status = 'skipped';
        r.activity = '';
      }
    }
    if (round.status === 'running') round.status = 'done';
    else if (round.status === 'pending') round.status = 'skipped';
  }
  if (turn.library && (turn.library.status === 'pending' || turn.library.status === 'running')) {
    turn.library.status = 'error';
    turn.library.error = turn.library.error ?? 'The library search did not finish.';
  }
  if (turn.arbiter && (turn.arbiter.status === 'pending' || turn.arbiter.status === 'running')) {
    turn.arbiter.status = 'skipped';
    turn.arbiter.activity = '';
  }
}

/** Marks a turn that was persisted as running, but has no live run, as interrupted. */
export function markInterrupted(turn: Turn, now = new Date()): void {
  settleOpenParts(turn);
  turn.status = 'interrupted';
  turn.error = INTERRUPTED_MESSAGE;
  turn.finishedAt = turn.finishedAt ?? now.toISOString();
}
