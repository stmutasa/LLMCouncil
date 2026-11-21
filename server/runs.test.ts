import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../shared/defaults';
import type { Conversation, RunEvent } from '../shared/types';
import { planTurn } from './engine/plan';
import { ProviderRegistry } from './providers/registry';
import type { Provider, RunRequest } from './providers/types';
import { RunManager } from './runs';
import { Storage } from './storage';

/** A provider the test drives by hand. */
function manualProvider() {
  const calls: RunRequest[] = [];
  const resolvers: ((text: string) => void)[] = [];
  const provider: Provider = {
    id: 'manual',
    info: () => Promise.reject(new Error('unused')),
    run: (req) =>
      new Promise((resolve, reject) => {
        calls.push(req);
        req.signal.addEventListener('abort', () => {
          const e = new Error('stopped');
          e.name = 'AbortError';
          reject(e);
        });
        resolvers.push((text) => resolve({ text, model: 'manual-1', billing: 'subscription', diagnostics: '' }));
      }),
  };
  return { provider, calls, resolvers };
}

describe('RunManager', () => {
  let dir: string;
  let storage: Storage;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'council-runs-'));
    storage = new Storage(dir);
    await storage.init();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    const manual = manualProvider();
    const settings = defaultSettings(true);
    for (const m of settings.members) m.provider = 'manual';
    settings.members[1]!.enabled = false;
    settings.members[2]!.enabled = false;
    const registry = new ProviderRegistry({ mock: true, overrides: { manual: manual.provider } });
    const runs = new RunManager({ storage, providers: registry, coalesceMs: 30 });
    const plan = planTurn('Hello', settings, (id) => registry.label(id, settings));
    const conversation: Conversation = {
      id: randomUUID(),
      title: 'Hello',
      createdAt: plan.turn.createdAt,
      updatedAt: plan.turn.createdAt,
      turns: [structuredClone(plan.turn)],
    };
    await storage.create(conversation);
    const run = runs.create(conversation.id, plan, settings)!;
    expect(runs.create(conversation.id, plan, settings)).toBeNull();
    return { manual, runs, run, conversation };
  }

  it('sends a snapshot first, coalesces appended text, sends replacements at once, and ends with turn.end', async () => {
    const { manual, runs, run, conversation } = await setup();
    const events: RunEvent[] = [];
    run.subscribe((e) => events.push(structuredClone(e)));
    expect(events.map((e) => e.type)).toEqual(['snapshot']);
    run.start(conversation);
    await new Promise((r) => setTimeout(r, 0));
    const req = manual.calls[0]!;
    for (let i = 0; i < 50; i++) req.onText(`w${i} `, false);
    expect(events.filter((e) => e.type === 'member.delta')).toHaveLength(0);
    // The live turn has the text immediately, even before it is flushed.
    expect(run.turn.rounds[0]!.responses[0]!.text).toContain('w49');

    // A late subscriber gets the buffered text in its snapshot, and existing ones get it flushed.
    const late: RunEvent[] = [];
    run.subscribe((e) => late.push(structuredClone(e)));
    const flushed = events.filter((e): e is Extract<RunEvent, { type: 'member.delta' }> => e.type === 'member.delta');
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.text).toBe(Array.from({ length: 50 }, (_, i) => `w${i} `).join(''));
    expect((late[0] as Extract<RunEvent, { type: 'snapshot' }>).turn.rounds[0]!.responses[0]!.text).toBe(flushed[0]!.text);

    req.onText('more', false);
    req.onText('REPLACED', true);
    const replaces = events.filter((e) => e.type === 'member.delta' && e.replace);
    expect(replaces).toHaveLength(1);
    req.onText(' tail', false);
    await new Promise((r) => setTimeout(r, 60));
    const deltas = events.filter((e): e is Extract<RunEvent, { type: 'member.delta' }> => e.type === 'member.delta');
    expect(deltas.map((d) => [d.text.slice(0, 8), d.replace])).toEqual([
      ['w0 w1 w2', false],
      ['REPLACED', true],
      [' tail', false],
    ]);

    manual.resolvers[0]!('final text');
    await run.finished;
    for (const list of [events, late]) {
      expect(list[list.length - 1]!.type).toBe('turn.end');
      expect(list.filter((e) => e.type === 'turn.end')).toHaveLength(1);
    }
    const end = events[events.length - 1] as Extract<RunEvent, { type: 'turn.end' }>;
    expect(end.turn.finalText).toBe('final text');
    expect(runs.has(conversation.id)).toBe(false);
    expect((await storage.load(conversation.id))!.turns[0]).toEqual(end.turn);
  });

  it('stops a run, waits for it and reports nothing to stop afterwards', async () => {
    const { runs, run, conversation, manual } = await setup();
    run.start(conversation);
    await new Promise((r) => setTimeout(r, 0));
    expect(manual.calls).toHaveLength(1);
    expect(await runs.stop(conversation.id)).toBe(true);
    expect(runs.has(conversation.id)).toBe(false);
    expect((await storage.load(conversation.id))!.turns[0]!.status).toBe('stopped');
    expect(await runs.stop(conversation.id)).toBe(false);
  });

  it('does not recreate a conversation deleted while its run was finishing', async () => {
    const { runs, run, conversation } = await setup();
    run.start(conversation);
    await storage.delete(conversation.id);
    await runs.stop(conversation.id);
    expect(await storage.load(conversation.id)).toBeNull();
  });

  it('marks runs interrupted on shutdown', async () => {
    const { runs, run, conversation } = await setup();
    run.start(conversation);
    await runs.shutdown();
    expect((await storage.load(conversation.id))!.turns[0]!.status).toBe('interrupted');
  });
});
