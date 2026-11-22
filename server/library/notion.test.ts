import { describe, expect, it } from 'vitest';
import type { Conversation, Turn } from '../../shared/types';
import { NotionClient, NotionError, NOTION_VERSION, TOKEN_REJECTED, type FetchFn } from './notionClient';
import { createPageBody, DELIBERATION_DROPPED, escapeNotionText, MAX_NOTION_MARKDOWN, notionMarkdown, notionPageTitle, saveTurnToNotion } from './notionSave';
import { enumerateNotion, fetchPageText, locationOf, pageTitle, propertyValue, renderProperties, readPage } from './sources/notion';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fake fetch: `route` decides each reply; every request is recorded. */
function fakeFetch(route: (req: Seen, n: number) => Reply) {
  const seen: Seen[] = [];
  const fetch: FetchFn = async (url, init) => {
    const req: Seen = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(req);
    const r = route(req, seen.length);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  return { fetch, seen };
}

function client(route: (req: Seen, n: number) => Reply, token = 'secret-token-123') {
  const { fetch, seen } = fakeFetch(route);
  const sleeps: number[] = [];
  let now = 0;
  const c = new NotionClient({
    token,
    fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { c, seen, sleeps };
}

describe('Notion client', () => {
  it('sends the token, version and JSON content type', async () => {
    const { c, seen } = client(() => ({ body: { object: 'user', name: 'Bot' } }));
    await c.me();
    await c.search({ query: 'x' });
    expect(seen[0]).toMatchObject({ method: 'GET', url: 'https://api.notion.com/v1/users/me' });
    expect(seen[0]!.headers).toEqual({ Authorization: 'Bearer secret-token-123', 'Notion-Version': NOTION_VERSION });
    expect(NOTION_VERSION).toBe('2026-03-11');
    expect(seen[1]!.headers['Content-Type']).toBe('application/json');
    expect(seen[1]!.body).toEqual({ query: 'x' });
  });

  it('spaces requests to at most three a second', async () => {
    const { c, sleeps } = client(() => ({ body: {} }));
    await c.me();
    await c.me();
    await c.me();
    expect(sleeps).toEqual([334, 334]);
  });

  it('retries 429 and 529 after Retry-After (default 2 s, at most 60 s)', async () => {
    const replies: Reply[] = [
      { status: 429, headers: { 'retry-after': '7' }, body: { message: 'slow down' } },
      { status: 529, body: {} },
      { status: 429, headers: { 'retry-after': '600' }, body: {} },
      { body: { ok: true } },
    ];
    const { c, seen, sleeps } = client((_r, n) => replies[n - 1]!);
    expect(await c.search({})).toEqual({ ok: true });
    expect(seen).toHaveLength(4);
    expect(sleeps.filter((s) => s !== 334 && s > 334)).toEqual([7000, 2000, 60000]);
  });

  it('retries server errors on reads with exponential backoff, at most five attempts', async () => {
    const { c, seen, sleeps } = client(() => ({ status: 503, body: { message: 'Service unavailable' } }));
    await expect(c.pageMarkdown('p1')).rejects.toThrow('Service unavailable');
    expect(seen).toHaveLength(5);
    expect(sleeps.filter((s) => s >= 1000)).toEqual([1000, 2000, 4000, 8000]);
  });

  it('never retries creating a page', async () => {
    for (const status of [429, 500, 503]) {
      const { c, seen } = client(() => ({ status, body: { message: `failed ${status}` } }));
      await expect(c.createPage({})).rejects.toThrow(`failed ${status}`);
      expect(seen).toHaveLength(1);
    }
    const net = client(() => new TypeError('fetch failed'));
    await expect(net.c.createPage({})).rejects.toThrow('Notion could not be reached');
    expect(net.seen).toHaveLength(1);
  });

  it('maps 401 to a fixed message and shows Notion’s own message otherwise', async () => {
    const bad = client(() => ({ status: 401, body: { message: 'API token is invalid.', code: 'unauthorized' } }));
    await expect(bad.c.me()).rejects.toThrow(TOKEN_REJECTED);
    const nf = client(() => ({ status: 404, body: { object: 'error', code: 'object_not_found', message: 'Could not find page with ID: x.' } }));
    const err = await nf.c.pageMarkdown('x').catch((e: unknown) => e as NotionError);
    expect(err).toBeInstanceOf(NotionError);
    expect(err.message).toBe('Could not find page with ID: x.');
    expect(err.status).toBe(404);
    expect(nf.seen).toHaveLength(1);
    const plain = client(() => ({ status: 400, body: undefined }));
    await expect(plain.c.me()).rejects.toThrow('Notion answered with HTTP 400.');
  });

  it('never puts the token in an error message', async () => {
    const token = 'ntn_SUPERSECRET';
    for (const reply of [{ status: 401, body: {} }, { status: 500, body: {} }, new TypeError(`boom`)] as Reply[]) {
      const { c } = client(() => reply, token);
      const err = await c.me().catch((e: unknown) => e as Error);
      expect(String(err.message)).not.toContain(token);
    }
  });

  it('stops promptly when aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { c } = client(() => new DOMException('aborted', 'AbortError'));
    await expect(c.request('GET', '/v1/users/me', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function page(id: string, title: string, parent: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    object: 'page',
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: '2026-01-01T00:00:00.000Z',
    in_trash: false,
    parent,
    properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: title }] } },
    ...extra,
  };
}

describe('Notion enumeration', () => {
  it('lists pages and data source rows across pages of results, skipping partial and trashed ones', async () => {
    const { c, seen } = client((req) => {
      const body = req.body as Record<string, any> | undefined;
      if (req.url.endsWith('/v1/search') && body?.filter?.value === 'page') {
        if (!body.start_cursor) {
          return {
            body: {
              results: [page('p1', 'Projects', { type: 'workspace', workspace: true }), { object: 'page', id: 'partial' }],
              has_more: true,
              next_cursor: 'c2',
            },
          };
        }
        return {
          body: {
            results: [
              page('p2', 'Q3 plan', { type: 'page_id', page_id: 'p1' }),
              page('p3', 'Old', { type: 'workspace', workspace: true }, { in_trash: true }),
            ],
            has_more: false,
          },
        };
      }
      if (req.url.endsWith('/v1/search')) {
        return {
          body: {
            results: [{ object: 'data_source', id: 'ds1', title: [{ plain_text: 'Tasks' }], parent: { type: 'page_id', page_id: 'p1' } }],
            has_more: false,
          },
        };
      }
      if (req.url.endsWith('/v1/data_sources/ds1/query')) {
        return { body: { results: [page('r1', 'Write report', { type: 'data_source_id', data_source_id: 'ds1' })], has_more: false } };
      }
      return { status: 404, body: { message: 'no' } };
    });
    const en = await enumerateNotion(c);
    expect(en.complete).toBe(true);
    expect([...en.pages.keys()].sort()).toEqual(['p1', 'p2', 'r1']);
    expect(locationOf(en.pages.get('p2')!, en)).toBe('Projects');
    expect(locationOf(en.pages.get('r1')!, en)).toBe('Projects / Tasks');
    expect(locationOf(en.pages.get('p1')!, en)).toBe('');
    expect(seen[0]!.body).toEqual({
      filter: { property: 'object', value: 'page' },
      sort: { timestamp: 'last_edited_time', direction: 'descending' },
      page_size: 100,
    });
    expect(seen[1]!.body).toMatchObject({ start_cursor: 'c2' });
    expect(seen.find((s) => s.url.endsWith('/query'))!.body).toEqual({ page_size: 100 });
  });

  it('reports an incomplete enumeration instead of throwing', async () => {
    const { c } = client((req) =>
      req.url.endsWith('/v1/search') && (req.body as any).filter.value === 'page'
        ? { body: { results: [page('p1', 'A', { type: 'workspace' })], has_more: false } }
        : { status: 400, body: { message: 'Bad search' } },
    );
    const en = await enumerateNotion(c);
    expect(en.complete).toBe(false);
    expect(en.error).toBe('Bad search');
    expect(en.pages.has('p1')).toBe(true);
  });

  it('treats has_more without a cursor as incomplete', async () => {
    const { c } = client(() => ({ body: { results: [], has_more: true, next_cursor: null } }));
    expect((await enumerateNotion(c)).complete).toBe(false);
  });
});

describe('Notion page text', () => {
  it('appends unknown blocks (ignoring 404s) and renders row properties first', async () => {
    const { c, seen } = client((req) => {
      if (req.url.includes('/v1/pages/r1/markdown')) {
        return { body: { markdown: '# Body', truncated: false, unknown_block_ids: ['b1', 'b2'] } };
      }
      if (req.url.includes('/v1/pages/b1/markdown')) return { body: { markdown: 'Block one' } };
      return { status: 404, body: { message: 'gone' } };
    });
    const row = readPage(
      page('r1', 'Task', { type: 'data_source_id', data_source_id: 'ds' }, {
        properties: {
          Name: { type: 'title', title: [{ plain_text: 'Task' }] },
          Status: { type: 'status', status: { name: 'Done' } },
          Tags: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] },
          Empty: { type: 'rich_text', rich_text: [] },
        },
      }),
    )!;
    const res = await fetchPageText(c, row);
    expect(res).toEqual({ text: 'Status: Done\nTags: a, b\n\n# Body\n\nBlock one', truncated: false });
    expect(seen[0]!.url).toBe('https://api.notion.com/v1/pages/r1/markdown?markdown_version=v2');
  });

  it('renders every supported property type and skips the rest', () => {
    expect(propertyValue({ type: 'rich_text', rich_text: [{ plain_text: 'a' }, { plain_text: 'b' }] })).toBe('ab');
    expect(propertyValue({ type: 'select', select: { name: 'High' } })).toBe('High');
    expect(propertyValue({ type: 'select', select: null })).toBe('');
    expect(propertyValue({ type: 'date', date: { start: '2026-01-01', end: '2026-01-05' } })).toBe('2026-01-01 → 2026-01-05');
    expect(propertyValue({ type: 'date', date: { start: '2026-01-01', end: null } })).toBe('2026-01-01');
    expect(propertyValue({ type: 'number', number: 0 })).toBe('0');
    expect(propertyValue({ type: 'number', number: null })).toBe('');
    expect(propertyValue({ type: 'checkbox', checkbox: false })).toBe('No');
    expect(propertyValue({ type: 'url', url: 'https://x' })).toBe('https://x');
    expect(propertyValue({ type: 'email', email: 'a@b.c' })).toBe('a@b.c');
    expect(propertyValue({ type: 'phone_number', phone_number: '+1' })).toBe('+1');
    expect(propertyValue({ type: 'formula', formula: { type: 'number', number: 4 } })).toBe('4');
    expect(propertyValue({ type: 'formula', formula: { type: 'boolean', boolean: true } })).toBe('Yes');
    expect(propertyValue({ type: 'formula', formula: { type: 'date', date: { start: '2026-02-02' } } })).toBe('2026-02-02');
    expect(propertyValue({ type: 'unique_id', unique_id: { prefix: 'TASK', number: 12 } })).toBe('TASK-12');
    expect(propertyValue({ type: 'unique_id', unique_id: { prefix: null, number: 12 } })).toBe('12');
    expect(propertyValue({ type: 'created_time', created_time: '2026-01-01T00:00:00Z' })).toBe('2026-01-01T00:00:00Z');
    expect(propertyValue({ type: 'people', people: [{ name: 'X' }] })).toBe('');
    expect(propertyValue({ type: 'relation' })).toBe('');
    expect(propertyValue(null)).toBe('');
    expect(renderProperties({ T: { type: 'title', title: [] }, Notes: { type: 'rich_text', rich_text: [{ plain_text: 'one\ntwo' }] } })).toBe(
      'Notes: one two',
    );
  });

  it('finds the title property whatever it is called', () => {
    expect(pageTitle({ Aufgabe: { type: 'title', title: [{ plain_text: 'Plan ' }, { plain_text: 'B' }] } })).toBe('Plan B');
    expect(pageTitle({ Name: { type: 'title', title: [] } })).toBe('Untitled');
    expect(pageTitle({})).toBe('Untitled');
  });
});

function turn(over: Partial<Turn> = {}): Turn {
  return {
    id: 't',
    createdAt: '2026-11-20T10:00:00.000Z',
    userMessage: 'What does the contract say?',
    mode: 'council',
    status: 'complete',
    error: null,
    members: [
      { id: 'm1', name: 'Claude', provider: 'claude', providerLabel: 'Claude', model: '', effort: '', roleId: 'none', roleLabel: '', color: '#000000' },
      { id: 'm2', name: 'Gemini', provider: 'antigravity', providerLabel: 'Gemini', model: '', effort: '', roleId: 'none', roleLabel: '', color: '#000000' },
    ],
    protocolName: 'Council',
    councilRules: '',
    webSearch: false,
    rounds: [
      {
        index: 0,
        type: 'answer',
        title: 'Independent answers',
        instructions: '',
        anonymize: false,
        includeSelf: false,
        status: 'done',
        labels: {},
        responses: [
          { memberId: 'm1', ranking: null, status: 'done', text: 'Claude says yes.', activity: '', error: null, startedAt: null, durationMs: 1, model: null, billing: 'unknown' },
          { memberId: 'm2', ranking: null, status: 'error', text: '', activity: '', error: 'x', startedAt: null, durationMs: 1, model: null, billing: 'unknown' },
        ],
        leaderboard: null,
      },
    ],
    arbiter: null,
    analysisText: 'They agree.',
    library: {
      mode: 'search',
      status: 'done',
      queries: [],
      plannerNote: '',
      excerpts: [
        { id: 'S1', documentId: 'd', title: 'MSA.pdf', sourceName: 'Docs', location: 'Contracts', part: 'p. 4', url: null, text: 't' },
      ],
      attachments: [
        { id: 'D1', documentId: 'e', title: 'Memo.docx', sourceName: 'Docs', location: '', url: null, chars: 3, truncated: false, problem: '' },
      ],
      browsableDocuments: 0,
      error: null,
    },
    finalText: 'The contract says yes [S1].',
    finalSource: { kind: 'arbiter', name: 'Claude', memberId: null },
    finishedAt: '2026-11-21T10:00:00.000Z',
    ...over,
  };
}

describe('save to Notion', () => {
  it('builds the page body with question, answer, sources and footer', () => {
    expect(notionMarkdown(turn(), false)).toBe(
      '## Question\n\nWhat does the contract say?\n\n## Answer\n\nThe contract says yes [S1].\n\n## Sources\n\n' +
        '- [S1] MSA.pdf — Contracts, p. 4\n- [D1] Memo.docx (attached)\n\n' +
        '*Answered by LLM Council · Claude, Gemini · Council · 2026-11-21*',
    );
  });

  it('adds the analysis and deliberation when asked, with only finished responses', () => {
    const md = notionMarkdown(turn(), true);
    expect(md).toContain('## Council analysis\n\nThey agree.');
    expect(md).toContain('## Deliberation\n\n### Round 1 · Independent answers\n\n#### Claude\n\nClaude says yes.');
    expect(md).not.toContain('#### Gemini');
  });

  it('drops the deliberation when the page would be too long', () => {
    const long = turn();
    long.rounds[0]!.responses[0]!.text = 'x'.repeat(MAX_NOTION_MARKDOWN);
    const md = notionMarkdown(long, true);
    expect(md).toContain(DELIBERATION_DROPPED);
    expect(md).not.toContain('## Deliberation');
    expect(md.length).toBeLessThan(MAX_NOTION_MARKDOWN);
  });

  it('escapes tag-like text outside code so a hostile answer cannot create Notion tags', () => {
    expect(escapeNotionText('Move it: <page url="https://notion.so/x">Home</page> and <mention-page url="y"/>')).toBe(
      'Move it: \\<page url="https://notion.so/x">Home\\</page> and \\<mention-page url="y"/>',
    );
    expect(escapeNotionText('<!-- c --> <?xml?> a < b, <3, 2<x')).toBe('\\<!-- c --> \\<?xml?> a < b, <3, 2\\<x');
    expect(escapeNotionText('Use `<page>` inline and ``a ` <b>`` too')).toBe('Use `<page>` inline and ``a ` <b>`` too');
    expect(escapeNotionText('```html\n<page url="x"></page>\n```\n<page>')).toBe('```html\n<page url="x"></page>\n```\n\\<page>');
    expect(escapeNotionText('~~~\n<b>\n~~~')).toBe('~~~\n<b>\n~~~');
    expect(escapeNotionText('unclosed `<b>')).toBe('unclosed `\\<b>');
  });

  it('escapes every piece of inserted text in the page body', () => {
    const t = turn({
      userMessage: 'Q <page url="q">',
      finalText: 'A <page url="a">\n```\n<keep>\n```',
      analysisText: 'An <database url="d">',
      protocolName: 'P <x>',
    });
    t.rounds[0]!.responses[0]!.text = 'R <callout>';
    t.rounds[0]!.title = 'Round <r>';
    t.members[0]!.name = 'M <m>';
    t.library!.excerpts[0]!.title = 'T <page url="t">\nline';
    t.library!.excerpts[0]!.location = 'L <l>';
    t.library!.attachments[0]!.title = 'D <d>';
    const md = notionMarkdown(t, true);
    expect(md.match(/(?<!\\)<[A-Za-z/!?]/g)).toEqual(['<k']);
    expect(md).toContain('```\n<keep>\n```');
    expect(md).toContain('- [S1] T \\<page url="t"> line — L \\<l>, p. 4');
  });

  it('sends the title as plain text on one line', () => {
    const conversation: Conversation = { id: 'c', title: 'Title <page url="x">\nsecond', createdAt: '', updatedAt: '', turns: [] };
    const title = notionPageTitle(conversation);
    expect(title).toBe('Title <page url="x"> second');
    expect(createPageBody('p', title, '')).toMatchObject({ properties: { title: { title: [{ type: 'text', text: { content: title } }] } } });
  });

  it('posts the documented body once and returns the page link', async () => {
    const { c, seen } = client(() => ({ body: { object: 'page', id: 'new', url: 'https://www.notion.so/new' } }));
    const conversation: Conversation = { id: 'c', title: 'T'.repeat(250), createdAt: '', updatedAt: '', turns: [] };
    const res = await saveTurnToNotion(c, 'parent-id', conversation, turn(), false);
    expect(res.url).toBe('https://www.notion.so/new');
    expect(res.title).toHaveLength(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: 'https://api.notion.com/v1/pages' });
    expect(seen[0]!.body).toEqual(createPageBody('parent-id', res.title, notionMarkdown(turn(), false)));
    expect(seen[0]!.body).toMatchObject({
      parent: { page_id: 'parent-id' },
      properties: { title: { title: [{ text: { content: res.title } }] } },
      markdown_version: 'v2',
    });
  });
});
