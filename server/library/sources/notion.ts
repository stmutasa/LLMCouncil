import { joinLines } from '../extract/normalize';
import { NotionError, type NotionClient } from '../notionClient';

/** Notion hands back partial objects in places; every field is read defensively. */
type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface NotionParent {
  type: string;
  id: string | null;
}

export interface NotionPage {
  id: string;
  url: string | null;
  lastEdited: string;
  title: string;
  parent: NotionParent;
  properties: Json;
}

export interface NotionEnumeration {
  pages: Map<string, NotionPage>;
  dataSources: Map<string, { title: string; parent: NotionParent }>;
  /** False when any request failed: documents that were not seen must not be deleted then. */
  complete: boolean;
  error: string | null;
}

export function richText(value: unknown): string {
  return list(value)
    .map((t) => (isObject(t) ? (str(t.plain_text) ?? '') : ''))
    .join('');
}

function readParent(value: unknown): NotionParent {
  if (!isObject(value)) return { type: 'unknown', id: null };
  const type = str(value.type) ?? 'unknown';
  const id = str(value[type]) ?? str(value.page_id) ?? str(value.data_source_id) ?? str(value.database_id) ?? null;
  return { type, id: type === 'workspace' ? null : id };
}

/** The value of the page's title property, whatever it is called. */
export function pageTitle(properties: Json): string {
  for (const prop of Object.values(properties)) {
    if (isObject(prop) && prop.type === 'title') {
      const t = richText(prop.title).trim();
      return t || 'Untitled';
    }
  }
  return 'Untitled';
}

/** A page object from search or a data source query; null for partial or trashed ones. */
export function readPage(value: unknown): NotionPage | null {
  if (!isObject(value) || value.object !== 'page') return null;
  const id = str(value.id);
  const lastEdited = str(value.last_edited_time);
  if (!id || !lastEdited) return null;
  if (value.in_trash === true || value.archived === true) return null;
  const properties = isObject(value.properties) ? value.properties : {};
  return {
    id,
    url: str(value.url),
    lastEdited,
    title: pageTitle(properties),
    parent: readParent(value.parent),
    properties,
  };
}

function formulaValue(f: unknown): string {
  if (!isObject(f)) return '';
  switch (f.type) {
    case 'string':
      return str(f.string) ?? '';
    case 'number':
      return typeof f.number === 'number' ? String(f.number) : '';
    case 'boolean':
      return typeof f.boolean === 'boolean' ? (f.boolean ? 'Yes' : 'No') : '';
    case 'date':
      return dateValue(f.date);
    default:
      return '';
  }
}

function dateValue(d: unknown): string {
  if (!isObject(d)) return '';
  const start = str(d.start);
  if (!start) return '';
  const end = str(d.end);
  return end ? `${start} → ${end}` : start;
}

/** One property's value as text; '' for empty values and types that are not shown. */
export function propertyValue(prop: unknown): string {
  if (!isObject(prop)) return '';
  const type = str(prop.type);
  const v = type ? prop[type] : undefined;
  switch (type) {
    case 'rich_text':
      return richText(v);
    case 'select':
    case 'status':
      return isObject(v) ? (str(v.name) ?? '') : '';
    case 'multi_select':
      return list(v)
        .map((o) => (isObject(o) ? (str(o.name) ?? '') : ''))
        .filter(Boolean)
        .join(', ');
    case 'date':
      return dateValue(v);
    case 'number':
      return typeof v === 'number' ? String(v) : '';
    case 'checkbox':
      return typeof v === 'boolean' ? (v ? 'Yes' : 'No') : '';
    case 'url':
    case 'email':
    case 'phone_number':
    case 'created_time':
    case 'last_edited_time':
      return str(v) ?? '';
    case 'formula':
      return formulaValue(v);
    case 'unique_id': {
      if (!isObject(v) || typeof v.number !== 'number') return '';
      const prefix = str(v.prefix);
      return prefix ? `${prefix}-${v.number}` : String(v.number);
    }
    default:
      return '';
  }
}

/** A database row's properties (except its title) as "Name: value" lines. */
export function renderProperties(properties: Json): string {
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    if (isObject(prop) && prop.type === 'title') continue;
    const value = propertyValue(prop).trim();
    if (value) lines.push(`${name}: ${joinLines(value)}`);
  }
  return lines.join('\n');
}

