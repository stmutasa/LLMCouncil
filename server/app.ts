import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, ROLES } from '../shared/defaults';
import type {
  Conversation,
  MetaResponse,
  ProviderTestResult,
  RunEvent,
  SaveToNotionResponse,
  SendTurnResponse,
  SourceExcerpt,
  Turn,
} from '../shared/types';
import type { StoredTurnLibrary } from './engine/libraryPhase';
import { checkAttachments, checkMessage, planTurn, TurnPlanError, type TurnPlan } from './engine/plan';
import type { Extractor } from './library/extract/extractor';
import { listDirectories, revealFile, type DirOptions, type Spawner } from './library/fsDirs';
import { Library, LibraryError } from './library/library';
import type { FetchFn } from './library/notionClient';
import { DOC_ID_RE } from './library/store';
import { markInterrupted } from './engine/turnState';
import { ProviderRegistry } from './providers/registry';
import { ProviderError } from './providers/types';
import { RunManager, type Run } from './runs';
import { apiGuard } from './security';
import { checkEffort, checkModel, SettingsError, SettingsStore } from './settings';
import { deriveTitle, InvalidIdError, isValidConversationId, Storage, summarize } from './storage';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SERVER_DIR, '..');

const TEST_PROMPT = 'Reply with exactly: OK';
const TEST_TIMEOUT_MS = 60_000;
const TURN_ID_RE = /^[0-9a-f-]{36}$/;

export interface AppOptions {
  dataDir: string;
  mock?: boolean;
  /** The --host the server binds to; it is accepted in Host/Origin headers too. */
  host?: string;
  /** Directory of the built web app; defaults to web/dist. null disables static serving. */
  staticDir?: string | null;
  rng?: () => number;
  registry?: ProviderRegistry;
  coalesceMs?: number;
  /** Library dependencies tests replace (extraction worker, Notion's fetch, file manager…). */
  library?: {
    extractor?: Extractor;
    notionFetch?: FetchFn;
    notionSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    autoSync?: boolean;
    spawner?: Spawner;
    dirs?: DirOptions;
  };
}

