import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Conversation, LibraryStatus, RunEvent, SendTurnResponse, Settings, Turn } from '../../shared/types';
import { createApp, type CouncilApp } from '../app';
import { extractFile } from './extract/formats';
import type { Extractor } from './extract/extractor';
import type { FetchFn } from './notionClient';
import { docIdFor } from './store';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const TOKEN = 'ntn_VERY_SECRET_TOKEN_0123456789';

interface Res {
  status: number;
  body: string;
  json: () => any;
}

let dir: string;
let docs: string;
let home: string;
let council: CouncilApp;
let server: http.Server;
let port: number;
const spawned: { command: string; args: string[] }[] = [];
const allResponses: string[] = [];
let notionMode: 'ok' | 'reject' = 'ok';
const created: unknown[] = [];

const extractor: Extractor = { extract: (file, type, _signal, root) => extractFile(file, type, root), stop: () => undefined };

const notionFetch: FetchFn = async (url, init) => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const auth = (init.headers as Record<string, string>).Authorization;
  if (notionMode === 'reject' || auth !== `Bearer ${TOKEN}`) return json(401, { message: 'API token is invalid.', code: 'unauthorized' });
  if (url.endsWith('/v1/users/me')) return json(200, { object: 'user', name: 'Council bot', type: 'bot', bot: { workspace_name: 'Acme HQ' } });
  if (url.endsWith('/v1/search')) {
    const body = JSON.parse(String(init.body));
    if (body.filter?.value === 'data_source') return json(200, { results: [], has_more: false });
    return json(200, {
      results: [
        {
          object: 'page',
          id: 'page-1',
          url: 'https://notion.so/page-1',
          last_edited_time: '2026-05-01T00:00:00.000Z',
          parent: { type: 'workspace', workspace: true },
          properties: { title: { type: 'title', title: [{ plain_text: 'Planning wiki' }] } },
        },
      ],
      has_more: false,
    });
  }
  if (url.includes('/v1/pages/page-1/markdown')) return json(200, { markdown: '# Planning\n\nThe offsite is in Lisbon.', truncated: false, unknown_block_ids: [] });
  if (url.endsWith('/v1/pages') && init.method === 'POST') {
    created.push(JSON.parse(String(init.body)));
    return json(200, { object: 'page', id: 'new-page', url: 'https://notion.so/new-page' });
  }
  return json(404, { message: 'Not found' });
};

function request(method: string, url: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (data !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(data));
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        allResponses.push(text);
        resolve({ status: res.statusCode!, body: text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
const get = (url: string) => request('GET', url);
const post = (url: string, body?: unknown) => request('POST', url, body);

async function settings(): Promise<Settings> {
  return (await get('/api/settings')).json() as Settings;
}

async function put(mutate: (s: Settings) => void): Promise<Res> {
  const s = await settings();
  mutate(s);
  return request('PUT', '/api/settings', s);
}

async function libraryIdle(): Promise<LibraryStatus> {
  for (let i = 0; i < 500; i++) {
    const st = (await get('/api/library')).json() as LibraryStatus;
    if (!council.library.syncing && st.sources.every((s) => !s.sync.running)) return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the library did not finish syncing');
}

function waitForTurn(cid: string, tid: string): Promise<Turn> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: `/api/conversations/${cid}/turns/${tid}/events`, headers: { host: `localhost:${port}` } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
          allResponses.push(c);
        });
        res.on('end', () => {
          const events = buf
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => JSON.parse(l.slice(6)) as RunEvent);
          const end = events.find((e) => e.type === 'turn.end') as Extract<RunEvent, { type: 'turn.end' }> | undefined;
          if (end) resolve(end.turn);
          else reject(new Error('no turn.end'));
        });
      })
      .on('error', reject);
  });
}

const logged: string[] = [];

