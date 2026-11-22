import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../shared/defaults';
import type { Conversation, LibraryDocument, RunEvent, Settings, Turn } from '../../shared/types';
import { LibraryIndex } from '../library/index';
import { searchIndex } from '../library/search';
import type { Part } from '../library/types';
import { ProviderRegistry } from '../providers/registry';
import type { Provider, RunRequest } from '../providers/types';
import {
  assignCitationIds,
  BUDGET_USED,
  CUT_MARKER,
  mentionedExcerpts,
  STOPPED_DURING_LIBRARY,
  type LibraryAccess,
  type StoredTurnLibrary,
} from './libraryPhase';
import { RunControl, runTurn, type ProviderSource } from './orchestrator';
import { planTurn, plannedLibrary } from './plan';

const para = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `${topic} fact number ${i} is noted here.`).join(' ');

interface FakeDoc {
  doc: LibraryDocument;
  parts: Part[];
}

function fakeDoc(id: string, title: string, parts: Part[], over: Partial<LibraryDocument> = {}): FakeDoc {
  return {
    doc: {
      id,
      sourceId: 'src',
      title,
      location: 'Folder',
      type: 'pdf',
      status: 'ok',
      detail: '',
      chars: parts.reduce((n, p) => n + p.text.length, 0),
      parts: parts.length,
      modifiedAt: '',
      url: null,
      ...over,
    },
    parts,
  };
}

class FakeLibrary implements LibraryAccess {
  docs = new Map<string, FakeDoc>();
  index = LibraryIndex.empty();
  searches: string[][] = [];
  failSearch: Error | null = null;
  hangSearch = false;
  browseDir = '';

  async add(...docs: FakeDoc[]) {
    for (const d of docs) this.docs.set(d.doc.id, d);
    this.index = await LibraryIndex.build(
      [...this.docs.values()]
        .filter((d) => d.doc.status === 'ok')
        .map((d) => ({ id: d.doc.id, sourceId: d.doc.sourceId, title: d.doc.title, location: d.doc.location, parts: d.parts })),
    );
  }
  searchableCount(ids: string[]) {
    return [...this.docs.values()].filter((d) => d.doc.status === 'ok' && ids.includes(d.doc.sourceId)).length;
  }
  async search(queries: string[], opts: { budgetChars: number; sourceIds: string[]; excludeDocumentIds?: string[]; signal?: AbortSignal }) {
    this.searches.push(queries);
    if (this.failSearch) throw this.failSearch;
    if (this.hangSearch) {
      await new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' }))));
    }
    return searchIndex(this.index, queries, opts, async (id) => this.docs.get(id)?.parts ?? null);
  }
  document(id: string) {
    return this.docs.get(id)?.doc ?? null;
  }
  async readParts(id: string) {
    return this.docs.get(id)?.parts ?? null;
  }
  async prepareBrowse() {
    return { dir: this.browseDir, documents: this.docs.size };
  }
}

interface Call {
  provider: string;
  model: string;
  prompt: string;
  browseDir: string | undefined;
}

/** A provider that answers plainly and records what it was given (browse capability 'no'). */
function plainProvider(calls: Call[]): Provider {
  return {
    id: 'plain',
    info: async () => {
      throw new Error('unused');
    },
    run: async (req: RunRequest) => {
      calls.push({ provider: 'plain', model: req.model, prompt: req.prompt, browseDir: req.browseDir });
      return { text: 'Plain answer.', model: null, billing: 'unknown', diagnostics: '' };
    },
  };
}

function source(calls: Call[]): ProviderSource {
  const registry = new ProviderRegistry({ mock: true, overrides: { plain: plainProvider(calls) } });
  return {
    get(id, s) {
      const p = registry.get(id, s);
      if (!p || id === 'plain') return p;
      return {
        ...p,
        run: (req) => {
          calls.push({ provider: id, model: req.model, prompt: req.prompt, browseDir: req.browseDir });
          return p.run(req);
        },
      };
    },
    webSearchSupport: (id) => registry.webSearchSupport(id),
    timeoutMs: (id, s) => registry.timeoutMs(id, s),
    browseSupport: (id) => registry.browseSupport(id),
    label: (id, s) => registry.label(id, s),
  };
}

