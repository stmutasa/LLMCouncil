export const NOTION_BASE = 'https://api.notion.com';
export const NOTION_VERSION = '2026-03-11';
export const TOKEN_REJECTED = 'Notion rejected the token. It may have expired or been revoked.';

const REQUEST_TIMEOUT_MS = 60_000;
const MIN_SPACING_MS = 334;
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_DEFAULT_S = 2;
const RETRY_AFTER_CAP_S = 60;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** A failed Notion call. `message` is Notion's own message when it sent one. */
export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'NotionError';
  }
}

export interface NotionClientOptions {
  token: string;
  fetch?: FetchFn;
  /** Replaced in tests so retries and spacing take no real time. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  timeoutMs?: number;
}

/** read: safe to repeat (GETs, search and query POSTs). write: creates something; never repeated. */
type Kind = 'read' | 'write';

function abortError(): Error {
  const err = new Error('The request was cancelled.');
  err.name = 'AbortError';
  return err;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A small Notion API client on plain fetch: at most three requests a second, retries for rate
 * limits and transient server errors on reads, a timeout per request. The token is sent only in
 * the Authorization header and never appears in errors.
 */
export class NotionClient {
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private nextSlot = 0;

  constructor(private readonly options: NotionClientOptions) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  private async spacing(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + MIN_SPACING_MS;
    if (wait > 0) await this.sleep(wait, signal);
  }

  private async once(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    await this.spacing(signal);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      'Notion-Version': NOTION_VERSION,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetchFn(`${this.options.baseUrl ?? NOTION_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw abortError();
      if (timeout.aborted) throw new NotionError('Notion did not answer within 60 seconds.', 0, 'timeout');
      throw new NotionError(`Notion could not be reached: ${(err as Error).message || 'network error'}.`, 0, 'network');
    }
  }

  private async errorFrom(res: Response): Promise<NotionError> {
    let message = '';
    let code = '';
    try {
      const value: unknown = await res.json();
      if (isObject(value)) {
        if (typeof value.message === 'string') message = value.message;
        if (typeof value.code === 'string') code = value.code;
      }
    } catch {
      // Not JSON; described by status below.
    }
    if (res.status === 401) return new NotionError(TOKEN_REJECTED, 401, code || 'unauthorized');
    return new NotionError(message || `Notion answered with HTTP ${res.status}.`, res.status, code);
  }

  /** One API call; resolves with the parsed JSON body. */
  async request(method: 'GET' | 'POST' | 'PATCH', path: string, opts: { body?: unknown; signal?: AbortSignal; kind?: Kind } = {}): Promise<Record<string, unknown>> {
    const kind = opts.kind ?? (method === 'GET' ? 'read' : 'write');
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.once(method, path, opts.body, opts.signal);
      } catch (err) {
        // A network failure on a read is safe to repeat.
        const retryable = err instanceof NotionError && err.code === 'network' && kind === 'read';
        if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
        await this.sleep(1000 * 2 ** (attempt - 1), opts.signal);
        continue;
      }
      if (res.ok) {
        try {
          const value: unknown = await res.json();
          return isObject(value) ? value : {};
        } catch {
          throw new NotionError('Notion sent a response that is not valid JSON.', res.status, 'invalid_json');
        }
      }
      const canRetry = kind === 'read' && attempt < MAX_ATTEMPTS;
      if (canRetry && (res.status === 429 || res.status === 529)) {
        const header = Number(res.headers.get('retry-after'));
        const seconds = Number.isFinite(header) && header > 0 ? Math.min(header, RETRY_AFTER_CAP_S) : RETRY_AFTER_DEFAULT_S;
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(seconds * 1000, opts.signal);
        continue;
      }
      if (canRetry && [500, 502, 503, 504].includes(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(1000 * 2 ** (attempt - 1), opts.signal);
        continue;
      }
      throw await this.errorFrom(res);
    }
  }

  me(signal?: AbortSignal) {
    return this.request('GET', '/v1/users/me', { signal });
  }

  search(body: Record<string, unknown>, signal?: AbortSignal) {
    return this.request('POST', '/v1/search', { body, signal, kind: 'read' });
  }

  queryDataSource(id: string, body: Record<string, unknown>, signal?: AbortSignal) {
    return this.request('POST', `/v1/data_sources/${encodeURIComponent(id)}/query`, { body, signal, kind: 'read' });
  }

  pageMarkdown(id: string, signal?: AbortSignal) {
    return this.request('GET', `/v1/pages/${encodeURIComponent(id)}/markdown?markdown_version=v2`, { signal });
  }

  createPage(body: Record<string, unknown>, signal?: AbortSignal) {
    return this.request('POST', '/v1/pages', { body, signal, kind: 'write' });
  }
}
