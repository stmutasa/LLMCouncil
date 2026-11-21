import { describe, expect, it, vi } from 'vitest';
import { ARBITER_MARKER } from '../../shared/arbiter';
import { defaultSettings } from '../../shared/defaults';
import type { Conversation, RunEvent, Settings, Turn } from '../../shared/types';
import { ProviderRegistry } from '../providers/registry';
import type { Provider } from '../providers/types';
import { RunControl, runTurn, ShutdownReason, type ProviderSource } from './orchestrator';
import { planTurn } from './plan';

/** Deterministic RNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Call {
  provider: string;
  model: string;
  prompt: string;
}

function recordingSource(inner: ProviderSource, calls: Call[]): ProviderSource {
  return {
    get(id, settings) {
      const p = inner.get(id, settings);
      if (!p) return null;
      const wrapped: Provider = {
        ...p,
        run: (req) => {
          calls.push({ provider: id, model: req.model, prompt: req.prompt });
          return p.run(req);
        },
      };
      return wrapped;
    },
    webSearchSupport: (id, s) => inner.webSearchSupport(id, s),
    timeoutMs: (id, s) => inner.timeoutMs(id, s),
  };
}

interface Setup {
  message?: string;
  protocol?: string;
  models?: Record<string, string>;
  arbiterModel?: string;
  analysis?: boolean;
  mutate?: (s: Settings) => void;
  history?: Turn[];
  rng?: () => number;
  source?: (inner: ProviderSource) => ProviderSource;
}

function start(opts: Setup = {}) {
  const settings = defaultSettings(true);
  settings.activeProtocolId = opts.protocol ?? 'council';
  for (const m of settings.members) m.model = opts.models?.[m.name] ?? 'instant';
  settings.arbiter.model = opts.arbiterModel ?? 'instant';
  settings.arbiter.analysis = opts.analysis ?? true;
  opts.mutate?.(settings);
  const registry = new ProviderRegistry({ mock: true });
  const calls: Call[] = [];
  const base = recordingSource(registry, calls);
  const providers = opts.source ? opts.source(base) : base;
  const plan = planTurn(opts.message ?? 'Which database should a small team pick?', settings, (id) => registry.label(id, settings));
  const conversation: Conversation = {
    id: '00000000-0000-0000-0000-000000000001',
    title: 't',
    createdAt: plan.turn.createdAt,
    updatedAt: plan.turn.createdAt,
    turns: [...(opts.history ?? []), plan.turn],
  };
  const events: RunEvent[] = [];
  const control = new RunControl(plan.turn.mode);
  const abort = new AbortController();
  const listeners: ((e: RunEvent) => void)[] = [];
  const done = runTurn({
    conversation,
    plan,
    settings,
    providers,
    rng: opts.rng ?? seeded(42),
    emit: (e) => {
      events.push(structuredClone(e));
      for (const l of listeners) l(e);
    },
    signal: abort.signal,
    control,
  });
  const when = (pred: (e: RunEvent, all: RunEvent[]) => boolean) =>
    new Promise<void>((resolve) => {
      if (events.some((e) => pred(e, events))) return resolve();
      listeners.push((e) => {
        if (pred(e, events)) resolve();
      });
    });
  const end = async () => {
    await done;
    const last = events[events.length - 1]!;
    expect(last.type).toBe('turn.end');
    expect(events.filter((e) => e.type === 'turn.end')).toHaveLength(1);
    return (last as Extract<RunEvent, { type: 'turn.end' }>).turn;
  };
  const memberId = (name: string) => settings.members.find((m) => m.name === name)!.id;
  return { settings, plan, events, control, abort, calls, done, end, when, memberId };
}

const nameOf = (s: Settings, id: string) => s.members.find((m) => m.id === id)!.name;

describe('orchestrator', () => {
  it('runs the Council preset end to end', async () => {
    const t = start();
    const turn = await t.end();
    expect(turn.status).toBe('complete');
    expect(turn.error).toBeNull();
    expect(turn.mode).toBe('council');
    expect(turn.rounds.map((r) => r.status)).toEqual(['done', 'done']);
    expect(turn.rounds[0]!.responses.every((r) => r.status === 'done' && r.model === 'mock-1' && r.durationMs !== null)).toBe(true);

    const review = turn.rounds[1]!;
    expect(Object.keys(review.labels).sort()).toEqual(['A', 'B', 'C']);
    expect(new Set(Object.values(review.labels))).toEqual(new Set(turn.members.map((m) => m.id)));
    for (const r of review.responses) {
      const own = Object.entries(review.labels).find(([, id]) => id === r.memberId)![0];
      expect(r.ranking).not.toBeNull();
      expect(r.ranking).toHaveLength(2);
      expect(r.ranking).not.toContain(own);
    }
    expect(review.leaderboard).not.toBeNull();
    expect(review.leaderboard!.reduce((n, e) => n + e.votes, 0)).toBe(6);

    expect(turn.arbiter!.status).toBe('done');
    expect(turn.finalSource).toEqual({ kind: 'arbiter', name: 'Claude', memberId: null });
    expect(turn.analysisText).toMatch(/^\*\*Consensus:\*\*/);
    expect(turn.finalText.startsWith('## Verdict')).toBe(true);
    expect(turn.finalText).not.toContain(ARBITER_MARKER);
    expect(turn.finishedAt).not.toBeNull();

    // Reviewers never see their own answer; the review round was anonymized.
    const reviewCalls = t.calls.filter((c) => c.prompt.includes('## Responses under review'));
    expect(reviewCalls).toHaveLength(3);
    for (const c of reviewCalls) {
      const name = /^You are ([^,]+),/.exec(c.prompt)![1]!;
      expect(c.prompt).not.toContain(`### ${name}'s answer`);
      expect(c.prompt).toContain('Your own answer is not among them.');
      expect(c.prompt).not.toContain('author=');
    }
    const arbiterCall = t.calls.find((c) => c.prompt.includes('the arbiter of a council'))!;
    expect(arbiterCall.prompt).toContain('## Peer reviews of these answers\nReviewers saw the answers without author names.');
    expect(arbiterCall.prompt).toContain('## Peer ranking of these answers (1 is best)');
    for (const [label, id] of Object.entries(review.labels)) {
      expect(arbiterCall.prompt).toContain(`<answer label="Response ${label}" author="${nameOf(t.settings, id)}">`);
    }
  });

  it('emits events in a consistent order', async () => {
    const t = start();
    await t.end();
    const types = t.events.map((e) => e.type);
    expect(types[0]).toBe('round.start');
    expect(types.indexOf('arbiter.start')).toBeGreaterThan(types.lastIndexOf('round.end'));
    expect(types.lastIndexOf('arbiter.delta')).toBeLessThan(types.indexOf('arbiter.end'));
    for (const round of [0, 1]) {
      const idx = (pred: (e: RunEvent) => boolean) => t.events.findIndex(pred);
      const start = idx((e) => e.type === 'round.start' && e.round === round);
      const end = idx((e) => e.type === 'round.end' && e.round === round);
      for (const m of t.plan.participants) {
        const ms = idx((e) => e.type === 'member.start' && e.round === round && e.memberId === m.id);
        const me = idx((e) => e.type === 'member.end' && e.round === round && e.response.memberId === m.id);
        expect(start).toBeLessThan(ms);
        expect(ms).toBeLessThan(me);
        expect(me).toBeLessThan(end);
        // Deltas concatenate to the final text.
        const text = t.events
          .filter((e): e is Extract<RunEvent, { type: 'member.delta' }> => e.type === 'member.delta' && e.round === round && e.memberId === m.id)
          .reduce((acc, e) => (e.replace ? e.text : acc + e.text), '');
        expect(text).toBe((t.events[me] as Extract<RunEvent, { type: 'member.end' }>).response.text);
      }
    }
  });

  it('runs Debate with fresh labels after each revision', async () => {
    let calls = 0;
    const rng = seeded(7);
    const t = start({ protocol: 'debate', rng: () => (calls++, rng()) });
    const turn = await t.end();
    expect(turn.status).toBe('complete');
    expect(turn.rounds.map((r) => r.type)).toEqual(['answer', 'revise', 'revise']);
    // Three answer sets of three members: two swaps each.
    expect(calls).toBe(6);
    const reviseCalls = t.calls.filter((c) => c.prompt.includes('## Your current answer'));
    expect(reviseCalls).toHaveLength(6);
    for (const c of reviseCalls) {
      expect(c.prompt).toContain("## The other members' current answers");
      expect(c.prompt).not.toContain('It appears as');
      expect(c.prompt).toContain('author="');
    }
    const arbiterCall = t.calls.find((c) => c.prompt.includes('the arbiter of a council'))!;
    expect(arbiterCall.prompt).toContain('**What changed:**');
    expect(arbiterCall.prompt).not.toContain('## Peer ranking');
  });

  it('runs Deep deliberation: the revise round keeps the review labels and the arbiter sees a stale ranking', async () => {
    const t = start({ protocol: 'deep' });
    const turn = await t.end();
    expect(turn.status).toBe('complete');
    const [, review, revise] = turn.rounds;
    expect(revise!.labels).toEqual(review!.labels);
    const reviseCalls = t.calls.filter((c) => c.prompt.includes('## Your current answer'));
    for (const c of reviseCalls) {
      const name = /^You are ([^,]+),/.exec(c.prompt)![1]!;
      const id = t.plan.participants.find((m) => m.name === name)!.id;
      const own = Object.entries(review!.labels).find(([, v]) => v === id)![0];
      expect(c.prompt).toContain(`It appears as Response ${own} in the material below.`);
      expect(c.prompt).toContain('## Peer reviews of the current answers');
      expect(c.prompt).toContain('<review by="Reviewer 1">');
      expect(c.prompt).toContain('<review by="Reviewer 2">');
      expect(c.prompt).not.toContain('<review by="Reviewer 3">');
      expect(c.prompt).toContain('## Current peer ranking (1 is best)');
      expect(c.prompt).toContain('(yours)');
    }
    const arbiterCall = t.calls.find((c) => c.prompt.includes('the arbiter of a council'))!;
    expect(arbiterCall.prompt).toContain("## Peer ranking of the members' earlier drafts, before revision (1 is best)");
    expect(arbiterCall.prompt).not.toContain('## Peer reviews of these answers');
  });

  it('answers directly when only one member is enabled', async () => {
    const t = start({
      mutate: (s) => {
        s.members[1]!.enabled = false;
        s.members[2]!.enabled = false;
      },
    });
    const turn = await t.end();
    expect(turn.mode).toBe('direct');
    expect(turn.arbiter).toBeNull();
    expect(turn.rounds).toHaveLength(1);
    expect(turn.protocolName).toBe('Direct answer');
    expect(turn.status).toBe('complete');
    expect(turn.finalSource).toEqual({ kind: 'member', name: 'Claude', memberId: 'm-claude' });
    expect(turn.finalText).toBe(turn.rounds[0]!.responses[0]!.text);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.prompt.startsWith('You are Claude, an expert assistant')).toBe(true);
    expect(t.control.canSkip()).toBe(false);
  });

  it('restricts the turn to @mentioned members, including disabled ones', async () => {
    const t = start({
      message: '@Gemini @chatgpt compare the options',
      mutate: (s) => {
        s.members[2]!.enabled = false;
      },
    });
    const turn = await t.end();
    expect(turn.mode).toBe('council');
    expect(turn.members.map((m) => m.name)).toEqual(['ChatGPT', 'Gemini']);
    expect(t.calls.filter((c) => c.prompt.includes('Independent answers')).every((c) => c.prompt.includes('<question>\ncompare the options\n</question>'))).toBe(true);
    expect(t.calls[0]!.prompt).toContain('one of 2 AI models');

    const direct = start({ message: '@gemini hello there' });
    const d = await direct.end();
    expect(d.mode).toBe('direct');
    expect(d.members.map((m) => m.name)).toEqual(['Gemini']);
  });

  it('continues when one member fails and tells the arbiter', async () => {
    const t = start({ models: { ChatGPT: 'instant+fail' } });
    const turn = await t.end();
    expect(turn.status).toBe('complete');
    const failed = turn.rounds[0]!.responses.find((r) => r.memberId === 'm-chatgpt')!;
    expect(failed).toMatchObject({ status: 'error', error: 'Mock failure' });
    expect(Object.keys(turn.rounds[1]!.labels)).toHaveLength(2);
    // The failing member also fails its review; the other two each review one answer (no ranking).
    expect(turn.rounds[1]!.responses.find((r) => r.memberId === 'm-chatgpt')!.status).toBe('error');
    const arbiterCall = t.calls.find((c) => c.prompt.includes('the arbiter of a council'))!;
    expect(arbiterCall.prompt).toContain('## Members that did not answer\n- ChatGPT: Mock failure');
  });

  it('fails the turn when every member fails', async () => {
    const t = start({ models: { Claude: 'fail+instant', ChatGPT: 'fail+instant', Gemini: 'fail+instant' } });
    const turn = await t.end();
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('No council member produced an answer.\nClaude: Mock failure\nChatGPT: Mock failure\nGemini: Mock failure');
    expect(turn.rounds[1]!.status).toBe('skipped');
    expect(turn.arbiter!.status).toBe('skipped');
    expect(turn.finalSource.kind).toBe('none');
    expect(t.calls.some((c) => c.prompt.includes('the arbiter'))).toBe(false);
  });

  it('falls back to the leaderboard leader when the arbiter fails', async () => {
    const t = start({ arbiterModel: 'instant+fail' });
    const turn = await t.end();
    expect(turn.status).toBe('complete');
    const leader = turn.rounds[1]!.leaderboard![0]!.memberId;
    const name = nameOf(t.settings, leader);
    expect(turn.finalSource).toEqual({ kind: 'fallback', name, memberId: leader });
    expect(turn.finalText).toBe(turn.rounds[0]!.responses.find((r) => r.memberId === leader)!.text);
    expect(turn.error).toBe(`The arbiter (Claude) failed: Mock failure. Showing ${name}'s answer instead.`);
    expect(turn.arbiter).toMatchObject({ status: 'error', error: 'Mock failure' });
    expect(turn.analysisText).toBe('');
  });

  it('falls back to the first member with an answer when there is no leaderboard', async () => {
    const t = start({ protocol: 'quick', arbiterModel: 'instant+fail', models: { Claude: 'instant+fail' } });
    const turn = await t.end();
    expect(turn.finalSource).toEqual({ kind: 'fallback', name: 'ChatGPT', memberId: 'm-chatgpt' });
  });

  it('uses the whole arbiter output when it ignores the marker', async () => {
    const t = start({ arbiterModel: 'instant+plain' });
    const turn = await t.end();
    expect(turn.status).toBe('complete');
    expect(turn.analysisText).toBe('');
    expect(turn.finalText.startsWith('## Verdict')).toBe(true);
    expect(turn.finalSource.kind).toBe('arbiter');
  });

  it('skips to the verdict with the answers that exist', async () => {
    const t = start({ models: { Gemini: 'instant+hang' } });
    await t.when((_e, all) => all.filter((x) => x.type === 'member.end').length === 2);
    expect(t.control.requestSkip()).toBe(true);
    expect(t.control.requestSkip()).toBe(false);
    const turn = await t.end();
    expect(turn.status).toBe('complete');
    const gemini = turn.rounds[0]!.responses.find((r) => r.memberId === 'm-gemini')!;
    expect(gemini.status).toBe('skipped');
    expect(gemini.text.length).toBeGreaterThan(0);
    expect(turn.rounds[0]!.status).toBe('done');
    expect(turn.rounds[1]!.status).toBe('skipped');
    expect(turn.rounds[1]!.responses.every((r) => r.status === 'skipped')).toBe(true);
    expect(turn.arbiter!.status).toBe('done');
    const arbiterCall = t.calls.find((c) => c.prompt.includes('the arbiter of a council'))!;
    expect(arbiterCall.prompt.match(/<answer label=/g)).toHaveLength(2);
    expect(arbiterCall.prompt).toContain('- Gemini: It had not finished when the council moved on to the verdict.');
  });

  it('errors when skipping before any member finished', async () => {
    const t = start({ models: { Claude: 'hang', ChatGPT: 'hang', Gemini: 'hang' } });
    await t.when((e) => e.type === 'member.start');
    t.control.requestSkip();
    const turn = await t.end();
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('Skipped before any member finished answering.');
    expect(turn.arbiter!.status).toBe('skipped');
  });

  it('stops mid-round, keeping partial text', async () => {
    const t = start({ models: { Gemini: 'instant+hang' } });
    await t.when((_e, all) => all.filter((x) => x.type === 'member.end').length === 2);
    t.abort.abort();
    const turn = await t.end();
    expect(turn.status).toBe('stopped');
    const gemini = turn.rounds[0]!.responses.find((r) => r.memberId === 'm-gemini')!;
    expect(gemini.status).toBe('skipped');
    expect(gemini.text).not.toBe('');
    expect(turn.rounds[1]!.status).toBe('skipped');
    expect(turn.arbiter!.status).toBe('skipped');
    expect(turn.finalText).toBe('');
    expect(turn.finalSource.kind).toBe('none');
  });

  it('stops mid-arbiter, keeping the partial final answer', async () => {
    const t = start({ arbiterModel: 'instant+hang', analysis: false });
    await t.when((e) => e.type === 'arbiter.delta');
    t.abort.abort();
    const turn = await t.end();
    expect(turn.status).toBe('stopped');
    expect(turn.arbiter!.status).toBe('skipped');
    expect(turn.finalText).not.toBe('');
    expect('## Verdict\n\nAfter weighing the council'.startsWith(turn.finalText.slice(0, 10))).toBe(true);
    expect(turn.finalSource.kind).toBe('arbiter');
    expect(turn.rounds.every((r) => r.status === 'done')).toBe(true);
  });

  it('stops mid-arbiter before the marker with no final text', async () => {
    const t = start({ arbiterModel: 'instant+hang' });
    await t.when((e) => e.type === 'arbiter.delta');
    t.abort.abort();
    const turn = await t.end();
    expect(turn.status).toBe('stopped');
    expect(turn.finalText).toBe('');
    expect(turn.finalSource.kind).toBe('none');
  });

  it('stops a direct answer, keeping the partial text', async () => {
    const t = start({ message: '@claude hi', models: { Claude: 'instant+hang' } });
    await t.when((e) => e.type === 'member.delta');
    t.abort.abort();
    const turn = await t.end();
    expect(turn.status).toBe('stopped');
    expect(turn.finalText).toBe(turn.rounds[0]!.responses[0]!.text);
    expect(turn.finalText).not.toBe('');
    expect(turn.finalSource.kind).toBe('member');
  });

  it('ends as interrupted on shutdown', async () => {
    const t = start({ models: { Claude: 'hang' } });
    await t.when((e) => e.type === 'member.start');
    t.abort.abort(new ShutdownReason());
    const turn = await t.end();
    expect(turn.status).toBe('interrupted');
    expect(turn.error).toBe('The server stopped while this turn was running.');
  });

  it('reports a provider that is not registered', async () => {
    const t = start({
      mutate: (s) => {
        s.members[0]!.provider = 'nope';
      },
    });
    const turn = await t.end();
    expect(turn.rounds[0]!.responses[0]).toMatchObject({ status: 'error', error: "Provider 'nope' is not available." });
    expect(turn.status).toBe('complete');
  });

  it('turns an unexpected exception into an error turn with exactly one turn.end', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = start({
      mutate: (s) => {
        s.webSearch = true;
      },
      source: (inner) => ({
        ...inner,
        get: inner.get,
        timeoutMs: inner.timeoutMs,
        webSearchSupport: () => {
          throw new Error('boom');
        },
      }),
    });
    const turn = await t.end();
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('Something went wrong while running this turn: boom');
    expect(turn.rounds.every((r) => r.status !== 'running' && r.status !== 'pending')).toBe(true);
    expect(turn.arbiter!.status).toBe('skipped');
    err.mockRestore();
  });

  it('includes earlier turns as history', async () => {
    const first = start({ message: '@claude What is SQLite?' });
    const earlier = await first.end();
    const t = start({ message: 'And Postgres?', history: [earlier] });
    await t.end();
    for (const c of t.calls) {
      expect(c.prompt).toContain('<conversation_history>\n<turn n="1">\n<user>\nWhat is SQLite?\n</user>\n<answer>\n');
    }
  });

  it('lets members review their own answer when includeSelf is on', async () => {
    const t = start({
      mutate: (s) => {
        s.protocols.push({
          id: 'self',
          name: 'Self',
          description: '',
          builtin: false,
          rounds: [
            { id: 'a', type: 'answer', title: '', instructions: '', anonymize: false, includeSelf: false },
            { id: 'b', type: 'review', title: 'Self review', instructions: 'Be strict.', anonymize: false, includeSelf: true },
          ],
        });
        s.activeProtocolId = 'self';
      },
    });
    const turn = await t.end();
    for (const r of turn.rounds[1]!.responses) expect(r.ranking).toHaveLength(3);
    const reviewCall = t.calls.find((c) => c.prompt.includes('## Responses under review'))!;
    expect(reviewCall.prompt).toContain('## Your task (round 2 of 2: Self review)');
    expect(reviewCall.prompt).toContain('Rules for this round (set by the user):\nBe strict.');
    expect(reviewCall.prompt).not.toContain('Your own answer is not among them.');
    expect(reviewCall.prompt).toContain('author="Claude"');
  });

  it('skips a reviewer with nothing to review', async () => {
    const t = start({ models: { ChatGPT: 'instant+fail', Gemini: 'instant+fail' } });
    const turn = await t.end();
    const review = turn.rounds[1]!;
    expect(review.responses.find((r) => r.memberId === 'm-claude')!.status).toBe('skipped');
    expect(review.leaderboard).toBeNull();
    expect(turn.status).toBe('complete');
    expect(turn.finalSource.kind).toBe('arbiter');
  });
});