beforeAll(async () => {
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  dir = await mkdtemp(path.join(os.tmpdir(), 'council-libhttp-'));
  docs = await mkdtemp(path.join(os.tmpdir(), 'council-libhttp-docs-'));
  home = await mkdtemp(path.join(os.tmpdir(), 'council-libhttp-home-'));
  await mkdir(path.join(docs, 'Board'), { recursive: true });
  for (const f of ['report.pdf', 'report.docx', 'drive-doc.gdoc', 'scan.pdf']) await copyFile(path.join(FIXTURES, f), path.join(docs, f));
  await copyFile(path.join(FIXTURES, 'deck.pptx'), path.join(docs, 'Board', 'deck.pptx'));
  for (const d of ['Documents', 'Downloads', 'Google Drive', '.hidden', 'Projects']) await mkdir(path.join(home, d));
  await writeFile(path.join(home, 'secret-file.txt'), 'must never be listed');
  council = await createApp({
    dataDir: dir,
    mock: true,
    staticDir: null,
    coalesceMs: 10,
    rng: () => 0.3,
    library: {
      extractor,
      notionFetch,
      notionSleep: async () => undefined,
      autoSync: false,
      spawner: (command, args) => void spawned.push({ command, args }),
      dirs: { home, platform: 'linux' },
      browseDir: path.join(dir, 'test-cache', 'browse'),
    },
  });
  server = council.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  port = (server.address() as AddressInfo).port;
  const res = await put((s) => {
    for (const m of s.members) m.model = 'instant';
    s.arbiter.model = 'instant';
    s.library.planner.model = 'instant';
  });
  expect(res.status).toBe(200);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await council.shutdown();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
  await rm(docs, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('library settings validation', () => {
  it('rejects bad library settings with precise messages', async () => {
    const cases: [(s: Settings) => void, RegExp][] = [
      [(s) => void s.library.sources.push({ id: 'a', kind: 'folder', name: 'A', enabled: true, path: 'relative/path' }), /not a full path/],
      [(s) => void s.library.sources.push({ id: 'a', kind: 'folder', name: 'A', enabled: true, path: '/' }), /top of a drive/],
      [(s) => void s.library.sources.push({ id: 'a', kind: 'folder', name: 'A', enabled: true, path: dir }), /contains the app's own data folder/],
      [(s) => void s.library.sources.push({ id: 'a', kind: 'folder', name: 'A', enabled: true, path: path.dirname(dir) }), /contains the app's own data folder/],
      [
        (s) => {
          s.library.sources.push({ id: 'a', kind: 'folder', name: 'A', enabled: true, path: docs });
          s.library.sources.push({ id: 'b', kind: 'folder', name: 'a', enabled: true, path: home });
        },
        /Two library sources are named/,
      ],
      [
        (s) => {
          s.library.sources.push({ id: 'a', kind: 'folder', name: 'A', enabled: true, path: docs });
          s.library.sources.push({ id: 'a', kind: 'folder', name: 'B', enabled: true, path: home });
        },
        /share the id/,
      ],
      [
        (s) => {
          s.library.sources.push({ id: 'a', kind: 'folder', name: 'A', enabled: true, path: docs });
          s.library.sources.push({ id: 'b', kind: 'folder', name: 'B', enabled: true, path: path.join(docs, 'Board') });
        },
        /overlap/,
      ],
      [
        (s) => {
          s.library.sources.push({ id: 'n1', kind: 'notion', name: 'N1', enabled: true });
          s.library.sources.push({ id: 'n2', kind: 'notion', name: 'N2', enabled: true });
        },
        /only one Notion source/,
      ],
      [(s) => void s.library.sources.push({ id: 'a', kind: 'folder', name: ' ', enabled: true, path: docs }), /needs a name/],
      [(s) => void s.library.sources.push({ id: 'a b', kind: 'folder', name: 'A', enabled: true, path: docs }), /id "a b" is not valid/],
      [(s) => void s.library.sources.push({ id: 'a', kind: 'folder', name: 'x'.repeat(61), enabled: true, path: docs }), /at most 60/],
      [(s) => void (s.library.mode = 'everything' as 'off'), /library\.mode/],
      [(s) => void (s.library.excerptChars = 100), /passage budget/],
      [(s) => void (s.library.attachmentChars = 2_000_000), /attachment budget/],
      [(s) => void (s.library.autoSyncMinutes = 3), /every 5 to 1,440 minutes/],
      [(s) => void (s.library.planner.provider = 'nope'), /search planner uses the provider "nope"/],
      [(s) => void (s.library.planner.model = '-rf'), /search planner: the model/],
      [(s) => void (s.library.notionSaveParent = { id: '', title: 'x' }), /invalid id/],
      [(s) => void (s.library.notionSaveParent = { id: 'p', title: 'x'.repeat(301) }), /too long/],
      [(s) => void (s.library.sources = Array.from({ length: 21 }, (_, i) => ({ id: `n${i}`, kind: 'folder' as const, name: `N${i}`, enabled: true, path: `/x${i}` }))), /at most 20 sources/],
    ];
    for (const [mutate, pattern] of cases) {
      const res = await put(mutate);
      expect(res.status, String(pattern)).toBe(400);
      expect(res.json().error).toMatch(pattern);
    }
  });

  it('accepts a folder that does not exist (an unplugged drive) and reports it as not ready', async () => {
    const res = await put((s) => void s.library.sources.push({ id: 'usb', kind: 'folder', name: 'USB drive', enabled: true, path: '/media/nothing-here/Docs' }));
    expect(res.status).toBe(200);
    const st = await libraryIdle();
    const usb = st.sources.find((s) => s.source.id === 'usb')!;
    expect(usb.ready).toBe(false);
    expect(usb.readyDetail).toMatch(/does not exist/);
    const sync = await post('/api/library/sources/usb/sync');
    expect(sync.status).toBe(409);
    expect(sync.json().error).toMatch(/does not exist/);
    expect((await put((s) => void (s.library.sources = s.library.sources.filter((x) => x.id !== 'usb')))).status).toBe(200);
  });
});

describe('library endpoints', () => {
  it('reads a folder added through the settings and reports its documents', async () => {
    const res = await put((s) => void s.library.sources.push({ id: 'docs', kind: 'folder', name: 'Work', enabled: true, path: docs }));
    expect(res.status).toBe(200);
    const st = await libraryIdle();
    expect(st.supportedTypes).toContain('pdf');
    const work = st.sources.find((s) => s.source.id === 'docs')!;
    expect(work.ready).toBe(true);
    expect(work.counts).toEqual({ ok: 3, empty: 1, unsupported: 0, stub: 1, 'too-large': 0, error: 0 });
    expect(work.lastSyncedAt).not.toBeNull();
    expect(st.documents).toBe(3);
  });

  it('lists, filters and pages documents and validates the query', async () => {
    const all = (await get('/api/library/documents')).json();
    expect(all.total).toBe(5);
    const ok = (await get('/api/library/documents?status=ok&q=board')).json();
    expect(ok.documents.map((d: { title: string }) => d.title)).toEqual(['deck.pptx']);
    expect((await get('/api/library/documents?status=stub,empty')).json().total).toBe(2);
    expect((await get('/api/library/documents?limit=2&offset=1')).json().documents).toHaveLength(2);
    expect((await get('/api/library/documents?limit=500')).json().documents).toHaveLength(5);
    expect((await get('/api/library/documents?status=nope')).status).toBe(400);
    expect((await get('/api/library/documents?limit=abc')).status).toBe(400);
    expect((await get('/api/library/documents?limit=0')).status).toBe(400);
    expect((await get('/api/library/documents?q=a&q=b')).status).toBe(400);
  });

  it('returns a document’s text with part headings', async () => {
    const res = await get(`/api/library/documents/${docIdFor('docs', 'report.pdf')}/text`);
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.text.startsWith('## Page 1\n\nChapter 1: Quarterly Findings')).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.document.title).toBe('report.pdf');
    expect((await get(`/api/library/documents/${'0'.repeat(20)}/text`)).status).toBe(404);
    expect((await get('/api/library/documents/..%2F..%2Fsettings/text')).status).toBe(404);
  });

  it('searches the library for the "try a search" box', async () => {
    const res = await post('/api/library/search', { query: 'revenue grew 21 percent' });
    expect(res.status).toBe(200);
    const { excerpts } = res.json();
    expect(excerpts[0]).toMatchObject({ id: 'S1', title: 'report.pdf', sourceName: 'Work', part: 'p. 3' });
    expect(excerpts[0].key).toBeUndefined();
    expect((await post('/api/library/search', { query: '  ' })).status).toBe(400);
    expect((await post('/api/library/search', {})).status).toBe(400);
    expect((await post('/api/library/search', { query: 'x'.repeat(1001) })).status).toBe(400);
  });

  it('syncs and cancels on request', async () => {
    expect((await post('/api/library/sources/docs/sync')).status).toBe(204);
    expect((await post('/api/library/sources/docs/cancel')).status).toBe(204);
    expect((await post('/api/library/sources/unknown/sync')).status).toBe(404);
    expect((await post('/api/library/sources/unknown/cancel')).status).toBe(204);
    await libraryIdle();
    await post('/api/library/sources/docs/sync');
    await libraryIdle();
  });

  it('reveals only manifest documents, without a shell', async () => {
    spawned.length = 0;
    const id = docIdFor('docs', 'Board/deck.pptx');
    expect((await post(`/api/library/documents/${id}/reveal`)).status).toBe(204);
    expect(spawned).toEqual([{ command: 'xdg-open', args: [path.join(docs, 'Board')] }]);
    expect((await post(`/api/library/documents/${'1'.repeat(20)}/reveal`)).status).toBe(404);
    expect((await post('/api/library/documents/not-an-id/reveal')).status).toBe(404);
    expect((await post(`/api/library/documents/${encodeURIComponent('/etc/passwd')}/reveal`)).status).toBe(404);
    expect(spawned).toHaveLength(1);
  });

  it('lists directories only, never files, with shortcuts', async () => {
    const res = (await get(`/api/fs/dirs?path=${encodeURIComponent(home)}`)).json();
    expect(res.error).toBeNull();
    expect(res.dirs.map((d: { name: string }) => d.name)).toEqual(['Documents', 'Downloads', 'Google Drive', 'Projects']);
    expect(JSON.stringify(res)).not.toContain('secret-file');
    expect(res.parent).toBe(path.dirname(home));
    expect(res.shortcuts).toEqual([
      { label: 'Google Drive', path: path.join(home, 'Google Drive') },
      { label: 'Home', path: home },
      { label: 'Documents', path: path.join(home, 'Documents') },
      { label: 'Downloads', path: path.join(home, 'Downloads') },
    ]);
    expect((await get('/api/fs/dirs')).json().path).toBe(home);
    const file = (await get(`/api/fs/dirs?path=${encodeURIComponent(path.join(home, 'secret-file.txt'))}`)).json();
    expect(file.dirs).toEqual([]);
    expect(file.error).toMatch(/file, not a folder/);
    const missing = (await get(`/api/fs/dirs?path=${encodeURIComponent(path.join(home, 'nope'))}`)).json();
    expect(missing.error).toMatch(/does not exist/);
    expect((await get('/api/fs/dirs?path=relative')).json().error).toMatch(/full path/);
    expect((await get('/api/fs/dirs?path=/')).json().parent).toBeNull();
  });
});

describe('turns that use the library', () => {
  it('searches, attaches, persists the library and keeps attachments on regenerate', async () => {
    const attachments = [docIdFor('docs', 'report.docx')];
    const res = await post('/api/turns', { message: 'How much did revenue grow on page 2?', attachments });
    expect(res.status).toBe(200);
    const sent = res.json() as SendTurnResponse;
    // The run has started by the time the response is sent, so the library phase is under way.
    expect(sent.turn.library).toMatchObject({ mode: 'search', status: 'running', attachments: [] });
    const turn = await waitForTurn(sent.conversation.id, sent.turn.id);
    expect(turn.status).toBe('complete');
    expect(turn.library!.status).toBe('done');
    expect(turn.library!.excerpts.length).toBeGreaterThan(0);
    expect(turn.library!.attachments).toMatchObject([{ id: 'D1', title: 'report.docx', problem: '', truncated: false }]);
    const stored = (await get(`/api/conversations/${sent.conversation.id}`)).json() as Conversation;
    expect(stored.turns[0]!.library).toEqual(turn.library);

    const regen = await post(`/api/conversations/${sent.conversation.id}/turns/${turn.id}/regenerate`);
    expect(regen.status).toBe(200);
    const again = await waitForTurn(sent.conversation.id, (regen.json() as SendTurnResponse).turn.id);
    expect(again.library!.attachments.map((a) => a.documentId)).toEqual(attachments);
    // The regenerated turn does not see its earlier incarnation's ids: numbering starts again.
    expect(again.library!.attachments[0]!.id).toBe('D1');
    expect(again.library!.excerpts[0]!.id).toBe('S1');
  });

  it('rejects malformed attachments', async () => {
    expect((await post('/api/turns', { message: 'x', attachments: 'nope' })).status).toBe(400);
    expect((await post('/api/turns', { message: 'x', attachments: [1] })).status).toBe(400);
    expect((await post('/api/turns', { message: 'x', attachments: Array.from({ length: 21 }, (_, i) => `d${i}`) })).status).toBe(400);
  });

  it('lets capable members browse the mirror in browse mode', async () => {
    expect((await put((s) => void (s.library.mode = 'browse'))).status).toBe(200);
    const res = (await post('/api/turns', { message: '@Claude what is in the deck?' })).json() as SendTurnResponse;
    const turn = await waitForTurn(res.conversation.id, res.turn.id);
    expect(turn.library!.browsableDocuments).toBe(3);
    expect(turn.finalText).toContain('INDEX.md lists 3 documents');
    const index = await readFile(path.join(dir, 'test-cache', 'browse', 'INDEX.md'), 'utf8');
    expect(index).toContain('- Work/Board/deck.pptx.md — deck.pptx (Work, 11 slides,');
    expect((await stat(path.join(dir, 'test-cache', 'browse', 'Work', 'report.pdf.md'))).mode & 0o222).toBe(0);
    expect((await put((s) => void (s.library.mode = 'search'))).status).toBe(200);
  });

  it('does not let skip-to-verdict apply during the library phase', async () => {
    await put((s) => {
      s.library.planner.model = 'slow';
    });
    const res = (await post('/api/turns', { message: 'revenue' })).json() as SendTurnResponse;
    const skip = await post(`/api/conversations/${res.conversation.id}/turns/${res.turn.id}/skip`);
    expect(skip.status).toBe(409);
    expect(skip.json().error).toMatch(/library is still being searched/);
    expect((await post(`/api/conversations/${res.conversation.id}/turns/${res.turn.id}/stop`)).status).toBe(204);
    const turn = await waitForTurn(res.conversation.id, res.turn.id);
    expect(turn.status).toBe('stopped');
    expect(turn.library!.status).toBe('error');
    await put((s) => {
      s.library.planner.model = 'instant';
    });
  });

  it('loads conversation files written before the library existed', async () => {
    const res = (await post('/api/turns', { message: 'plain question' })).json() as SendTurnResponse;
    await waitForTurn(res.conversation.id, res.turn.id);
    const file = path.join(dir, 'conversations', `${res.conversation.id}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    delete raw.turns[0].library;
    await writeFile(file, JSON.stringify(raw));
    const loaded = (await get(`/api/conversations/${res.conversation.id}`)).json() as Conversation;
    expect(loaded.turns[0]!.library).toBeNull();
    expect((await get('/api/conversations')).json().some((c: { id: string }) => c.id === res.conversation.id)).toBe(true);
  });
});

describe('Notion', () => {
  it('rejects a token Notion refuses, with Notion’s message', async () => {
    notionMode = 'reject';
    const res = await request('PUT', '/api/library/notion/token', { token: 'ntn_wrong' });
    expect(res.status).toBe(400);
    expect(res.json().error).toBe('Notion rejected the token. It may have expired or been revoked.');
    expect((await get('/api/library/notion')).json()).toEqual({ connected: false, workspace: '', identity: '', error: null });
    notionMode = 'ok';
    expect((await request('PUT', '/api/library/notion/token', { token: '' })).status).toBe(400);
  });

  it('connects, adds a Notion source and reads its pages', async () => {
    const res = await request('PUT', '/api/library/notion/token', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ connected: true, workspace: 'Acme HQ', identity: 'Council bot', error: null });
    const s = await settings();
    const notion = s.library.sources.find((x) => x.kind === 'notion')!;
    expect(notion).toMatchObject({ name: 'Notion', enabled: true });
    const st = await libraryIdle();
    expect(st.sources.find((x) => x.source.id === notion.id)!.counts.ok).toBe(1);
    const found = (await post('/api/library/search', { query: 'offsite Lisbon' })).json();
    expect(found.excerpts[0]).toMatchObject({ title: 'Planning wiki', url: 'https://notion.so/page-1', sourceName: 'Notion' });
    const reveal = await post(`/api/library/documents/${docIdFor(notion.id, 'page-1')}/reveal`);
    expect(reveal.status).toBe(400);
    expect((await get('/api/library/notion/pages?q=plan')).json()).toEqual({
      pages: [{ id: 'page-1', title: 'Planning wiki', url: 'https://notion.so/page-1' }],
    });
  });

  it('saves an answer under the chosen page', async () => {
    const res = (await post('/api/turns', { message: 'Where is the offsite?' })).json() as SendTurnResponse;
    const turn = await waitForTurn(res.conversation.id, res.turn.id);
    const url = `/api/conversations/${res.conversation.id}/turns/${turn.id}/notion`;
    const unset = await post(url, { includeDeliberation: false });
    expect(unset.status).toBe(400);
    expect(unset.json().error).toBe('Choose a Notion page to save under first.');
    expect((await put((s) => void (s.library.notionSaveParent = { id: 'page-1', title: 'Planning wiki' }))).status).toBe(200);
    expect((await post(url, { includeDeliberation: 'yes' })).status).toBe(400);
    const saved = await post(url, { includeDeliberation: true });
    expect(saved.status).toBe(200);
    expect(saved.json()).toEqual({ url: 'https://notion.so/new-page', title: res.conversation.title });
    const body = created[created.length - 1] as { parent: unknown; markdown: string };
    expect(body.parent).toEqual({ page_id: 'page-1' });
    expect(body.markdown).toContain('## Question\n\nWhere is the offsite?');
    expect(body.markdown).toContain('## Deliberation');
    expect((await post(`/api/conversations/${res.conversation.id}/turns/00000000-0000-0000-0000-000000000000/notion`, {})).status).toBe(404);
  });

  it('never exposes the token: not in responses, settings.json, conversations or logs', async () => {
    for (const body of allResponses) expect(body).not.toContain(TOKEN);
    for (const line of logged) expect(line).not.toContain(TOKEN);
    expect(await readFile(path.join(dir, 'settings.json'), 'utf8')).not.toContain(TOKEN);
    for (const f of await readdir(path.join(dir, 'conversations'))) {
      expect(await readFile(path.join(dir, 'conversations', f), 'utf8')).not.toContain(TOKEN);
    }
    expect(await readFile(path.join(dir, 'library', 'manifest.json'), 'utf8')).not.toContain(TOKEN);
    const secrets = path.join(dir, 'secrets.json');
    expect(JSON.parse(await readFile(secrets, 'utf8'))).toEqual({ notionToken: TOKEN });
    if (process.platform !== 'win32') expect((await stat(secrets)).mode & 0o777).toBe(0o600);
  });

  it('disconnects but keeps the source and its documents', async () => {
    expect((await request('DELETE', '/api/library/notion/token')).status).toBe(204);
    expect((await get('/api/library/notion')).json().connected).toBe(false);
    const st = (await get('/api/library')).json() as LibraryStatus;
    const notion = st.sources.find((s) => s.source.kind === 'notion')!;
    expect(notion.counts.ok).toBe(1);
    expect(notion.ready).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, 'secrets.json'), 'utf8'))).toEqual({});
    expect((await get('/api/library/notion/pages?q=x')).status).toBe(400);
  });
});
