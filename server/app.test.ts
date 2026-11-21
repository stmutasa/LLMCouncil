import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation, ProviderInfo, RunEvent, SendTurnResponse, Settings, Turn } from '../shared/types';
import { createApp, type CouncilApp } from './app';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => any;
}

let dir: string;
let council: CouncilApp;
let server: http.Server;
let port: number;

function request(method: string, url: string, opts: { headers?: Record<string, string>; body?: string | object } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (body !== undefined && typeof opts.body === 'object' && !headers['content-type']) headers['content-type'] = 'application/json';
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode!, headers: res.headers, body: data, json: () => JSON.parse(data) }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const get = (url: string) => request('GET', url);
const post = (url: string, body?: object) => request('POST', url, body === undefined ? {} : { body });

/** Reads an SSE stream until turn.end (or `stopAfter` returns true). */
function readEvents(
  url: string,
  onEvent?: (e: RunEvent, all: RunEvent[]) => void,
): Promise<{ events: RunEvent[]; headers: http.IncomingHttpHeaders; status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const events: RunEvent[] = [];
    let raw = '';
    const req = http.get({ host: '127.0.0.1', port, path: url, headers: { host: `localhost:${port}` } }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk: string) => {
        raw += chunk;
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) {
              const e = JSON.parse(line.slice(6)) as RunEvent;
              events.push(e);
              onEvent?.(e, events);
            }
          }
        }
      });
      res.on('end', () => resolve({ events, headers: res.headers, status: res.statusCode!, raw }));
    });
    req.on('error', reject);
  });
}

async function setSettings(mutate: (s: Settings) => void): Promise<Settings> {
  const s = (await get('/api/settings')).json() as Settings;
  mutate(s);
  const res = await request('PUT', '/api/settings', { body: s });
  expect(res.status).toBe(200);
  return res.json() as Settings;
}

async function fastMembers(models: Record<string, string> = {}, arbiter = 'instant') {
  await setSettings((s) => {
    for (const m of s.members) {
      m.model = models[m.name] ?? 'instant';
      m.enabled = true;
    }
    s.arbiter.model = arbiter;
    s.activeProtocolId = 'council';
  });
}

async function waitIdle(cid: string) {
  for (let i = 0; i < 200 && council.runs.has(cid); i++) await new Promise((r) => setTimeout(r, 20));
  expect(council.runs.has(cid)).toBe(false);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'council-http-'));
  council = await createApp({ dataDir: dir, mock: true, staticDir: null, coalesceMs: 10, rng: () => 0.3 });
  server = council.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await council.shutdown();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await council.shutdown();
});

describe('security middleware', () => {
  it('accepts loopback Host headers and rejects others', async () => {
    expect((await request('GET', '/api/meta', { headers: { host: `localhost:${port}` } })).status).toBe(200);
    expect((await request('GET', '/api/meta', { headers: { host: `[::1]:${port}` } })).status).toBe(200);
    expect((await request('GET', '/api/meta', { headers: { host: '127.0.0.1' } })).status).toBe(200);
    for (const host of ['evil.example', `evil.example:${port}`, 'localhost.evil.example', '127.0.0.1.nip.io', 'user@localhost']) {
      const res = await request('GET', '/api/meta', { headers: { host } });
      expect(res.status).toBe(403);
      expect(res.json().error).toMatch(/addressed to this computer/);
    }
  });

  it('checks the Origin header when present', async () => {
    expect((await request('GET', '/api/meta', { headers: { origin: 'http://localhost:5173' } })).status).toBe(200);
    for (const origin of ['http://evil.example', 'null', 'file://', 'http://127.0.0.1.evil.example']) {
      const res = await request('GET', '/api/meta', { headers: { origin } });
      expect(res.status).toBe(403);
      expect(res.json().error).toMatch(/Cross-origin/);
    }
    expect((await request('POST', '/api/turns', { headers: { origin: 'http://evil.example' }, body: { message: 'x' } })).status).toBe(403);
  });

  it('requires JSON bodies on writes and sends no CORS headers', async () => {
    const plain = await request('POST', '/api/turns', { headers: { 'content-type': 'text/plain' }, body: '{"message":"hi"}' });
    expect(plain.status).toBe(415);
    const form = await request('PUT', '/api/settings', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=b',
    });
    expect(form.status).toBe(415);
    const ok = await request('GET', '/api/meta', { headers: { origin: `http://localhost:${port}` } });
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request('POST', '/api/turns', { headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' })).status).toBe(400);
  });

  it('answers errors as JSON', async () => {
    const bad = await request('POST', '/api/turns', { headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(bad.status).toBe(400);
    expect(bad.json()).toEqual({ error: 'The request body is not valid JSON.' });
    const big = await request('PUT', '/api/settings', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(2_100_000) }) });
    expect(big.status).toBe(413);
    expect(big.json().error).toMatch(/larger than 2 MB/);
    const missing = await get('/api/nothing-here');
    expect(missing.status).toBe(404);
    expect(missing.json().error).toMatch(/no API endpoint GET \/api\/nothing-here/);
  });
});