export interface CouncilApp {
  app: express.Express;
  runs: RunManager;
  storage: Storage;
  settings: SettingsStore;
  registry: ProviderRegistry;
  library: Library;
  /** Stops every run (turns end as interrupted) and every sync, and waits briefly for them to be saved. */
  shutdown(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function conversationIdParam(req: Request, name = 'id'): string {
  const id = req.params[name];
  if (!isValidConversationId(id)) throw new HttpError(400, 'Invalid conversation id.');
  return id;
}

function turnIdParam(req: Request): string {
  const id = req.params.tid;
  if (typeof id !== 'string' || !TURN_ID_RE.test(id)) throw new HttpError(404, 'Turn not found.');
  return id;
}

function repairRunning(conversation: Conversation): boolean {
  let changed = false;
  for (const t of conversation.turns) {
    if (t.status === 'running') {
      markInterrupted(t);
      changed = true;
    }
  }
  return changed;
}

export async function createApp(options: AppOptions): Promise<CouncilApp> {
  const mock = options.mock ?? false;
  const dataDir = path.resolve(options.dataDir);
  const storage = new Storage(dataDir);
  await storage.init();
  const settingsStore = new SettingsStore(dataDir, mock);
  await settingsStore.load();
  const registry = options.registry ?? new ProviderRegistry({ mock });
  const library = new Library({
    dataDir,
    settings: () => settingsStore.get(),
    saveSettings: (next) => settingsStore.save(next),
    extractor: options.library?.extractor,
    notionFetch: options.library?.notionFetch,
    notionSleep: options.library?.notionSleep,
    autoSync: options.library?.autoSync,
  });
  await library.init();
  const runs = new RunManager({
    storage,
    providers: registry,
    rng: options.rng,
    coalesceMs: options.coalesceMs,
    library,
  });
  const version = appVersion();

  /** A conversation as clients should see it: live turn overlaid, stale 'running' turns repaired. */
  async function view(id: string): Promise<Conversation | null> {
    let conversation = await storage.load(id);
    if (!conversation) return null;
    const run = runs.get(id);
    if (run) {
      const live = structuredClone(run.turn);
      const i = conversation.turns.findIndex((t) => t.id === live.id);
      if (i >= 0) conversation.turns[i] = live;
      else conversation.turns.push(live);
      return conversation;
    }
    if (conversation.turns.some((t) => t.status === 'running')) {
      conversation =
        (await storage.update(id, (c) => {
          if (!runs.has(id)) repairRunning(c);
        })) ?? conversation;
      // A run may have started while the repair was queued; show its live state.
      const started = runs.get(id);
      if (started) return view(id);
    }
    return conversation;
  }

  function startRun(run: Run, conversation: Conversation): SendTurnResponse {
    run.start(conversation);
    return { conversation: summarize(conversation, true), turn: structuredClone(run.turn) };
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const api = express.Router();
  api.use(apiGuard(options.host));
  api.use(express.json({ limit: '2mb' }));

  api.get('/meta', (_req, res) => {
    const meta: MetaResponse = {
      appVersion: version,
      dataDir,
      mock,
      roles: ROLES,
      limits: { maxMembers: LIMITS.maxMembers, maxRounds: LIMITS.maxRounds, maxMessageChars: LIMITS.maxMessageChars },
    };
    res.json(meta);
  });

  api.get('/settings', (_req, res) => {
    res.json(settingsStore.get());
  });

  api.put('/settings', async (req, res) => {
    if (!isPlainObject(req.body)) throw new HttpError(400, 'Send the complete settings object as JSON.');
    const previous = settingsStore.get();
    const saved = await settingsStore.save(req.body);
    // Removing documents and starting syncs happens in the background; a save never waits on a sync.
    void library.reconcile(saved, previous);
    res.json(saved);
  });

  api.get('/providers', async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await registry.listInfo(settingsStore.get(), { refresh }));
  });

  api.post('/providers/:id/test', async (req, res) => {
    const settings = settingsStore.get();
    const id = String(req.params.id);
    const provider = registry.get(id, settings);
    if (!provider) throw new HttpError(404, `Provider '${id}' is not available.`);
    const body: Record<string, unknown> = isPlainObject(req.body) ? req.body : {};
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const effort = typeof body.effort === 'string' ? body.effort.trim() : '';
    checkModel(model, 'Test');
    checkEffort(effort, 'Test');

    const ctl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ctl.abort();
    });
    const started = Date.now();
    let text = '';
    let result: ProviderTestResult;
    try {
      const out = await provider.run({
        prompt: TEST_PROMPT,
        model,
        effort,
        webSearch: false,
        timeoutMs: TEST_TIMEOUT_MS,
        signal: ctl.signal,
        onText: (t, replace) => {
          text = replace ? t : text + t;
        },
        onActivity: () => undefined,
      });
      result = {
        ok: true,
        text: out.text,
        error: null,
        durationMs: Date.now() - started,
        model: out.model,
        billing: out.billing,
        diagnostics: out.diagnostics,
      };
    } catch (err) {
      result = {
        ok: false,
        text,
        error: (err as Error).message,
        durationMs: Date.now() - started,
        model: null,
        billing: 'unknown',
        diagnostics: err instanceof ProviderError ? err.diagnostics : '',
      };
    }
    if (!res.writableEnded && !ctl.signal.aborted) res.json(result);
  });

  api.get('/providers/:id/models', async (req, res) => {
    const id = String(req.params.id);
    const result = await registry.listModels(id, settingsStore.get());
    if (!result) throw new HttpError(404, `Provider '${id}' is not available.`);
    res.json(result);
  });

  api.get('/conversations', async (_req, res) => {
    const entries = await storage.listEntries();
    const out = await Promise.all(
      entries.map(async (entry) => {
        const id = entry.summary.id;
        if (entry.hasRunningTurn && !runs.has(id)) {
          const repaired = await storage.update(id, (x) => {
            if (!runs.has(id)) repairRunning(x);
          });
          if (repaired) return summarize(repaired, runs.has(id));
        }
        return { ...entry.summary, running: runs.has(id) };
      }),
    );
    res.json(out);
  });

  api.get('/conversations/:id', async (req, res) => {
    const conversation = await view(conversationIdParam(req));
    if (!conversation) throw new HttpError(404, 'Conversation not found.');
    res.json(conversation);
  });

  api.patch('/conversations/:id', async (req, res) => {
    const id = conversationIdParam(req);
    const raw = isPlainObject(req.body) ? req.body.title : undefined;
    if (typeof raw !== 'string') throw new HttpError(400, 'Send { "title": "…" }.');
    const title = raw.replace(/\s+/g, ' ').trim();
    if (title.length < 1 || title.length > 120) throw new HttpError(400, 'Titles must be 1 to 120 characters long.');
    const updated = await storage.update(id, (c) => {
      c.title = title;
    });
    if (!updated) throw new HttpError(404, 'Conversation not found.');
    res.json(summarize(updated, runs.has(id)));
  });

  api.delete('/conversations/:id', async (req, res) => {
    const id = conversationIdParam(req);
    await runs.stop(id);
    const deleted = await storage.delete(id);
    if (!deleted) throw new HttpError(404, 'Conversation not found.');
    res.status(204).end();
  });

  function plan(message: string, attachments: string[] = []): { plan: TurnPlan; settings: ReturnType<SettingsStore['get']> } {
    const settings = settingsStore.get();
    return {
      plan: planTurn(message, settings, (id) => registry.label(id, settings), new Date(), attachments),
      settings,
    };
  }

  const BUSY = 'This conversation already has a running turn. Stop it or wait for it to finish.';

  api.post('/turns', async (req, res) => {
    if (!isPlainObject(req.body)) throw new HttpError(400, 'Send { "message": "…" } as JSON.');
    const message = checkMessage(req.body.message);
    const attachments = checkAttachments(req.body.attachments);
    const requestedId = req.body.conversationId;

    if (requestedId === undefined || requestedId === null) {
      const { plan: p, settings } = plan(message, attachments);
      const now = p.turn.createdAt;
      const conversation: Conversation = {
        id: randomUUID(),
        title: deriveTitle(message, settings.members),
        createdAt: now,
        updatedAt: now,
        turns: [structuredClone(p.turn)],
      };
      const run = runs.create(conversation.id, p, settings)!;
      try {
        await storage.create(conversation);
      } catch (err) {
        runs.discard(run);
        throw err;
      }
      res.json(startRun(run, conversation));
      return;
    }

    if (!isValidConversationId(requestedId)) throw new HttpError(400, 'Invalid conversation id.');
    if (runs.has(requestedId)) throw new HttpError(409, BUSY);
    const existing = await storage.load(requestedId);
    if (!existing) throw new HttpError(404, 'Conversation not found.');
    const { plan: p, settings } = plan(message, attachments);
    const run = runs.create(requestedId, p, settings);
    if (!run) throw new HttpError(409, BUSY);
    let saved: Conversation | null;
    try {
      saved = await storage.update(requestedId, (c) => {
        repairRunning(c);
        c.turns.push(structuredClone(p.turn));
        c.updatedAt = p.turn.createdAt;
      });
    } catch (err) {
      runs.discard(run);
      throw err;
    }
    if (!saved) {
      runs.discard(run);
      throw new HttpError(404, 'Conversation not found.');
    }
    res.json(startRun(run, saved));
  });

  /** For stop/skip: 404 for unknown ids, 409 when the turn exists but is not running. */
  async function requireRunning(req: Request): Promise<Run> {
    const cid = conversationIdParam(req, 'cid');
    const tid = turnIdParam(req);
    const run = runs.get(cid);
    if (run && run.turn.id === tid) return run;
    const conversation = await storage.load(cid);
    if (!conversation) throw new HttpError(404, 'Conversation not found.');
    if (!conversation.turns.some((t) => t.id === tid)) throw new HttpError(404, 'Turn not found.');
    throw new HttpError(409, 'This turn is not running.');
  }

  api.post('/conversations/:cid/turns/:tid/stop', async (req, res) => {
    const run = await requireRunning(req);
    await runs.stop(run.conversationId, run.turn.id);
    res.status(204).end();
  });

  api.post('/conversations/:cid/turns/:tid/skip', async (req, res) => {
    const run = await requireRunning(req);
    if (!run.control.requestSkip()) {
      const why =
        run.turn.mode === 'direct'
          ? 'Skip to verdict is not available when a single member answers.'
          : run.control.phase === 'library'
            ? 'The library is still being searched; skip to verdict is available once the council starts.'
            : run.control.skipRequested
            ? 'Skip to verdict was already requested.'
            : 'The arbiter is already writing the verdict.';
      throw new HttpError(409, why);
    }
    res.status(204).end();
  });

  api.post('/conversations/:cid/turns/:tid/regenerate', async (req, res) => {
    const cid = conversationIdParam(req, 'cid');
    const tid = turnIdParam(req);
    if (runs.has(cid)) throw new HttpError(409, BUSY);
    const conversation = await storage.load(cid);
    if (!conversation) throw new HttpError(404, 'Conversation not found.');
    const index = conversation.turns.findIndex((t) => t.id === tid);
    if (index < 0) throw new HttpError(404, 'Turn not found.');
    if (index !== conversation.turns.length - 1) throw new HttpError(409, 'Only the last turn can be regenerated.');
    const old = conversation.turns[index]!;
    const oldLibrary = old.library as StoredTurnLibrary | null;
    // The regenerated turn reads the same attachments; ids it was given are not carried over.
    const reattach = oldLibrary?.attachmentIds ?? oldLibrary?.attachments.map((a) => a.documentId) ?? [];
    const { plan: p, settings } = plan(old.userMessage, reattach.slice(0, LIMITS.maxAttachments));
    const run = runs.create(cid, p, settings);
    if (!run) throw new HttpError(409, BUSY);
    let saved: Conversation | null;
    try {
      saved = await storage.update(cid, (c) => {
        const last = c.turns[c.turns.length - 1];
        if (!last || last.id !== tid) throw new HttpError(409, 'Only the last turn can be regenerated.');
        c.turns[c.turns.length - 1] = structuredClone(p.turn);
        c.updatedAt = p.turn.createdAt;
      });
    } catch (err) {
      runs.discard(run);
      throw err;
    }
    if (!saved) {
      runs.discard(run);
      throw new HttpError(404, 'Conversation not found.');
    }
    res.json(startRun(run, saved));
  });

  api.get('/conversations/:cid/turns/:tid/events', async (req, res) => {
    const cid = conversationIdParam(req, 'cid');
    const tid = turnIdParam(req);

    const open = () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
    };
    const send = (event: RunEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const serveLive = (run: Run) => {
      open();
      let unsubscribe: (() => void) | null = null;
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      const cleanup = () => {
        clearInterval(ping);
        unsubscribe?.();
        unsubscribe = null;
      };
      res.on('close', cleanup);
      // Snapshot and subscription happen in one synchronous step inside subscribe().
      unsubscribe = run.subscribe((event) => {
        send(event);
        if (event.type === 'turn.end') {
          cleanup();
          res.end();
        }
      });
    };

    const run = runs.get(cid);
    if (run && run.turn.id === tid) {
      serveLive(run);
      return;
    }

    const conversation = await storage.load(cid);
    if (!conversation) throw new HttpError(404, 'Conversation not found.');
    let turn: Turn | undefined = conversation.turns.find((t) => t.id === tid);
    if (!turn) throw new HttpError(404, 'Turn not found.');
    const live = runs.get(cid);
    if (live && live.turn.id === tid) {
      // The run was registered while the file was being read.
      serveLive(live);
      return;
    }
    if (turn.status === 'running') {
      const updated = await storage.update(cid, (c) => {
        if (!runs.has(cid)) repairRunning(c);
      });
      turn = updated?.turns.find((t) => t.id === tid) ?? turn;
    }
    open();
    send({ type: 'turn.end', turn });
    res.end();
  });

  // -------------------------------------------------------------------------------------------
  // Document library

  api.get('/library', async (_req, res) => {
    res.json(await library.status());
  });

  api.post('/library/sources/:id/sync', async (req, res) => {
    await library.requestSync(String(req.params.id));
    res.status(204).end();
  });

  api.post('/library/sources/:id/cancel', async (req, res) => {
    await library.cancelSync(String(req.params.id));
    res.status(204).end();
  });

  const queryString = (value: unknown, name: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new HttpError(400, `"${name}" must be given once, as text.`);
    return value;
  };
  const queryInt = (value: unknown, name: string, min: number, max: number, fallback: number): number => {
    const raw = queryString(value, name);
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw)) throw new HttpError(400, `"${name}" must be a whole number.`);
    const n = Number(raw);
    if (n < min) throw new HttpError(400, `"${name}" must be at least ${min}.`);
    return Math.min(n, max);
  };

  api.get('/library/documents', (req, res) => {
    res.json(
      library.documents({
        sourceId: queryString(req.query.sourceId, 'sourceId') || undefined,
        status: queryString(req.query.status, 'status') || undefined,
        q: queryString(req.query.q, 'q'),
        offset: queryInt(req.query.offset, 'offset', 0, Number.MAX_SAFE_INTEGER, 0),
        limit: queryInt(req.query.limit, 'limit', 1, 200, 50),
      }),
    );
  });

  api.get('/library/documents/:id/text', async (req, res) => {
    res.json(await library.documentText(String(req.params.id)));
  });

  api.post('/library/documents/:id/reveal', async (req, res) => {
    const id = String(req.params.id);
    if (!DOC_ID_RE.test(id)) throw new HttpError(404, 'There is no document with this id.');
    // The path comes from the manifest only, never from the request.
    const file = library.filePath(id);
    try {
      await fsp.stat(file);
    } catch {
      throw new HttpError(404, 'The file is no longer in its folder. Check the source for changes.');
    }
    revealFile(file, options.library?.spawner);
    res.status(204).end();
  });

  api.post('/library/search', async (req, res) => {
    const query = isPlainObject(req.body) ? req.body.query : undefined;
    if (typeof query !== 'string' || query.trim() === '') throw new HttpError(400, 'Send { "query": "…" } with the words to search for.');
    if (query.length > 1000) throw new HttpError(400, 'The search is too long; use at most 1,000 characters.');
    const settings = settingsStore.get();
    const sourceIds = settings.library.sources.filter((s) => s.enabled).map((s) => s.id);
    const names = new Map(settings.library.sources.map((s) => [s.id, s.name]));
    const found = await library.search([query.trim()], { budgetChars: settings.library.excerptChars, sourceIds });
    const excerpts: SourceExcerpt[] = [];
    for (const p of found) {
      const doc = library.document(p.documentId);
      if (!doc) continue;
      excerpts.push({
        id: `S${excerpts.length + 1}`,
        documentId: doc.id,
        title: doc.title,
        sourceName: names.get(doc.sourceId) ?? '',
        location: doc.location,
        part: p.part,
        url: doc.url,
        text: p.text,
      });
    }
    res.json({ excerpts });
  });

  api.get('/fs/dirs', async (req, res) => {
    res.json(await listDirectories(queryString(req.query.path, 'path'), options.library?.dirs));
  });

  api.get('/library/notion', async (req, res) => {
    res.json(await library.notionStatus(req.query.refresh === '1' || req.query.refresh === 'true'));
  });

  api.put('/library/notion/token', async (req, res) => {
    const token = isPlainObject(req.body) ? req.body.token : undefined;
    if (typeof token !== 'string' || token.trim() === '') throw new HttpError(400, 'Paste the Notion token.');
    if (token.length > 4096) throw new HttpError(400, 'That does not look like a Notion token: it is too long.');
    res.json(await library.connectNotion(token.trim()));
  });

  api.delete('/library/notion/token', async (_req, res) => {
    await library.disconnectNotion();
    res.status(204).end();
  });

  api.get('/library/notion/pages', async (req, res) => {
    const q = (queryString(req.query.q, 'q') ?? '').slice(0, 200);
    res.json({ pages: await library.notionPages(q) });
  });

  api.post('/conversations/:cid/turns/:tid/notion', async (req, res) => {
    const cid = conversationIdParam(req, 'cid');
    const tid = turnIdParam(req);
    const include = isPlainObject(req.body) ? req.body.includeDeliberation : undefined;
    if (include !== undefined && typeof include !== 'boolean') {
      throw new HttpError(400, '"includeDeliberation" must be true or false.');
    }
    const live = runs.get(cid);
    if (live && live.turn.id === tid) throw new HttpError(409, 'This turn is still running. Save it once it has finished.');
    const conversation = await storage.load(cid);
    if (!conversation) throw new HttpError(404, 'Conversation not found.');
    const turn = conversation.turns.find((t) => t.id === tid);
    if (!turn) throw new HttpError(404, 'Turn not found.');
    if (turn.status === 'running') throw new HttpError(409, 'This turn is still running. Save it once it has finished.');
    if (!turn.finalText.trim()) throw new HttpError(400, 'This turn has no final answer to save.');
    const saved: SaveToNotionResponse = await library.saveToNotion(conversation, turn, include ?? false);
    res.json(saved);
  });

  api.use((req, _res, next) => {
    next(new HttpError(404, `There is no API endpoint ${req.method} ${req.baseUrl}${req.path}.`));
  });

  app.use('/api', api);

  const staticDir = options.staticDir === undefined ? path.join(REPO_ROOT, 'web', 'dist') : options.staticDir;
  if (staticDir) {
    app.use(express.static(staticDir, { index: false }));
    app.get('/{*path}', (req, res, next) => {
      // Missing files (anything with an extension) are real 404s, not app routes.
      if (path.posix.extname(req.path) !== '') {
        next();
        return;
      }
      const index = path.join(staticDir, 'index.html');
      if (existsSync(index)) {
        res.sendFile(index);
        return;
      }
      if (req.path === '/') {
        res
          .type('text/plain')
          .send('LLM Council server is running, but the web app has not been built. Run `npm run build`, then reload.');
        return;
      }
      next();
    });
  }

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
    let status = 500;
    let message = 'Something went wrong on the server.';
    if (err instanceof HttpError || err instanceof LibraryError) {
      status = err.status;
      message = err.message;
    } else if (err instanceof SettingsError || err instanceof TurnPlanError || err instanceof InvalidIdError) {
      status = 400;
      message = err.message;
    } else if (e.type === 'entity.too.large') {
      status = 413;
      message = 'The request body is larger than 2 MB.';
    } else if (e.type === 'entity.parse.failed') {
      status = 400;
      message = 'The request body is not valid JSON.';
    } else if (typeof (e.status ?? e.statusCode) === 'number' && (e.status ?? e.statusCode)! < 500) {
      status = (e.status ?? e.statusCode)!;
      message = e.message || message;
    } else {
      console.error('[http] Unhandled error:', err);
      if (e.message) message = `Something went wrong on the server: ${e.message}`;
    }
    res.status(status).json({ error: message });
  });

  return {
    app,
    runs,
    storage,
    settings: settingsStore,
    registry,
    library,
    shutdown: async () => {
      await runs.shutdown();
      await library.shutdown();
    },
  };
}
