import type {
  Conversation,
  ConversationSummary,
  DirectoryListing,
  DocumentStatus,
  LibraryDocumentText,
  LibraryDocumentsResponse,
  LibraryStatus,
  MetaResponse,
  NotionPageRef,
  NotionStatus,
  ProviderInfo,
  ProviderModelsResult,
  ProviderTestResult,
  SaveToNotionRequest,
  SaveToNotionResponse,
  SendTurnRequest,
  SendTurnResponse,
  Settings,
  SourceExcerpt,
} from '../../shared/types';

/** An HTTP or network failure with a message fit to show the user. `status` is 0 for network errors. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const UNREACHABLE_MESSAGE = 'Could not reach the LLM Council server. Check that it is running, then try again.';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(UNREACHABLE_MESSAGE, 0);
  }

  if (response.status === 204) return undefined as T;

  const raw = await response.text().catch(() => '');
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    const serverMessage =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : '';
    // The server always answers errors with JSON; a 5xx without it comes from the dev proxy
    // when nothing is listening behind it.
    if (!serverMessage && response.status >= 500) throw new ApiError(UNREACHABLE_MESSAGE, 0);
    const fallback = `The server returned an unexpected response (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}).`;
    throw new ApiError(serverMessage || fallback, response.status);
  }
  if (parsed === undefined) {
    throw new ApiError(`The server returned an unreadable response for ${method} /api${path}.`, response.status);
  }
  return parsed as T;
}

const enc = encodeURIComponent;

export const api = {
  meta: () => request<MetaResponse>('GET', '/meta'),
  settings: () => request<Settings>('GET', '/settings'),
  saveSettings: (settings: Settings) => request<Settings>('PUT', '/settings', settings),
  providers: (refresh = false) => request<ProviderInfo[]>('GET', refresh ? '/providers?refresh=1' : '/providers'),
  testProvider: (id: string, body: { model?: string; effort?: string }) =>
    request<ProviderTestResult>('POST', `/providers/${enc(id)}/test`, body),
  providerModels: (id: string) => request<ProviderModelsResult>('GET', `/providers/${enc(id)}/models`),
  conversations: () => request<ConversationSummary[]>('GET', '/conversations'),
  conversation: (id: string) => request<Conversation>('GET', `/conversations/${enc(id)}`),
  renameConversation: (id: string, title: string) =>
    request<ConversationSummary>('PATCH', `/conversations/${enc(id)}`, { title }),
  deleteConversation: (id: string) => request<void>('DELETE', `/conversations/${enc(id)}`),
  sendTurn: (body: SendTurnRequest) => request<SendTurnResponse>('POST', '/turns', body),
  stopTurn: (cid: string, tid: string) => request<void>('POST', `/conversations/${enc(cid)}/turns/${enc(tid)}/stop`),
  skipTurn: (cid: string, tid: string) => request<void>('POST', `/conversations/${enc(cid)}/turns/${enc(tid)}/skip`),
  regenerateTurn: (cid: string, tid: string) =>
    request<SendTurnResponse>('POST', `/conversations/${enc(cid)}/turns/${enc(tid)}/regenerate`),

  library: () => request<LibraryStatus>('GET', '/library'),
  syncSource: (id: string) => request<void>('POST', `/library/sources/${enc(id)}/sync`),
  cancelSync: (id: string) => request<void>('POST', `/library/sources/${enc(id)}/cancel`),
  documents: (query: DocumentQuery) => request<LibraryDocumentsResponse>('GET', `/library/documents${queryString(query)}`),
  documentText: (id: string) => request<LibraryDocumentText>('GET', `/library/documents/${enc(id)}/text`),
  revealDocument: (id: string) => request<void>('POST', `/library/documents/${enc(id)}/reveal`),
  searchLibrary: (query: string) => request<{ excerpts: SourceExcerpt[] }>('POST', '/library/search', { query }),
  directories: (path?: string) => request<DirectoryListing>('GET', `/fs/dirs${path ? `?path=${enc(path)}` : ''}`),
  notionStatus: () => request<NotionStatus>('GET', '/library/notion'),
  connectNotion: (token: string) => request<NotionStatus>('PUT', '/library/notion/token', { token }),
  disconnectNotion: () => request<void>('DELETE', '/library/notion/token'),
  notionPages: (q: string) => request<{ pages: NotionPageRef[] }>('GET', `/library/notion/pages?q=${enc(q)}`),
  saveToNotion: (cid: string, tid: string, body: SaveToNotionRequest) =>
    request<SaveToNotionResponse>('POST', `/conversations/${enc(cid)}/turns/${enc(tid)}/notion`, body),
};

export interface DocumentQuery {
  sourceId?: string;
  status?: DocumentStatus[];
  q?: string;
  offset?: number;
  limit?: number;
}

function queryString(query: DocumentQuery): string {
  const params = new URLSearchParams();
  if (query.sourceId) params.set('sourceId', query.sourceId);
  if (query.status && query.status.length > 0) params.set('status', query.status.join(','));
  if (query.q && query.q.trim()) params.set('q', query.q.trim());
  if (query.offset) params.set('offset', String(query.offset));
  if (query.limit) params.set('limit', String(query.limit));
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function eventsUrl(cid: string, tid: string): string {
  return `/api/conversations/${enc(cid)}/turns/${enc(tid)}/events`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Please try again.';
}