const MAX_LIST_PAGES = 1_000;

/** Pages through a list endpoint while `has_more`, calling `onResult` for every result. */
async function paginate(
  call: (cursor: string | null) => Promise<Json>,
  onResult: (value: unknown) => void,
): Promise<void> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    const res = await call(cursor);
    for (const r of list(res.results)) onResult(r);
    if (res.has_more !== true) return;
    const next = str(res.next_cursor);
    if (!next || seen.has(next)) throw new NotionError('Notion returned an incomplete list (no next page).', 0, 'pagination');
    seen.add(next);
    cursor = next;
  }
  throw new NotionError('Notion returned more results than the library can list.', 0, 'pagination');
}

/**
 * Every page the token can see: pages from search, plus the rows of every data source
 * (merged by id). On a failure, what was found so far is returned with `complete: false`.
 */
export async function enumerateNotion(client: NotionClient, signal?: AbortSignal): Promise<NotionEnumeration> {
  const en: NotionEnumeration = { pages: new Map(), dataSources: new Map(), complete: true, error: null };
  const addPage = (value: unknown) => {
    const page = readPage(value);
    if (page) en.pages.set(page.id, page);
  };
  try {
    const searchFor = (value: 'page' | 'data_source') => (cursor: string | null) => {
      const body: Json = {
        filter: { property: 'object', value },
        sort: { timestamp: 'last_edited_time', direction: 'descending' },
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;
      return client.search(body, signal);
    };
    await paginate(searchFor('page'), addPage);
    await paginate(searchFor('data_source'), (value) => {
      if (!isObject(value) || value.object !== 'data_source' || value.in_trash === true || value.archived === true) return;
      const id = str(value.id);
      if (!id) return;
      en.dataSources.set(id, { title: richText(value.title).trim() || 'Untitled', parent: readParent(value.parent) });
    });
    for (const id of en.dataSources.keys()) {
      await paginate((cursor) => {
        const body: Json = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        return client.queryDataSource(id, body, signal);
      }, addPage);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    en.complete = false;
    en.error = (err as Error).message;
  }
  return en;
}

/** The trail of ancestor titles ("Projects / Q3"), best effort; '' at the top of the workspace. */
export function locationOf(page: NotionPage, en: NotionEnumeration): string {
  const trail: string[] = [];
  let parent = page.parent;
  const seen = new Set<string>([page.id]);
  for (let depth = 0; depth < 20 && parent.id && !seen.has(parent.id); depth++) {
    seen.add(parent.id);
    if (parent.type === 'page_id') {
      const p = en.pages.get(parent.id);
      if (!p) break;
      trail.unshift(p.title);
      parent = p.parent;
    } else if (parent.type === 'data_source_id') {
      const ds = en.dataSources.get(parent.id);
      if (!ds) break;
      trail.unshift(ds.title);
      parent = ds.parent;
    } else {
      break;
    }
  }
  return trail.join(' / ');
}

export function isRow(page: NotionPage): boolean {
  return page.parent.type === 'data_source_id' || page.parent.type === 'database_id';
}

const MAX_UNKNOWN_BLOCKS = 20;

/** A page's text: row properties (for database rows), then its Markdown. */
export async function fetchPageText(
  client: NotionClient,
  page: NotionPage,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const res = await client.pageMarkdown(page.id, signal);
  const pieces: string[] = [];
  if (isRow(page)) {
    const props = renderProperties(page.properties);
    if (props) pieces.push(props);
  }
  pieces.push(str(res.markdown) ?? '');
  const unknown = list(res.unknown_block_ids).filter((x): x is string => typeof x === 'string');
  for (const blockId of unknown.slice(0, MAX_UNKNOWN_BLOCKS)) {
    try {
      const block = await client.pageMarkdown(blockId, signal);
      const md = str(block.markdown);
      if (md) pieces.push(md);
    } catch (err) {
      if (err instanceof NotionError && err.status === 404) continue;
      throw err;
    }
  }
  return { text: pieces.filter((p) => p.trim() !== '').join('\n\n'), truncated: res.truncated === true };
}
