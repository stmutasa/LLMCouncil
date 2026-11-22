import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../shared/defaults';
import type { Settings } from '../../shared/types';

/** A fake server: every PUT is recorded and stored; requests resolve when released. */
const server = vi.hoisted(() => ({
  stored: null as Settings | null,
  puts: [] as Settings[],
  pending: [] as (() => void)[],
  reject: null as string | null,
}));

vi.mock('./api', () => ({
  api: {
    saveSettings: (body: Settings) =>
      new Promise<Settings>((resolve, reject) => {
        server.pending.push(() => {
          if (server.reject) {
            reject(new Error(server.reject));
            return;
          }
          server.puts.push(structuredClone(body));
          server.stored = structuredClone(body);
          resolve(structuredClone(body));
        });
      }),
    settings: () => Promise.resolve(structuredClone(server.stored!)),
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'error'),
  ApiError: Error,
}));

const { changeSettings, reloadLibrarySettings, saveLibraryChange, saveSettingsDraft } = await import('./actions');
const { getState, setState } = await import('./store');

/** Releases queued requests one by one, letting the chain advance in between. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const next = server.pending.shift();
    if (next) next();
  }
  await new Promise((r) => setTimeout(r, 0));
}

const folder = { id: 'f1', kind: 'folder' as const, name: 'Drive', enabled: true, path: '/Users/ann/My Drive' };

beforeEach(() => {
  const s = defaultSettings();
  server.stored = structuredClone(s);
  server.puts = [];
  server.pending = [];
  server.reject = null;
  setState({ settings: s });
});

describe('settings draft and immediate library changes', () => {
  it('a draft saved after a source was added keeps the source and the draft edits', async () => {
    const opened = structuredClone(getState().settings!);
    const draft: Settings = { ...opened, councilRules: 'Be brief.', library: { ...opened.library, excerptChars: 30_000 } };

    const added = saveLibraryChange((s) => ({ ...s, library: { ...s.library, sources: [...s.library.sources, folder] } }));
    await flush();
    await added;
    expect(getState().settings!.library.sources).toEqual([folder]);

    const saved = saveSettingsDraft(draft);
    await flush();
    await saved;
    const last = server.puts.at(-1)!;
    expect(last.library.sources).toEqual([folder]);
    expect(last.library.excerptChars).toBe(30_000);
    expect(last.councilRules).toBe('Be brief.');
    expect(getState().settings!.library.sources).toEqual([folder]);
  });

  it('the library mode and save location chosen elsewhere survive a draft save', async () => {
    const draft = structuredClone(getState().settings!);
    changeSettings((s) => ({ ...s, library: { ...s.library, mode: 'browse' } }), 'the library setting');
    const parent = saveLibraryChange((s) => ({ ...s, library: { ...s.library, notionSaveParent: { id: 'p1', title: 'Answers' } } }));
    await flush();
    await parent;
    const saved = saveSettingsDraft(draft);
    await flush();
    await saved;
    const last = server.puts.at(-1)!;
    expect(last.library.mode).toBe('browse');
    expect(last.library.notionSaveParent).toEqual({ id: 'p1', title: 'Answers' });
  });

  it('a composer change made while a library change is in flight is not lost', async () => {
    const added = saveLibraryChange((s) => ({ ...s, library: { ...s.library, sources: [folder] } }));
    await new Promise((r) => setTimeout(r, 0));
    // The library request is now in flight; the user toggles web search meanwhile.
    changeSettings((s) => ({ ...s, webSearch: true }), 'the web search setting');
    await flush();
    await added;
    const state = getState().settings!;
    expect(state.webSearch).toBe(true);
    expect(state.library.sources).toEqual([folder]);
    expect(server.stored!.webSearch).toBe(true);
    expect(server.stored!.library.sources).toEqual([folder]);
  });

  it('a rejected library change applies nothing and reports the server message', async () => {
    server.reject = 'library.sources: "/" cannot be a source.';
    const added = saveLibraryChange((s) => ({ ...s, library: { ...s.library, sources: [{ ...folder, path: '/' }] } }));
    const result = added.catch((err: Error) => err.message);
    await flush();
    expect(await result).toBe('library.sources: "/" cannot be a source.');
    expect(getState().settings!.library.sources).toEqual([]);
  });

  it('re-reading settings after the server added a source keeps unsaved local changes', async () => {
    server.stored = { ...server.stored!, library: { ...server.stored!.library, sources: [{ id: 'n', kind: 'notion', name: 'Notion', enabled: true }] } };
    setState((s) => ({ settings: { ...s.settings!, webSearch: true } }));
    const done = reloadLibrarySettings();
    await flush();
    await done;
    expect(getState().settings!.library.sources.map((s) => s.kind)).toEqual(['notion']);
    expect(getState().settings!.webSearch).toBe(true);
  });
});
