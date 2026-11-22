import { describe, expect, it } from 'vitest';
import { parseRunEvent } from './events';
import { arbiter, councilTurn, library, response, round } from './testFixtures';

describe('parseRunEvent', () => {
  it('accepts every well-formed event type', () => {
    const turn = councilTurn();
    const events = [
      { type: 'snapshot', turn },
      { type: 'turn.end', turn },
      { type: 'library.start' },
      { type: 'library.end', library: library() },
      { type: 'round.start', round: 0 },
      { type: 'member.start', round: 0, memberId: 'a', startedAt: 'x' },
      { type: 'member.delta', round: 0, memberId: 'a', text: 'x', replace: false },
      { type: 'member.activity', round: 0, memberId: 'a', activity: '' },
      { type: 'member.end', round: 0, response: response('a', { status: 'done' }) },
      { type: 'round.end', round: 0, result: round(0, 'answer', ['a']) },
      { type: 'arbiter.start', startedAt: 'x' },
      { type: 'arbiter.delta', text: 'x', replace: true },
      { type: 'arbiter.activity', activity: 'x' },
      { type: 'arbiter.end', arbiter: arbiter(), analysisText: '', finalText: 'f' },
    ];
    for (const e of events) expect(parseRunEvent(JSON.stringify(e))).toEqual(e);
  });

  it('rejects invalid JSON, non-objects and unknown types', () => {
    expect(parseRunEvent('not json')).toBeNull();
    expect(parseRunEvent('null')).toBeNull();
    expect(parseRunEvent('[1,2]')).toBeNull();
    expect(parseRunEvent('"snapshot"')).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'something.new', round: 0 }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ round: 0 }))).toBeNull();
  });

  it('rejects events with missing or mistyped fields', () => {
    expect(parseRunEvent(JSON.stringify({ type: 'snapshot' }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'snapshot', turn: { id: 't' } }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'round.start', round: '1' }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'member.delta', round: 0, memberId: 'a', text: 'x' }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'member.delta', round: 0, memberId: 'a', text: 5, replace: false }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'member.end', round: 0, response: { status: 'done', text: '' } }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'round.end', round: 0, result: {} }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'arbiter.end', arbiter: arbiter(), finalText: 'f' }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'library.end' }))).toBeNull();
    expect(parseRunEvent(JSON.stringify({ type: 'library.end', library: { status: 'done', excerpts: [] } }))).toBeNull();
  });
});
