import { roundTitle } from '../../../shared/defaults';
import type { CallStatus, MemberSnapshot, RoundResult, Turn } from '../../../shared/types';
import { formatElapsed, msBetween, plural } from './format';

export const FALLBACK_MEMBER_COLOR = '#8e8e8e';

/** Member snapshot by id, with a neutral stand-in for ids the turn does not list. */
export function memberInfo(turn: Turn, memberId: string): MemberSnapshot {
  return (
    turn.members.find((m) => m.id === memberId) ?? {
      id: memberId,
      name: memberId,
      provider: '',
      providerLabel: '',
      model: '',
      effort: '',
      roleId: 'none',
      roleLabel: '',
      color: FALLBACK_MEMBER_COLOR,
    }
  );
}

export function displayRoundTitle(round: RoundResult): string {
  return roundTitle({ type: round.type, title: round.title ?? '' });
}

const FINISHED: ReadonlySet<CallStatus> = new Set(['done', 'error', 'skipped']);

export function isFinishedCall(status: CallStatus): boolean {
  return FINISHED.has(status);
}

/** The round in progress: the running one, else the first pending one; null once all are over. */
export function activeRoundPosition(turn: Turn): number {
  const running = turn.rounds.findIndex((r) => r.status === 'running');
  if (running !== -1) return running;
  return turn.rounds.findIndex((r) => r.status === 'pending');
}

export function isArbiterPhase(turn: Turn): boolean {
  if (!turn.arbiter) return false;
  return turn.arbiter.status !== 'pending' || activeRoundPosition(turn) === -1;
}

/** "Skip to verdict" applies only to council rounds that have not reached the arbiter. */
export function canSkipToVerdict(turn: Turn): boolean {
  return turn.status === 'running' && turn.mode === 'council' && !isArbiterPhase(turn);
}

/** Rounds that actually ran (finished, or had at least one call start before a stop/skip). */
export function roundsRun(turn: Turn): number {
  return turn.rounds.filter((r) => r.status === 'done' || r.responses.some((m) => m.startedAt !== null)).length;
}

export function failedCalls(turn: Turn): number {
  let count = 0;
  for (const r of turn.rounds) for (const m of r.responses) if (m.status === 'error') count++;
  if (turn.arbiter?.status === 'error') count++;
  return count;
}

export type SummaryTone = 'running' | 'done' | 'warning' | 'stopped';

export interface DeliberationSummary {
  text: string;
  tone: SummaryTone;
  /** Elapsed or total time, formatted; '' when unknown. */
  time: string;
}

/** Header line of the deliberation disclosure. `now` is used for the live timer while running. */
export function deliberationSummary(turn: Turn, now: number): DeliberationSummary {
  if (turn.status === 'running') {
    const started = Date.parse(turn.createdAt);
    const time = Number.isNaN(started) ? '' : formatElapsed(now - started);
    if (isArbiterPhase(turn)) return { text: 'Arbiter is writing the verdict', tone: 'running', time };
    const pos = Math.max(0, activeRoundPosition(turn));
    const round = turn.rounds[pos];
    if (!round) return { text: 'Starting the council', tone: 'running', time };
    const done = round.responses.filter((m) => isFinishedCall(m.status)).length;
    return {
      text: `Round ${pos + 1} of ${turn.rounds.length} · ${displayRoundTitle(round)} · ${done} of ${round.responses.length} done`,
      tone: 'running',
      time,
    };
  }

  const duration = msBetween(turn.createdAt, turn.finishedAt);
  const time = duration === null ? '' : formatElapsed(duration);
  const forTime = time ? ` for ${time}` : '';
  const afterTime = time ? ` after ${time}` : '';
  const details = [plural(turn.members.length, 'member'), plural(roundsRun(turn), 'round')];
  const failed = failedCalls(turn);
  if (failed > 0) details.push(`${plural(failed, 'call')} failed`);
  const tail = ` · ${details.join(' · ')}`;

  switch (turn.status) {
    case 'complete':
      return { text: `Council deliberated${forTime}${tail}`, tone: failed > 0 ? 'warning' : 'done', time: '' };
    case 'stopped':
      return { text: `Stopped${afterTime}${tail}`, tone: 'stopped', time: '' };
    case 'interrupted':
      return { text: `Interrupted${afterTime}${tail}`, tone: 'warning', time: '' };
    default:
      return { text: `Deliberation failed${afterTime}${tail}`, tone: 'warning', time: '' };
  }
}

/** Quiet line shown in place of the answer before any final text exists. */
export function answerPlaceholder(turn: Turn): string {
  if (turn.mode === 'direct') {
    const member = turn.members[0];
    return member ? `Waiting for ${member.name}…` : 'Waiting for the answer…';
  }
  return isArbiterPhase(turn) ? 'The arbiter is weighing the answers…' : 'The council is deliberating…';
}

/** How many answers a reviewer was shown in a review round (rankings are requested for ≥ 2). */
export function answersShownTo(round: RoundResult, memberId: string): number {
  const labelled = Object.values(round.labels ?? {});
  const ownIncluded = labelled.includes(memberId);
  return ownIncluded && !round.includeSelf ? labelled.length - 1 : labelled.length;
}

/** Label letter → member id pairs in label order. */
export function sortedLabels(labels: Record<string, string>): [string, string][] {
  return Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

/** The final answer's source line text, e.g. "Final answer · Claude". */
export function finalSourceLabel(turn: Turn): string {
  const src = turn.finalSource;
  switch (src.kind) {
    case 'arbiter':
      return `Final answer · ${src.name}`;
    case 'member':
      return src.name;
    case 'fallback':
      return `Fallback answer · ${src.name}`;
    default:
      if (turn.mode === 'direct') return turn.members[0]?.name ?? 'Answer';
      return turn.arbiter ? `Final answer · ${turn.arbiter.name}` : 'Final answer';
  }
}
