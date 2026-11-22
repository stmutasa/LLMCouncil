import { splitArbiterOutput } from '../../../shared/arbiter';
import type { ArbiterResult, MemberResponse, RoundResult, RunEvent, Turn } from '../../../shared/types';

/**
 * Applies one server-sent run event to a turn and returns the new turn.
 *
 * Pure and structurally sharing: objects the event does not touch keep their identity, so
 * memoised components for finished rounds and messages do not re-render. Authoritative events
 * (snapshot, member.end, round.end, arbiter.end, turn.end) replace state wholesale. Events that
 * name a round or member the turn does not have are ignored.
 */
export function applyRunEvent(turn: Turn, event: RunEvent): Turn {
  switch (event.type) {
    case 'snapshot':
    case 'turn.end':
      return event.turn;

    case 'library.start':
      if (!turn.library || turn.library.status === 'running') return turn;
      return { ...turn, library: { ...turn.library, status: 'running' } };

    case 'library.end':
      return { ...turn, library: event.library };

    case 'round.start':
      return updateRound(turn, event.round, (r) => (r.status === 'running' ? r : { ...r, status: 'running' }));

    case 'round.end':
      return updateRound(turn, event.round, () => event.result);

    case 'member.start':
      return updateResponse(turn, event.round, event.memberId, (m) => ({
        ...m,
        status: 'running',
        startedAt: event.startedAt,
      }));

    case 'member.delta': {
      const next = updateResponse(turn, event.round, event.memberId, (m) => ({
        ...m,
        text: event.replace ? event.text : m.text + event.text,
      }));
      return mirrorDirect(next, event.round, event.memberId);
    }

    case 'member.activity':
      return updateResponse(turn, event.round, event.memberId, (m) =>
        m.activity === event.activity ? m : { ...m, activity: event.activity },
      );

    case 'member.end': {
      const next = updateResponse(turn, event.round, event.response.memberId, () => event.response);
      return mirrorDirect(next, event.round, event.response.memberId);
    }

    case 'arbiter.start':
      return updateArbiter(turn, (a) => ({ ...a, status: 'running', startedAt: event.startedAt }));

    case 'arbiter.delta': {
      if (!turn.arbiter) return turn;
      const text = event.replace ? event.text : turn.arbiter.text + event.text;
      const split = splitArbiterOutput(text, turn.arbiter.analysisEnabled, false);
      return {
        ...turn,
        arbiter: { ...turn.arbiter, text },
        analysisText: split.analysis,
        finalText: split.final,
      };
    }

    case 'arbiter.activity':
      return updateArbiter(turn, (a) => (a.activity === event.activity ? a : { ...a, activity: event.activity }));

    case 'arbiter.end':
      if (!turn.arbiter) return turn;
      return { ...turn, arbiter: event.arbiter, analysisText: event.analysisText, finalText: event.finalText };

    default:
      return turn;
  }
}

/** Applies events in order; convenient for batches collected between animation frames. */
export function applyRunEvents(turn: Turn, events: readonly RunEvent[]): Turn {
  let next = turn;
  for (const event of events) next = applyRunEvent(next, event);
  return next;
}

function updateRound(turn: Turn, roundIndex: number, fn: (round: RoundResult) => RoundResult): Turn {
  const pos = turn.rounds.findIndex((r) => r.index === roundIndex);
  if (pos === -1) return turn;
  const current = turn.rounds[pos]!;
  const updated = fn(current);
  if (updated === current) return turn;
  const rounds = turn.rounds.slice();
  rounds[pos] = updated;
  return { ...turn, rounds };
}

function updateResponse(
  turn: Turn,
  roundIndex: number,
  memberId: string,
  fn: (response: MemberResponse) => MemberResponse,
): Turn {
  return updateRound(turn, roundIndex, (round) => {
    const pos = round.responses.findIndex((m) => m.memberId === memberId);
    if (pos === -1) return round;
    const current = round.responses[pos]!;
    const updated = fn(current);
    if (updated === current) return round;
    const responses = round.responses.slice();
    responses[pos] = updated;
    return { ...round, responses };
  });
}

function updateArbiter(turn: Turn, fn: (arbiter: ArbiterResult) => ArbiterResult): Turn {
  if (!turn.arbiter) return turn;
  const updated = fn(turn.arbiter);
  return updated === turn.arbiter ? turn : { ...turn, arbiter: updated };
}

/** Direct mode shows the single member's text as the answer while it streams. */
function mirrorDirect(turn: Turn, roundIndex: number, memberId: string): Turn {
  if (turn.mode !== 'direct') return turn;
  const response = turn.rounds.find((r) => r.index === roundIndex)?.responses.find((m) => m.memberId === memberId);
  if (!response || response.text === turn.finalText) return turn;
  return { ...turn, finalText: response.text };
}