function baseSettings(mutate?: (s: Settings) => void): Settings {
  const s = defaultSettings(true);
  for (const m of s.members) m.model = 'instant';
  s.arbiter.model = 'instant';
  s.library.planner.model = 'instant';
  s.library.sources = [{ id: 'src', kind: 'folder', name: 'Docs', enabled: true, path: '/docs' }];
  mutate?.(s);
  return s;
}

async function runOne(opts: {
  library: LibraryAccess | null;
  message: string;
  settings?: Settings;
  history?: Turn[];
  attachments?: string[];
  stopWhen?: (e: RunEvent) => boolean;
}) {
  const settings = opts.settings ?? baseSettings();
  const calls: Call[] = [];
  const providers = source(calls);
  const plan = planTurn(opts.message, settings, (id) => id, new Date(), opts.attachments ?? []);
  const conversation: Conversation = {
    id: '00000000-0000-0000-0000-000000000001',
    title: 't',
    createdAt: plan.turn.createdAt,
    updatedAt: plan.turn.createdAt,
    turns: [...(opts.history ?? []), plan.turn],
  };
  const events: RunEvent[] = [];
  const abort = new AbortController();
  const control = new RunControl(plan.turn.mode, plan.turn.library !== null);
  await runTurn({
    conversation,
    plan,
    settings,
    providers,
    rng: () => 0.5,
    emit: (e) => {
      events.push(structuredClone(e));
      if (opts.stopWhen?.(e)) abort.abort();
    },
    signal: abort.signal,
    control,
    library: opts.library,
  });
  const end = events[events.length - 1] as Extract<RunEvent, { type: 'turn.end' }>;
  expect(end.type).toBe('turn.end');
  return { turn: end.turn, events, calls, settings, control };
}

let lib: FakeLibrary;
let browseDir: string;

beforeAll(async () => {
  browseDir = await mkdtemp(path.join(os.tmpdir(), 'council-phase-'));
  await writeFile(path.join(browseDir, 'INDEX.md'), '# Document library\n\n2 documents.\n\n- a.md — A\n- b.md — B\n');
});

afterAll(async () => {
  await rm(browseDir, { recursive: true, force: true });
});

async function freshLibrary(): Promise<FakeLibrary> {
  lib = new FakeLibrary();
  lib.browseDir = browseDir;
  await lib.add(
    fakeDoc('a'.repeat(20), 'Turbine manual.pdf', [
      { label: 'p. 1', text: para('turbine', 10) },
      { label: 'p. 2', text: para('gearbox', 10) },
    ]),
    fakeDoc('b'.repeat(20), 'Budget 2026.xlsx', [{ label: 'sheet Budget', text: para('budget', 8) }]),
  );
  return lib;
}

describe('planned library record', () => {
  it('is null when the library is off or has no enabled source and nothing is attached', () => {
    const s = baseSettings();
    expect(plannedLibrary(s, [])).toMatchObject({ mode: 'search', status: 'pending', queries: [], excerpts: [], attachments: [] });
    s.library.mode = 'off';
    expect(plannedLibrary(s, [])).toBeNull();
    expect(plannedLibrary(s, ['x'])).toMatchObject({ mode: 'off', attachmentIds: ['x'] });
    s.library.mode = 'browse';
    s.library.sources[0]!.enabled = false;
    expect(plannedLibrary(s, [])).toBeNull();
  });

  it('validates attachments', () => {
    const s = baseSettings();
    expect(() => planTurn('q', s, (id) => id, new Date(), 'x' as unknown as string[])).toThrow(/list of document ids/);
    expect(() => planTurn('q', s, (id) => id, new Date(), Array.from({ length: 21 }, (_, i) => `d${i}`))).toThrow(/At most 20/);
    expect(planTurn('q', s, (id) => id, new Date(), ['a', 'a', ' b ']).attachmentIds).toEqual(['a', 'b']);
  });
});

