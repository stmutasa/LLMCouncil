import { describe, expect, it } from 'vitest';
import {
  answerPlaceholder,
  answersShownTo,
  canSkipToVerdict,
  deliberationSummary,
  failedCalls,
  finalSourceLabel,
  isArbiterPhase,
  memberInfo,
  roundsRun,
  sortedLabels,
} from './turn';
import { arbiter, councilTurn, directTurn, response, round } from './testFixtures';

const START = Date.parse('2026-01-01T10:00:00.000Z');

describe('deliberationSummary', () => {
  it('describes the running round with progress and a live timer', () => {
    const turn = councilTurn({
      rounds: [
        round(0, 'answer', ['a', 'b', 'c'], {
          status: 'running',
          responses: [response('a', { status: 'done' }), response('b', { status: 'error' }), response('c', { status: 'running' })],
        }),
        round(1, 'review', ['a', 'b', 'c']),
      ],
    });
    expect(deliberationSummary(turn, START + 42_000)).toEqual({
      text: 'Round 1 of 2 · Independent answers · 2 of 3 done',
      tone: 'running',
      time: '42s',
    });
  });

  it('uses a custom round title', () => {
    const turn = councilTurn({ rounds: [round(0, 'answer', ['a'], { status: 'running', title: 'Opening statements' })] });
    expect(deliberationSummary(turn, START).text).toBe('Round 1 of 1 · Opening statements · 0 of 1 done');
  });

  it('reports the arbiter phase', () => {
    const turn = councilTurn({
      rounds: [round(0, 'answer', ['a'], { status: 'done' })],
      arbiter: arbiter({ status: 'running' }),
    });
    expect(deliberationSummary(turn, START + 1000).text).toBe('Arbiter is writing the verdict');
  });

  it('summarises a finished council', () => {
    const turn = councilTurn({
      status: 'complete',
      finishedAt: '2026-01-01T10:01:12.000Z',
      rounds: [
        round(0, 'answer', ['a'], { status: 'done', responses: [response('a', { status: 'done', startedAt: 'x' })] }),
        round(1, 'review', ['a'], { status: 'done' }),
      ],
    });
    expect(deliberationSummary(turn, 0)).toEqual({
      text: 'Council deliberated for 1m 12s · 3 members · 2 rounds',
      tone: 'done',
      time: '',
    });
  });

  it('mentions failed calls and warns', () => {
    const turn = councilTurn({
      status: 'complete',
      finishedAt: '2026-01-01T10:00:30.000Z',
      rounds: [round(0, 'answer', ['a', 'b'], { status: 'done', responses: [response('a', { status: 'done' }), response('b', { status: 'error' })] })],
    });
    const s = deliberationSummary(turn, 0);
    expect(s.text).toBe('Council deliberated for 30s · 3 members · 1 round · 1 call failed');
    expect(s.tone).toBe('warning');
  });

  it('describes stopped, interrupted and failed turns', () => {
    const base = { finishedAt: '2026-01-01T10:00:05.000Z' };
    expect(deliberationSummary(councilTurn({ ...base, status: 'stopped' }), 0).text).toBe('Stopped after 5s · 3 members · 0 rounds');
    expect(deliberationSummary(councilTurn({ ...base, status: 'stopped' }), 0).tone).toBe('stopped');
    expect(deliberationSummary(councilTurn({ status: 'interrupted', finishedAt: null }), 0).text).toBe('Interrupted · 3 members · 0 rounds');
    expect(deliberationSummary(councilTurn({ ...base, status: 'error' }), 0).text).toBe('Deliberation failed after 5s · 3 members · 0 rounds');
  });
});

describe('turn helpers', () => {
  it('detects the arbiter phase and whether skipping is possible', () => {
    const rounds = [round(0, 'answer', ['a'], { status: 'done' }), round(1, 'review', ['a'], { status: 'running' })];
    const inRounds = councilTurn({ rounds });
    expect(isArbiterPhase(inRounds)).toBe(false);
    expect(canSkipToVerdict(inRounds)).toBe(true);

    const atArbiter = councilTurn({ rounds: [round(0, 'answer', ['a'], { status: 'done' })], arbiter: arbiter({ status: 'running' }) });
    expect(isArbiterPhase(atArbiter)).toBe(true);
    expect(canSkipToVerdict(atArbiter)).toBe(false);

    const allRoundsDone = councilTurn({ rounds: [round(0, 'answer', ['a'], { status: 'done' })] });
    expect(isArbiterPhase(allRoundsDone)).toBe(true);

    expect(canSkipToVerdict(directTurn())).toBe(false);
    expect(canSkipToVerdict(councilTurn({ status: 'complete' }))).toBe(false);
  });

  it('counts rounds that ran and failed calls', () => {
    const turn = councilTurn({
      rounds: [
        round(0, 'answer', ['a'], { status: 'done' }),
        round(1, 'review', ['a', 'b'], { status: 'skipped', responses: [response('a', { status: 'skipped', startedAt: 'x' }), response('b', { status: 'error' })] }),
        round(2, 'revise', ['a'], { status: 'skipped' }),
      ],
      arbiter: arbiter({ status: 'error' }),
    });
    expect(roundsRun(turn)).toBe(2);
    expect(failedCalls(turn)).toBe(2);
  });

  it('computes how many answers a reviewer saw', () => {
    const r = round(1, 'review', ['a', 'b', 'c'], { labels: { A: 'b', B: 'a', C: 'c' } });
    expect(answersShownTo(r, 'a')).toBe(2);
    expect(answersShownTo({ ...r, includeSelf: true }, 'a')).toBe(3);
    expect(answersShownTo(r, 'outsider')).toBe(3);
    expect(answersShownTo(round(1, 'review', ['a', 'b'], { labels: { A: 'a', B: 'b' } }), 'a')).toBe(1);
  });

  it('sorts labels alphabetically', () => {
    expect(sortedLabels({ C: 'x', A: 'y', B: 'z' })).toEqual([
      ['A', 'y'],
      ['B', 'z'],
      ['C', 'x'],
    ]);
  });

  it('falls back to a neutral member for unknown ids', () => {
    const turn = councilTurn();
    expect(memberInfo(turn, 'a').name).toBe('A');
    expect(memberInfo(turn, 'ghost')).toMatchObject({ id: 'ghost', name: 'ghost' });
  });

  it('labels the final answer source', () => {
    expect(finalSourceLabel(councilTurn({ finalSource: { kind: 'arbiter', name: 'Claude', memberId: null } }))).toBe('Final answer · Claude');
    expect(finalSourceLabel(councilTurn({ finalSource: { kind: 'fallback', name: 'Gemini', memberId: 'b' } }))).toBe('Fallback answer · Gemini');
    expect(finalSourceLabel(directTurn({ finalSource: { kind: 'member', name: 'A', memberId: 'a' } }))).toBe('A');
    expect(finalSourceLabel(councilTurn())).toBe('Final answer · Judge');
    expect(finalSourceLabel(directTurn())).toBe('A');
  });

  it('chooses the placeholder for the phase', () => {
    expect(answerPlaceholder(councilTurn({ rounds: [round(0, 'answer', ['a'], { status: 'running' })] }))).toBe('The council is deliberating…');
    expect(answerPlaceholder(councilTurn({ rounds: [round(0, 'answer', ['a'], { status: 'done' })], arbiter: arbiter({ status: 'running' }) }))).toBe(
      'The arbiter is weighing the answers…',
    );
    expect(answerPlaceholder(directTurn())).toBe('Waiting for A…');
  });
});
