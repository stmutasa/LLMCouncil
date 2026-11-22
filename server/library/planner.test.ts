import { describe, expect, it } from 'vitest';
import { mockProvider, plannerReply } from '../providers/mock';
import { combineQueries, parsePlannerOutput, plannerPrompt, runPlanner, PLANNER_INTRO } from './planner';

describe('planner prompt', () => {
  it('has the fixed wording, with earlier questions only when there are some', () => {
    const p = plannerPrompt('What did Acme pay in 2025?', []);
    expect(p).toBe(
      `${PLANNER_INTRO}\n\nThe user's question:\n<question>\nWhat did Acme pay in 2025?\n</question>\n\n` +
        'Write up to 6 short search queries (2 to 6 words each) that together would find the passages needed to answer the question. Use the specific names, terms, numbers and alternative wordings likely to appear in the documents themselves. Reply with a JSON array of strings and nothing else.',
    );
    const q = plannerPrompt('And in 2026?', ['What did Acme pay in 2025?', '  Second\nquestion ']);
    expect(q).toContain('Earlier questions in this conversation, oldest first:\n- What did Acme pay in 2025?\n- Second question\n\nThe user');
  });
});

describe('planner output parsing', () => {
  it('reads a JSON array, even inside prose or a code fence', () => {
    expect(parsePlannerOutput('["acme invoice 2025", "acme payment"]')).toEqual(['acme invoice 2025', 'acme payment']);
    expect(parsePlannerOutput('Here you go:\n```json\n["a b", "c d"]\n```')).toEqual(['a b', 'c d']);
  });

  it('falls back to lines without list markers and quotes', () => {
    expect(parsePlannerOutput('1. "acme invoice"\n2) acme payment\n- “renewal date”\n* fees,')).toEqual([
      'acme invoice',
      'acme payment',
      'renewal date',
      'fees',
    ]);
    // An array that is not all strings is read line by line instead.
    expect(parsePlannerOutput('[1, 2]')).toEqual(['[1, 2]']);
  });

  it('keeps at most six queries of at most 120 characters', () => {
    const many = JSON.stringify(Array.from({ length: 9 }, (_, i) => `query ${i}`));
    expect(parsePlannerOutput(many)).toHaveLength(6);
    expect(parsePlannerOutput(JSON.stringify(['x'.repeat(300)]))[0]).toHaveLength(120);
    expect(parsePlannerOutput('')).toEqual([]);
    expect(parsePlannerOutput('[]')).toEqual([]);
  });

  it('puts the question first and removes repeats', () => {
    expect(combineQueries('Acme fees?', ['acme fees?', 'Acme  invoice', 'acme invoice'])).toEqual(['Acme fees?', 'Acme  invoice']);
  });
});

describe('mock planner', () => {
  it('answers the planner prompt with a JSON array built from the question', async () => {
    const reply = plannerReply(plannerPrompt('What was the turbine maintenance budget for Rotterdam?', []));
    expect(JSON.parse(reply)).toEqual(['turbine maintenance', 'budget rotterdam']);
    const queries = await runPlanner(mockProvider(), {
      model: 'instant',
      effort: '',
      question: 'Turbine maintenance budget',
      earlierQuestions: [],
      signal: new AbortController().signal,
    });
    expect(queries).toEqual(['turbine maintenance', 'budget']);
  });
});
