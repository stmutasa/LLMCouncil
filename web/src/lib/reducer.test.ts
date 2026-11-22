import { describe, expect, it } from 'vitest';
import { ARBITER_MARKER } from '../../../shared/arbiter';
import type { RunEvent, Turn } from '../../../shared/types';
import { applyRunEvent, applyRunEvents } from './reducer';
import { arbiter, councilTurn, directTurn, excerpt, library, response, round } from './testFixtures';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

describe('applyRunEvent', () => {
  it('marks the library phase running on library.start', () => {
    const turn = deepFreeze(councilTurn({ library: library({ status: 'pending' }) }));
    const next = applyRunEvent(turn, { type: 'library.start' });
    expect(next.library!.status).toBe('running');
    expect(next.rounds).toBe(turn.rounds);
    expect(applyRunEvent(next, { type: 'library.start' })).toBe(next);
  });

  it('ignores library.start for turns without a library', () => {
    const turn = deepFreeze(councilTurn());
    expect(applyRunEvent(turn, { type: 'library.start' })).toBe(turn);
  });

  it('replaces the library on library.end', () => {
    const turn = deepFreeze(councilTurn({ library: library({ status: 'running' }) }));
    const done = library({ status: 'done', queries: ['q'], excerpts: [excerpt('S1', 'a')] });
    const next = applyRunEvent(turn, { type: 'library.end', library: done });
    expect(next.library).toBe(done);
    expect(next.arbiter).toBe(turn.arbiter);
  });

  it('replaces the turn on snapshot and turn.end', () => {
    const turn = deepFreeze(councilTurn());
    const replacement = councilTurn({ finalText: 'done', status: 'complete' });
    expect(applyRunEvent(turn, { type: 'snapshot', turn: replacement })).toBe(replacement);
    expect(applyRunEvent(turn, { type: 'turn.end', turn: replacement })).toBe(replacement);
  });

  it('marks a round running on round.start and leaves other rounds untouched', () => {
    const turn = deepFreeze(councilTurn());
    const next = applyRunEvent(turn, { type: 'round.start', round: 1 });
    expect(next.rounds[1]!.status).toBe('running');
    expect(next.rounds[0]).toBe(turn.rounds[0]);
    expect(next.arbiter).toBe(turn.arbiter);
  });

  it('marks a call running on member.start', () => {
    const turn = deepFreeze(councilTurn());
    const next = applyRunEvent(turn, { type: 'member.start', round: 0, memberId: 'b', startedAt: '2026-01-01T10:00:01.000Z' });
    const b = next.rounds[0]!.responses[1]!;
    expect(b.status).toBe('running');
    expect(b.startedAt).toBe('2026-01-01T10:00:01.000Z');
    expect(next.rounds[0]!.responses[0]).toBe(turn.rounds[0]!.responses[0]);
    expect(next.rounds[1]).toBe(turn.rounds[1]);
  });

  it('appends and replaces member text per the replace flag', () => {
    let turn: Turn = deepFreeze(councilTurn());
    turn = applyRunEvent(turn, { type: 'member.delta', round: 0, memberId: 'a', text: 'Hello', replace: false });
    turn = applyRunEvent(turn, { type: 'member.delta', round: 0, memberId: 'a', text: ' world', replace: false });
    expect(turn.rounds[0]!.responses[0]!.text).toBe('Hello world');
    turn = applyRunEvent(turn, { type: 'member.delta', round: 0, memberId: 'a', text: 'Fresh', replace: true });
    expect(turn.rounds[0]!.responses[0]!.text).toBe('Fresh');
    turn = applyRunEvent(turn, { type: 'member.delta', round: 0, memberId: 'a', text: '', replace: true });
    expect(turn.rounds[0]!.responses[0]!.text).toBe('');
  });

  it('does not mirror member text into finalText in council mode', () => {
    const turn = deepFreeze(councilTurn());
    const next = applyRunEvent(turn, { type: 'member.delta', round: 0, memberId: 'a', text: 'x', replace: false });
    expect(next.finalText).toBe('');
  });

  it('sets and clears activity', () => {
    let turn: Turn = deepFreeze(councilTurn());
    turn = applyRunEvent(turn, { type: 'member.activity', round: 0, memberId: 'c', activity: 'Thinking…' });
    expect(turn.rounds[0]!.responses[2]!.activity).toBe('Thinking…');
    const same = applyRunEvent(turn, { type: 'member.activity', round: 0, memberId: 'c', activity: 'Thinking…' });
    expect(same).toBe(turn);
    turn = applyRunEvent(turn, { type: 'member.activity', round: 0, memberId: 'c', activity: '' });
    expect(turn.rounds[0]!.responses[2]!.activity).toBe('');
  });

  it('replaces the response wholesale on member.end', () => {
    let turn: Turn = deepFreeze(councilTurn());
    turn = applyRunEvent(turn, { type: 'member.delta', round: 0, memberId: 'a', text: 'partial', replace: false });
    const final = response('a', { status: 'error', text: 'authoritative', error: 'boom', durationMs: 1200 });
    const next = applyRunEvent(turn, { type: 'member.end', round: 0, response: final });
    expect(next.rounds[0]!.responses[0]).toBe(final);
    expect(next.rounds[0]!.responses[1]).toBe(turn.rounds[0]!.responses[1]);
  });

  it('replaces the round wholesale on round.end', () => {
    const turn = deepFreeze(councilTurn());
    const result = round(1, 'review', ['a', 'b', 'c'], {
      status: 'done',
      labels: { A: 'b', B: 'a', C: 'c' },
      leaderboard: [{ memberId: 'b', label: 'A', averageRank: 1, votes: 2, firstPlaceVotes: 2 }],
    });
    const next = applyRunEvent(turn, { type: 'round.end', round: 1, result });
    expect(next.rounds[1]).toBe(result);
    expect(next.rounds[0]).toBe(turn.rounds[0]);
  });

  it('ignores unknown rounds and members without throwing', () => {
    const turn = deepFreeze(councilTurn());
    const events: RunEvent[] = [
      { type: 'round.start', round: 9 },
      { type: 'round.end', round: 9, result: round(9, 'answer', []) },
      { type: 'member.start', round: 0, memberId: 'zzz', startedAt: 'x' },
      { type: 'member.delta', round: 0, memberId: 'zzz', text: 'x', replace: false },
      { type: 'member.delta', round: 7, memberId: 'a', text: 'x', replace: false },
      { type: 'member.activity', round: 0, memberId: 'zzz', activity: 'x' },
      { type: 'member.end', round: 0, response: response('zzz', { status: 'done' }) },
      { type: 'member.end', round: 5, response: response('a', { status: 'done' }) },
    ];
    expect(applyRunEvents(turn, events)).toBe(turn);
  });

  it('ignores an unknown event type', () => {
    const turn = deepFreeze(councilTurn());
    expect(applyRunEvent(turn, { type: 'future.event' } as unknown as RunEvent)).toBe(turn);
  });

  it('finds rounds by their index field, not their array position', () => {
    const turn = deepFreeze(councilTurn({ rounds: [round(1, 'answer', ['a']), round(2, 'review', ['a'])] }));
    const next = applyRunEvent(turn, { type: 'member.delta', round: 2, memberId: 'a', text: 'review', replace: false });
    expect(next.rounds[1]!.responses[0]!.text).toBe('review');
    expect(next.rounds[0]).toBe(turn.rounds[0]);
  });

  describe('direct mode', () => {
    it('mirrors the member text into finalText as it streams and on member.end', () => {
      let turn: Turn = deepFreeze(directTurn());
      turn = applyRunEvent(turn, { type: 'member.delta', round: 0, memberId: 'a', text: 'Hi', replace: false });
      expect(turn.finalText).toBe('Hi');
      turn = applyRunEvent(turn, { type: 'member.delta', round: 0, memberId: 'a', text: ' there', replace: false });
      expect(turn.finalText).toBe('Hi there');
      turn = applyRunEvent(turn, { type: 'member.delta', round: 0, memberId: 'a', text: 'Restart', replace: true });
      expect(turn.finalText).toBe('Restart');
      turn = applyRunEvent(turn, { type: 'member.end', round: 0, response: response('a', { status: 'done', text: 'Final' }) });
      expect(turn.finalText).toBe('Final');
    });

    it('ignores arbiter events because there is no arbiter', () => {
      const turn = deepFreeze(directTurn());
      const events: RunEvent[] = [
        { type: 'arbiter.start', startedAt: 'x' },
        { type: 'arbiter.delta', text: 'x', replace: false },
        { type: 'arbiter.activity', activity: 'x' },
        { type: 'arbiter.end', arbiter: arbiter({ status: 'done' }), analysisText: 'a', finalText: 'f' },
      ];
      expect(applyRunEvents(turn, events)).toBe(turn);
    });
  });

  describe('arbiter', () => {
    it('marks the arbiter running on arbiter.start', () => {
      const turn = deepFreeze(councilTurn());
      const next = applyRunEvent(turn, { type: 'arbiter.start', startedAt: '2026-01-01T10:01:00.000Z' });
      expect(next.arbiter!.status).toBe('running');
      expect(next.arbiter!.startedAt).toBe('2026-01-01T10:01:00.000Z');
      expect(next.rounds).toBe(turn.rounds);
    });

    it('splits streaming output into analysis and final answer, never showing the marker', () => {
      let turn: Turn = deepFreeze(councilTurn());
      const chunks = ['## Council analysis\n\n**Consensus:** all agree.\n', '===FIN', `AL ANSWER===\n`, 'The answer', ' is 42.'];
      const seen: { analysis: string; final: string }[] = [];
      for (const text of chunks) {
        turn = applyRunEvent(turn, { type: 'arbiter.delta', text, replace: false });
        seen.push({ analysis: turn.analysisText, final: turn.finalText });
      }
      expect(seen[0]).toEqual({ analysis: '**Consensus:** all agree.', final: '' });
      // A partly written marker is hidden from the analysis.
      expect(seen[1]!.analysis).toBe('**Consensus:** all agree.');
      expect(seen[1]!.analysis).not.toContain('=');
      expect(seen[2]).toEqual({ analysis: '**Consensus:** all agree.', final: '' });
      expect(seen[4]).toEqual({ analysis: '**Consensus:** all agree.', final: 'The answer is 42.' });
      for (const s of seen) {
        expect(s.analysis).not.toContain(ARBITER_MARKER);
        expect(s.final).not.toContain(ARBITER_MARKER);
      }
      expect(turn.arbiter!.text).toBe(chunks.join(''));
    });

    it('treats all text as the final answer when analysis is disabled', () => {
      let turn: Turn = deepFreeze(councilTurn({ arbiter: arbiter({ analysisEnabled: false }) }));
      turn = applyRunEvent(turn, { type: 'arbiter.delta', text: 'Straight ', replace: false });
      turn = applyRunEvent(turn, { type: 'arbiter.delta', text: 'answer', replace: false });
      expect(turn.finalText).toBe('Straight answer');
      expect(turn.analysisText).toBe('');
    });

    it('re-splits from scratch on a replace delta', () => {
      let turn: Turn = deepFreeze(councilTurn());
      turn = applyRunEvent(turn, { type: 'arbiter.delta', text: `old\n${ARBITER_MARKER}\nold final`, replace: false });
      expect(turn.finalText).toBe('old final');
      turn = applyRunEvent(turn, { type: 'arbiter.delta', text: 'new analysis', replace: true });
      expect(turn.analysisText).toBe('new analysis');
      expect(turn.finalText).toBe('');
    });

    it('takes analysis and final text from arbiter.end verbatim', () => {
      let turn: Turn = deepFreeze(councilTurn());
      turn = applyRunEvent(turn, { type: 'arbiter.delta', text: 'streamed without marker', replace: false });
      const done = arbiter({ status: 'done', text: 'streamed without marker' });
      turn = applyRunEvent(turn, { type: 'arbiter.end', arbiter: done, analysisText: '', finalText: 'streamed without marker' });
      expect(turn.arbiter).toBe(done);
      expect(turn.analysisText).toBe('');
      expect(turn.finalText).toBe('streamed without marker');
    });

    it('sets arbiter activity', () => {
      const turn = deepFreeze(councilTurn());
      const next = applyRunEvent(turn, { type: 'arbiter.activity', activity: 'Searching the web…' });
      expect(next.arbiter!.activity).toBe('Searching the web…');
    });
  });

  it('replays a whole council run to the authoritative end state', () => {
    const start = deepFreeze(councilTurn());
    const end = councilTurn({ status: 'complete', finalText: 'F', finalSource: { kind: 'arbiter', name: 'Judge', memberId: null } });
    const events: RunEvent[] = [
      { type: 'snapshot', turn: start },
      { type: 'round.start', round: 0 },
      { type: 'member.start', round: 0, memberId: 'a', startedAt: 's' },
      { type: 'member.delta', round: 0, memberId: 'a', text: 'A1', replace: false },
      { type: 'member.end', round: 0, response: response('a', { status: 'done', text: 'A1' }) },
      { type: 'round.end', round: 0, result: round(0, 'answer', ['a'], { status: 'done' }) },
      { type: 'arbiter.start', startedAt: 's' },
      { type: 'arbiter.delta', text: 'x', replace: false },
      { type: 'turn.end', turn: end },
    ];
    expect(applyRunEvents(start, events)).toBe(end);
  });
});