describe('meta, settings and providers', () => {
  it('serves meta', async () => {
    const meta = (await get('/api/meta')).json();
    expect(meta).toMatchObject({ appVersion: '0.1.0', dataDir: dir, mock: true, limits: { maxMembers: 8, maxRounds: 8, maxMessageChars: 200_000 } });
    expect(meta.roles.length).toBeGreaterThan(3);
  });

  it('validates settings with precise messages', async () => {
    const s = (await get('/api/settings')).json() as Settings;
    s.members[1]!.name = 'CLAUDE';
    const res = await request('PUT', '/api/settings', { body: s });
    expect(res.status).toBe(400);
    expect(res.json().error).toBe('Two members are named "CLAUDE". Member names must be unique.');
    const shape = await request('PUT', '/api/settings', { body: { ...s, members: 'none' } });
    expect(shape.status).toBe(400);
    expect(shape.json().error).toMatch(/^Invalid settings at members:/);
    expect((await request('PUT', '/api/settings', { body: [] })).status).toBe(400);
  });

  it('saves settings and overwrites built-in protocols from code', async () => {
    const saved = await setSettings((s) => {
      s.councilRules = 'Cite sources.';
      s.protocols[0]!.name = 'Changed';
    });
    expect(saved.councilRules).toBe('Cite sources.');
    expect(saved.protocols[0]!.name).toBe('Council');
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).councilRules).toBe('Cite sources.');
    await setSettings((s) => {
      s.councilRules = '';
    });
  });

  it('lists providers, reporting missing CLIs without crashing', async () => {
    await setSettings((s) => {
      for (const id of ['claude', 'codex', 'antigravity']) {
        s.providers[id] = { command: `/nonexistent/${id}-cli`, extraArgs: [], timeoutSec: 0, promptMode: 'stdin' };
      }
    });
    const list = (await get('/api/providers?refresh=1')).json() as ProviderInfo[];
    expect(list.map((p) => p.id)).toEqual(['claude', 'codex', 'antigravity', 'mock']);
    const claude = list.find((p) => p.id === 'claude')!;
    expect(claude.installed).toBe(false);
    expect(claude.authDetail).toMatch(/`\/nonexistent\/claude-cli` was not found\. Install Claude Code/);
    expect(list.find((p) => p.id === 'mock')).toMatchObject({ installed: true, auth: 'ok', billing: 'subscription' });
  });

  it('tests a provider through its adapter', async () => {
    const res = await post('/api/providers/mock/test', { model: 'instant' });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, error: null, model: 'mock-1', billing: 'subscription' });
    const failing = (await post('/api/providers/mock/test', { model: 'instant+fail' })).json();
    expect(failing).toMatchObject({ ok: false, error: 'Mock failure' });
    expect((await post('/api/providers/nope/test', {})).status).toBe(404);
    expect((await post('/api/providers/mock/test', { model: '--evil' })).status).toBe(400);
    const missing = (await post('/api/providers/codex/test')).json();
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/was not found\. Install Codex CLI/);
  });

  it('lists models', async () => {
    const res = (await get('/api/providers/mock/models')).json();
    expect(res).toEqual({ models: [], source: 'static', error: null });
    const codex = (await get('/api/providers/codex/models')).json();
    expect(codex.source).toBe('static');
    expect(codex.models).toContain('gpt-5.5');
    expect(codex.error).toMatch(/was not found/);
    expect((await get('/api/providers/nope/models')).status).toBe(404);
  });
});