describe('library phase', () => {
  it('searches before round 1 and gives every member and the arbiter the same passages', async () => {
    await freshLibrary();
    const { turn, events, calls } = await runOne({ library: lib, message: 'What does the turbine manual say about gearbox facts?' });
    expect(turn.status).toBe('complete');
    const types = events.map((e) => e.type);
    expect(types.indexOf('library.start')).toBeLessThan(types.indexOf('library.end'));
    expect(types.indexOf('library.end')).toBeLessThan(types.indexOf('round.start'));
    const l = turn.library!;
    expect(l.status).toBe('done');
    expect(l.error).toBeNull();
    expect(l.queries[0]).toBe('What does the turbine manual say about gearbox facts?');
    expect(l.queries.length).toBeGreaterThan(1);
    expect(l.plannerNote).toBe('');
    expect(l.excerpts.length).toBeGreaterThan(0);
    expect(l.excerpts.map((e) => e.id)).toEqual(l.excerpts.map((_, i) => `S${i + 1}`));
    expect(l.excerpts[0]).toMatchObject({ title: 'Turbine manual.pdf', sourceName: 'Docs', location: 'Folder' });
    const total = l.excerpts.reduce((n, e) => n + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(24_000);
    const planner = calls.filter((c) => c.prompt.startsWith("You are preparing keyword searches"));
    expect(planner).toHaveLength(1);
    const members = calls.filter((c) => c.prompt.includes('## Your task (round 1'));
    expect(members).toHaveLength(3);
    for (const c of members) {
      expect(c.prompt).toContain("## Source material from the user's library");
      expect(c.prompt).toContain('<source id="S1" title="');
      expect(c.browseDir).toBeUndefined();
    }
    const arbiter = calls.find((c) => c.prompt.includes('the arbiter of a council'))!;
    expect(arbiter.prompt).toContain("keep the citations ([S1], [D1] or file paths)");
    expect(arbiter.prompt).toContain('<source id="S1"');
    // The mock cites the first passage, so citations reach the answer.
    expect(turn.finalText).toContain('[S1]');
  });

  it('keeps citation ids stable across turns and continues the numbering for new passages', async () => {
    await freshLibrary();
    const settings = baseSettings((s) => {
      s.library.excerptChars = 2_000;
    });
    const first = await runOne({ library: lib, settings, message: 'turbine' });
    const firstIds = new Map(first.turn.library!.excerpts.map((e) => [(e as { key?: string }).key, e.id]));
    expect(firstIds.size).toBeGreaterThan(0);
    const second = await runOne({ library: lib, settings, message: 'turbine', history: [first.turn] });
    for (const e of second.turn.library!.excerpts) {
      expect(e.id).toBe(firstIds.get((e as { key?: string }).key));
    }
    const third = await runOne({ library: lib, settings, message: 'budget', history: [first.turn, second.turn] });
    const maxFirst = Math.max(...first.turn.library!.excerpts.map((e) => Number(e.id.slice(1))));
    const fresh = third.turn.library!.excerpts.filter((e) => !firstIds.has((e as { key?: string }).key));
    expect(fresh.length).toBeGreaterThan(0);
    for (const e of fresh) expect(Number(e.id.slice(1))).toBeGreaterThan(maxFirst);
    // History mentions the earlier citations.
    const prompt = third.calls.find((c) => c.prompt.includes('## Your task (round 1'))!.prompt;
    expect(prompt).toContain("## Conversation so far\nEarlier answers cite the user's documents as [S…] and [D…]");
  });

  it('includes an earlier passage the question mentions by id, even if the search does not find it', async () => {
    await freshLibrary();
    const first = await runOne({ library: lib, message: 'budget facts' });
    const s1 = first.turn.library!.excerpts.find((e) => e.id === 'S1')!;
    const later = await runOne({ library: lib, message: 'Explain [S1] again, and nothing about zebras', history: [first.turn] });
    const again = later.turn.library!.excerpts.find((e) => e.id === 'S1');
    expect(again?.text).toBe(s1.text);
    expect(later.turn.library!.excerpts.filter((e) => e.id === 'S1')).toHaveLength(1);
  });

  it('shares the attachment budget in order, cuts at a boundary, and explains what was left out', async () => {
    await freshLibrary();
    const big = 'x'.repeat(3_000);
    await lib.add(
      fakeDoc('c'.repeat(20), 'One.docx', [{ label: '', text: `${big}\n\n${big}` }]),
      fakeDoc('d'.repeat(20), 'Two.docx', [{ label: '', text: `${big}\n\n${big}\n\n${big}` }]),
      fakeDoc('e'.repeat(20), 'Three.docx', [{ label: '', text: big }]),
      fakeDoc('f'.repeat(20), 'Scan.pdf', [], { status: 'empty', detail: 'This PDF has no text layer; it is probably a scan.' }),
      fakeDoc('9'.repeat(20), 'Off.pdf', [{ label: '', text: 'hidden' }], { sourceId: 'off' }),
    );
    const settings = baseSettings((s) => {
      s.library.mode = 'off';
      s.library.attachmentChars = 10_000;
      s.library.sources.push({ id: 'off', kind: 'folder', name: 'Archive', enabled: false, path: '/archive' });
    });
    const { turn, calls } = await runOne({
      library: lib,
      settings,
      message: 'Compare the documents',
      attachments: ['c'.repeat(20), 'd'.repeat(20), 'e'.repeat(20), 'f'.repeat(20), '9'.repeat(20), 'unknown-id'],
    });
    const a = turn.library!.attachments;
    expect(turn.library!.mode).toBe('off');
    expect(turn.library!.excerpts).toEqual([]);
    expect(a.map((x) => x.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
    expect(a[0]).toMatchObject({ title: 'One.docx', truncated: false, problem: '', chars: 6_002 });
    expect(a[1]!.truncated).toBe(true);
    expect(a[1]!.chars).toBeLessThanOrEqual(10_000 - 6_002);
    expect(a[2]!.problem).toBe(BUDGET_USED);
    expect(a[3]!.problem).toBe('It has no readable text: This PDF has no text layer; it is probably a scan.');
    expect(a[4]!.problem).toBe('Its source, “Archive”, is turned off in Settings → Library.');
    expect(a[5]).toMatchObject({ title: 'Unknown document', problem: 'This document is no longer in the library.' });
    const prompt = calls.find((c) => c.prompt.includes('## Your task (round 1'))!.prompt;
    expect(prompt).toContain('## Documents attached by the user\nThe user attached 2 documents to this question. Read them in full and cite one as [D1]');
    expect(prompt).toContain('Text marked as cut was too long to include in full.');
    expect(prompt).toContain(CUT_MARKER);
    expect(prompt).toContain('Not included: Three.docx — the attachment budget was already used by the documents before it.');
    expect(prompt).not.toContain("## Source material from the user's library");
  });

  it('does not repeat a fully attached document as passages', async () => {
    await freshLibrary();
    const { turn } = await runOne({ library: lib, message: 'budget turbine facts', attachments: ['b'.repeat(20)] });
    expect(turn.library!.attachments[0]!.problem).toBe('');
    expect(turn.library!.excerpts.length).toBeGreaterThan(0);
    expect(turn.library!.excerpts.some((e) => e.documentId === 'b'.repeat(20))).toBe(false);
  });

  it('reuses an attachment id for the same document in a later turn', async () => {
    await freshLibrary();
    const first = await runOne({ library: lib, message: 'turbine', attachments: ['b'.repeat(20)] });
    expect(first.turn.library!.attachments[0]!.id).toBe('D1');
    const second = await runOne({ library: lib, message: 'turbine', attachments: ['a'.repeat(20), 'b'.repeat(20)], history: [first.turn] });
    expect(second.turn.library!.attachments.map((x) => x.id)).toEqual(['D2', 'D1']);
  });

  it('notes a planner failure and searches with the question alone', async () => {
    await freshLibrary();
    const settings = baseSettings((s) => {
      s.library.planner.model = 'fail+instant';
    });
    const { turn } = await runOne({ library: lib, settings, message: 'turbine facts' });
    expect(turn.status).toBe('complete');
    expect(turn.library!.status).toBe('done');
    expect(turn.library!.queries).toEqual(['turbine facts']);
    expect(turn.library!.plannerNote).toBe('The search planner (Demo) failed: Mock failure. Searched with the question as typed.');
    expect(turn.library!.excerpts.length).toBeGreaterThan(0);
  });

  it('does not call the planner when it is turned off', async () => {
    await freshLibrary();
    const settings = baseSettings((s) => {
      s.library.planner.enabled = false;
    });
    const { turn, calls } = await runOne({ library: lib, settings, message: 'turbine facts' });
    expect(calls.some((c) => c.prompt.startsWith('You are preparing'))).toBe(false);
    expect(turn.library!.queries).toEqual(['turbine facts']);
    expect(turn.library!.plannerNote).toBe('');
  });

  it('degrades the turn’s library on a search failure but never fails the turn', async () => {
    await freshLibrary();
    lib.failSearch = new Error('index exploded');
    const { turn, calls } = await runOne({ library: lib, message: 'turbine', attachments: ['b'.repeat(20)] });
    expect(turn.status).toBe('complete');
    expect(turn.library!.status).toBe('error');
    expect(turn.library!.error).toBe('The library could not be searched: index exploded.');
    // What was gathered before the failure is kept.
    expect(turn.library!.attachments).toHaveLength(1);
    const prompt = calls.find((c) => c.prompt.includes('## Your task (round 1'))!.prompt;
    expect(prompt).not.toContain("## Source material from the user's library");
    expect(prompt).toContain('## Documents attached by the user');
  });

  it('reports a missing library instead of failing', async () => {
    const { turn } = await runOne({ library: null, message: 'anything' });
    expect(turn.status).toBe('complete');
    expect(turn.library).toMatchObject({ status: 'error', error: 'The document library is not available.' });
  });

  it('says nothing was found when the search comes back empty', async () => {
    await freshLibrary();
    const { turn, calls } = await runOne({ library: lib, message: 'zebras and giraffes' });
    expect(turn.library!.excerpts).toEqual([]);
    const prompt = calls.find((c) => c.prompt.includes('## Your task (round 1'))!.prompt;
    expect(prompt).toContain("The user's document library was searched for this question and nothing relevant was found.");
  });

  it('skips searching when no document is searchable', async () => {
    lib = new FakeLibrary();
    const { turn, calls } = await runOne({ library: lib, message: 'turbine' });
    expect(lib.searches).toEqual([]);
    expect(turn.library).toMatchObject({ status: 'done', excerpts: [], queries: [] });
    expect(calls.some((c) => c.prompt.startsWith('You are preparing'))).toBe(false);
  });

  it('runs in direct mode too', async () => {
    await freshLibrary();
    const { turn, calls } = await runOne({ library: lib, message: '@Claude turbine facts' });
    expect(turn.mode).toBe('direct');
    expect(turn.library!.excerpts.length).toBeGreaterThan(0);
    expect(calls.find((c) => c.prompt.includes('## Your task'))!.prompt).toContain('<source id="S1"');
  });

  it('gives the mirror only to providers that can browse', async () => {
    await freshLibrary();
    const settings = baseSettings((s) => {
      s.library.mode = 'browse';
      s.members[2]!.provider = 'plain';
    });
    const { turn, calls } = await runOne({ library: lib, settings, message: 'turbine facts' });
    expect(turn.library!.browsableDocuments).toBe(2);
    const round1 = calls.filter((c) => c.prompt.includes('## Your task (round 1'));
    const mock = round1.filter((c) => c.provider === 'mock');
    const plain = round1.filter((c) => c.provider === 'plain');
    expect(mock).toHaveLength(2);
    expect(plain).toHaveLength(1);
    for (const c of mock) {
      expect(c.browseDir).toBe(browseDir);
      expect(c.prompt).toContain("## The user's document library\nThe current working directory holds the user's library as read-only text files: 2 documents");
    }
    expect(plain[0]!.browseDir).toBeUndefined();
    expect(plain[0]!.prompt).not.toContain("## The user's document library");
    expect(calls.find((c) => c.prompt.startsWith('You are preparing'))!.browseDir).toBeUndefined();
    const arbiter = calls.find((c) => c.prompt.includes('the arbiter of a council'))!;
    expect(arbiter.browseDir).toBe(browseDir);
    // The mock read INDEX.md in its working directory.
    expect(turn.rounds[0]!.responses.find((r) => r.memberId === 'm-claude')!.text).toContain('INDEX.md lists 2 documents');
  });

  it('stops during the library phase', async () => {
    await freshLibrary();
    lib.hangSearch = true;
    const { turn, events } = await runOne({ library: lib, message: 'turbine', stopWhen: (e) => e.type === 'library.start' });
    expect(turn.status).toBe('stopped');
    expect(turn.library).toMatchObject({ status: 'error', error: STOPPED_DURING_LIBRARY });
    expect(turn.rounds.every((r) => r.status === 'skipped')).toBe(true);
    expect(events.some((e) => e.type === 'round.start')).toBe(false);
  });

  it('does not allow skipping to the verdict during the library phase', () => {
    const control = new RunControl('council', true);
    expect(control.requestSkip()).toBe(false);
    control.phase = 'rounds';
    expect(control.requestSkip()).toBe(true);
  });
});

describe('citation ids', () => {
  it('continues the numbering past mentioned ids and never repeats an id within a turn', () => {
    const earlier = [
      { excerpts: [{ id: 'S1', key: 'k1' }, { id: 'S2', key: 'k2' }], attachments: [{ id: 'D1', documentId: 'doc' }] },
    ] as unknown as StoredTurnLibrary[];
    const excerpts = [
      { id: 'S2', key: 'k2' },
      { id: '', key: 'k1' },
      { id: '', key: 'k3' },
    ] as unknown as Parameters<typeof assignCitationIds>[1];
    const attachments = [{ id: '', documentId: 'doc' }, { id: '', documentId: 'other' }] as unknown as Parameters<typeof assignCitationIds>[2];
    assignCitationIds(earlier, excerpts, attachments);
    expect(excerpts.map((e) => e.id)).toEqual(['S2', 'S1', 'S3']);
    expect(attachments.map((a) => a.id)).toEqual(['D1', 'D2']);
  });

  it('finds mentions written as [S7] or S7, but not inside other words', () => {
    const earlier = [{ excerpts: [{ id: 'S7', text: 'seven' }, { id: 'S8', text: 'eight' }], attachments: [] }] as unknown as StoredTurnLibrary[];
    expect(mentionedExcerpts('see [S7]', earlier).map((e) => e.id)).toEqual(['S7']);
    expect(mentionedExcerpts('S8 and S7 please', earlier).map((e) => e.id)).toEqual(['S7', 'S8']);
    expect(mentionedExcerpts('XS7 or S70', earlier)).toEqual([]);
  });
});