describe('turns over HTTP', () => {
  it('runs a full council turn with SSE and persists the final turn', async () => {
    await fastMembers();
    const res = await post('/api/turns', { message: 'Which database should a small team pick?' });
    expect(res.status).toBe(200);
    const body = res.json() as SendTurnResponse;
    expect(body.conversation).toMatchObject({ title: 'Which database should a small team pick?', turnCount: 1, running: true });
    expect(body.turn.status).toBe('running');
    expect(body.turn.rounds.every((r) => r.responses.length === 3)).toBe(true);

    const stream = await readEvents(`/api/conversations/${body.conversation.id}/turns/${body.turn.id}/events`);
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream');
    expect(stream.headers['cache-control']).toBe('no-cache, no-transform');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    expect(stream.events[0]!.type).toBe('snapshot');
    const last = stream.events[stream.events.length - 1]!;
    expect(last.type).toBe('turn.end');
    expect(stream.events.filter((e) => e.type === 'turn.end')).toHaveLength(1);
    const final = (last as Extract<RunEvent, { type: 'turn.end' }>).turn;
    expect(final.status).toBe('complete');

    await waitIdle(body.conversation.id);
    const conv = (await get(`/api/conversations/${body.conversation.id}`)).json() as Conversation;
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0]).toEqual(final);
    const onDisk = JSON.parse(await readFile(path.join(dir, 'conversations', `${conv.id}.json`), 'utf8')) as Conversation;
    expect(onDisk.turns[0]).toEqual(final);

    const list = (await get('/api/conversations')).json();
    expect(list[0]).toMatchObject({ id: conv.id, running: false, turnCount: 1 });

    // After the run: the stream sends turn.end alone.
    const again = await readEvents(`/api/conversations/${conv.id}/turns/${final.id}/events`);
    expect(again.events).toEqual([{ type: 'turn.end', turn: final }]);
  });

  it('gives a mid-run subscriber a snapshot consistent with the events that follow', async () => {
    await fastMembers({ Claude: '', ChatGPT: '', Gemini: '' });
    const body = (await post('/api/turns', { message: 'Explain caching.' })).json() as SendTurnResponse;
    const url = `/api/conversations/${body.conversation.id}/turns/${body.turn.id}/events`;
    let second: Promise<{ events: RunEvent[] }> | null = null;
    const first = await readEvents(url, (e) => {
      if (!second && e.type === 'member.delta') second = readEvents(url);
    });
    const late = await second!;
    expect(late.events[0]!.type).toBe('snapshot');
    const snap = (late.events[0] as Extract<RunEvent, { type: 'snapshot' }>).turn;
    expect(snap.status).toBe('running');

    // Apply the late stream's events to its snapshot: the text must match the authoritative ends.
    const texts = new Map<string, string>();
    for (const r of snap.rounds) for (const resp of r.responses) texts.set(`${r.index}:${resp.memberId}`, resp.text);
    for (const e of late.events.slice(1)) {
      if (e.type === 'member.delta') {
        const key = `${e.round}:${e.memberId}`;
        texts.set(key, e.replace ? e.text : (texts.get(key) ?? '') + e.text);
      }
      if (e.type === 'member.end') {
        expect(texts.get(`${e.round}:${e.response.memberId}`)).toBe(e.response.text);
      }
    }
    expect(late.events[late.events.length - 1]).toEqual(first.events[first.events.length - 1]);
    await waitIdle(body.conversation.id);
  });

  it('returns the live turn from GET while running, and 409 for a second turn', async () => {
    await fastMembers({ Claude: 'instant+hang' });
    const body = (await post('/api/turns', { message: 'First question' })).json() as SendTurnResponse;
    const cid = body.conversation.id;
    const live = (await get(`/api/conversations/${cid}`)).json() as Conversation;
    expect(live.turns[0]!.status).toBe('running');
    const second = await post('/api/turns', { conversationId: cid, message: 'Another' });
    expect(second.status).toBe(409);
    expect(second.json().error).toMatch(/already has a running turn/);
    const regen = await post(`/api/conversations/${cid}/turns/${body.turn.id}/regenerate`);
    expect(regen.status).toBe(409);

    const stop = await post(`/api/conversations/${cid}/turns/${body.turn.id}/stop`);
    expect(stop.status).toBe(204);
    expect(council.runs.has(cid)).toBe(false);
    const after = (await get(`/api/conversations/${cid}`)).json() as Conversation;
    expect(after.turns[0]!.status).toBe('stopped');
    expect((await post(`/api/conversations/${cid}/turns/${body.turn.id}/stop`)).status).toBe(409);
    expect((await post(`/api/conversations/${cid}/turns/${body.turn.id}/skip`)).status).toBe(409);
    expect((await post(`/api/conversations/${cid}/turns/${randomUUID()}/stop`)).status).toBe(404);
  });

  it('skips to the verdict, and refuses to in direct mode', async () => {
    await fastMembers({ Gemini: 'instant+hang' });
    const body = (await post('/api/turns', { message: 'Skip me' })).json() as SendTurnResponse;
    const url = `/api/conversations/${body.conversation.id}/turns/${body.turn.id}/events`;
    let skipped: Promise<Res> | null = null;
    const stream = await readEvents(url, (e, all) => {
      if (!skipped && all.filter((x) => x.type === 'member.end').length === 2) {
        skipped = post(`/api/conversations/${body.conversation.id}/turns/${body.turn.id}/skip`);
      }
    });
    expect((await skipped!).status).toBe(204);
    const end = stream.events[stream.events.length - 1] as Extract<RunEvent, { type: 'turn.end' }>;
    expect(end.turn.status).toBe('complete');
    expect(end.turn.rounds[1]!.status).toBe('skipped');
    await waitIdle(body.conversation.id);

    await fastMembers({ Claude: 'instant+hang' });
    const direct = (await post('/api/turns', { message: '@claude only you' })).json() as SendTurnResponse;
    const res = await post(`/api/conversations/${direct.conversation.id}/turns/${direct.turn.id}/skip`);
    expect(res.status).toBe(409);
    expect(res.json().error).toBe('Skip to verdict is not available when a single member answers.');
  });

  it('continues a conversation, then regenerates its last turn', async () => {
    await fastMembers();
    const first = (await post('/api/turns', { message: 'Question one' })).json() as SendTurnResponse;
    const cid = first.conversation.id;
    await waitIdle(cid);
    const second = (await post('/api/turns', { conversationId: cid, message: 'Question two' })).json() as SendTurnResponse;
    expect(second.conversation.turnCount).toBe(2);
    await waitIdle(cid);

    expect((await post(`/api/conversations/${cid}/turns/${first.turn.id}/regenerate`)).status).toBe(409);
    const regen = await post(`/api/conversations/${cid}/turns/${second.turn.id}/regenerate`);
    expect(regen.status).toBe(200);
    const r = regen.json() as SendTurnResponse;
    expect(r.turn.id).not.toBe(second.turn.id);
    expect(r.turn.userMessage).toBe('Question two');
    await waitIdle(cid);
    const conv = (await get(`/api/conversations/${cid}`)).json() as Conversation;
    expect(conv.turns.map((t) => t.id)).toEqual([first.turn.id, r.turn.id]);
    expect(conv.turns[1]!.status).toBe('complete');
  });

  it('validates turn requests', async () => {
    await fastMembers();
    expect((await post('/api/turns', { message: '   ' })).json().error).toBe('Type a message to send to the council.');
    expect((await post('/api/turns', { message: '@claude' })).json().error).toBe('Add a question after the @mention.');
    expect((await post('/api/turns', { message: 'x'.repeat(200_001) })).status).toBe(400);
    expect((await post('/api/turns', { message: 'hi', conversationId: '../etc' })).status).toBe(400);
    expect((await post('/api/turns', { message: 'hi', conversationId: randomUUID() })).status).toBe(404);
    await setSettings((s) => {
      for (const m of s.members) m.enabled = false;
    });
    const none = await post('/api/turns', { message: 'Anyone?' });
    expect(none.status).toBe(400);
    expect(none.json().error).toBe('Enable at least one council member.');
  });

  it('renames and deletes conversations', async () => {
    await fastMembers();
    const body = (await post('/api/turns', { message: 'Name me' })).json() as SendTurnResponse;
    const cid = body.conversation.id;
    await waitIdle(cid);
    const renamed = await request('PATCH', `/api/conversations/${cid}`, { body: { title: '  New   title ' } });
    expect(renamed.status).toBe(200);
    expect(renamed.json()).toMatchObject({ id: cid, title: 'New title' });
    expect((await request('PATCH', `/api/conversations/${cid}`, { body: { title: ' ' } })).status).toBe(400);
    expect((await request('PATCH', `/api/conversations/${cid}`, { body: { title: 'x'.repeat(121) } })).status).toBe(400);
    expect((await request('PATCH', `/api/conversations/${randomUUID()}`, { body: { title: 'x' } })).status).toBe(404);
    expect((await request('PATCH', '/api/conversations/not-an-id', { body: { title: 'x' } })).status).toBe(400);

    expect((await request('DELETE', `/api/conversations/${cid}`)).status).toBe(204);
    expect((await get(`/api/conversations/${cid}`)).status).toBe(404);
    expect((await request('DELETE', `/api/conversations/${cid}`)).status).toBe(404);
  });

  it('deleting a conversation stops its run', async () => {
    await fastMembers({ Claude: 'hang', ChatGPT: 'hang', Gemini: 'hang' });
    const body = (await post('/api/turns', { message: 'Delete while running' })).json() as SendTurnResponse;
    const cid = body.conversation.id;
    expect(council.runs.has(cid)).toBe(true);
    expect((await request('DELETE', `/api/conversations/${cid}`)).status).toBe(204);
    expect(council.runs.has(cid)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect((await get(`/api/conversations/${cid}`)).status).toBe(404);
  });

  it('repairs a turn left running by a previous server', async () => {
    await fastMembers();
    const done = (await post('/api/turns', { message: 'Will be broken' })).json() as SendTurnResponse;
    await waitIdle(done.conversation.id);
    const file = path.join(dir, 'conversations', `${done.conversation.id}.json`);
    const conv = JSON.parse(await readFile(file, 'utf8')) as Conversation;
    const turn = conv.turns[0] as Turn;
    turn.status = 'running';
    turn.finishedAt = null;
    turn.rounds[1]!.status = 'running';
    turn.rounds[1]!.responses[0]!.status = 'running';
    await writeFile(file, JSON.stringify(conv));

    const stream = await readEvents(`/api/conversations/${conv.id}/turns/${turn.id}/events`);
    expect(stream.events).toHaveLength(1);
    const repaired = (stream.events[0] as Extract<RunEvent, { type: 'turn.end' }>).turn;
    expect(repaired.status).toBe('interrupted');
    expect(repaired.error).toBe('The server stopped while this turn was running.');
    expect(repaired.rounds[1]!.responses[0]!.status).toBe('skipped');

    await writeFile(file, JSON.stringify(conv));
    const viaGet = (await get(`/api/conversations/${conv.id}`)).json() as Conversation;
    expect(viaGet.turns[0]!.status).toBe('interrupted');
    const persisted = JSON.parse(await readFile(file, 'utf8')) as Conversation;
    expect(persisted.turns[0]!.status).toBe('interrupted');

    await writeFile(file, JSON.stringify(conv));
    await get('/api/conversations');
    expect((JSON.parse(await readFile(file, 'utf8')) as Conversation).turns[0]!.status).toBe('interrupted');
  });

  it('returns 404 for unknown turns and 400 for malformed ids on the event stream', async () => {
    expect((await get(`/api/conversations/${randomUUID()}/turns/${randomUUID()}/events`)).status).toBe(404);
    expect((await get(`/api/conversations/abc/turns/${randomUUID()}/events`)).status).toBe(400);
  });
});

describe('static files', () => {
  it('serves the built app with an SPA fallback, or a hint when it is not built', async () => {
    const webDir = await mkdtemp(path.join(os.tmpdir(), 'council-web-'));
    const dataDir = path.join(webDir, 'data');
    await mkdir(path.join(webDir, 'dist'));
    const withDist = await createApp({ dataDir, mock: true, staticDir: path.join(webDir, 'dist') });
    const srv = withDist.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const p = (srv.address() as AddressInfo).port;
    const fetchText = async (u: string) => {
      const r = await fetch(`http://127.0.0.1:${p}${u}`);
      return { status: r.status, text: await r.text() };
    };
    expect((await fetchText('/')).text).toMatch(/Run `npm run build`/);
    await writeFile(path.join(webDir, 'dist', 'index.html'), '<!doctype html><title>LLM Council</title>');
    await writeFile(path.join(webDir, 'dist', 'app.js'), 'console.log(1)');
    expect((await fetchText('/c/1234')).text).toContain('<title>LLM Council</title>');
    expect((await fetchText('/app.js')).text).toBe('console.log(1)');
    expect((await fetchText('/assets/missing.js')).status).toBe(404);
    const api = await fetchText('/api/unknown');
    expect(api.status).toBe(404);
    expect(JSON.parse(api.text).error).toMatch(/no API endpoint/);
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
    await rm(webDir, { recursive: true, force: true });
  });
});
