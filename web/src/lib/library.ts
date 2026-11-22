import type {
  DirectoryListing,
  DocumentStatus,
  LibrarySource,
  LibrarySourceStatus,
  LibraryStatus,
  ProviderInfo,
  Settings,
  SourceExcerpt,
  SyncState,
  TurnAttachment,
  TurnLibrary,
} from '../../../shared/types';
import { count, formatNumber } from './format';

/** Source names: 1–60 characters, unique (the server enforces the same rule). */
export const SOURCE_NAME_MAX = 60;

// ---------------------------------------------------------------------------------------------
// Sizes and times
// ---------------------------------------------------------------------------------------------

/** Compact size of a text: "820 characters", "4.8k characters", "48k characters", "1.2M characters". */
export function formatChars(chars: number): string {
  const n = Number.isFinite(chars) && chars > 0 ? Math.round(chars) : 0;
  if (n < 1000) return count(n, 'character');
  if (n < 10_000) return `${trimZero((n / 1000).toFixed(1))}k characters`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k characters`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M characters`;
}

function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/** Characters ÷ 4, rounded so the figure does not suggest false precision: "About 6,000 tokens". */
export function approxTokens(chars: number): string {
  const raw = Number.isFinite(chars) && chars > 0 ? chars / 4 : 0;
  const rounded = raw < 1000 ? Math.round(raw / 10) * 10 : Math.round(raw / 100) * 100;
  return `About ${count(rounded, 'token')}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", "on 12 Mar 2026". */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'at an unknown time';
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${count(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${count(hours, 'hour')} ago`;
  const days = Math.floor(hours / 24);
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// ---------------------------------------------------------------------------------------------
// Source cards
// ---------------------------------------------------------------------------------------------

export type Tone = 'neutral' | 'warning';

export interface StatusLine {
  text: string;
  tone: Tone;
}

/** "1,204 documents · last checked 5 minutes ago", or why the source cannot be read. */
export function sourceStatusLine(status: LibrarySourceStatus, now: number): StatusLine {
  if (!status.ready) {
    const fallback = status.source.kind === 'folder' ? 'This folder cannot be read.' : 'Notion is not connected.';
    return { text: status.readyDetail.trim() || fallback, tone: 'warning' };
  }
  const docs = count(status.counts.ok ?? 0, 'document');
  const checked = status.lastSyncedAt ? `last checked ${relativeTime(status.lastSyncedAt, now)}` : 'not checked yet';
  return { text: `${docs} · ${checked}`, tone: 'neutral' };
}

export interface ProblemCount {
  status: Exclude<DocumentStatus, 'ok'>;
  count: number;
  /** "38 could not be read" */
  label: string;
  /** Heading of the list dialog: "38 files could not be read". */
  title: string;
  tone: Tone;
}

/** Order in which problems are listed: the ones the user can act on first. */
const PROBLEM_ORDER: Exclude<DocumentStatus, 'ok'>[] = ['error', 'stub', 'empty', 'unsupported', 'too-large'];

/**
 * Problem counts as compact links. Only files that failed to read are a warning; the rest are
 * facts about the library (link files, scans, file types) and stay neutral.
 */
export function problemCounts(counts: Partial<Record<DocumentStatus, number>>, kind: LibrarySource['kind']): ProblemCount[] {
  const noun = kind === 'notion' ? ['page', 'pages'] : ['file', 'files'];
  const items = (n: number) => (n === 1 ? noun[0]! : noun[1]!);
  const out: ProblemCount[] = [];
  for (const status of PROBLEM_ORDER) {
    const n = counts[status] ?? 0;
    if (!(n > 0)) continue;
    const num = formatNumber(n);
    switch (status) {
      case 'error':
        out.push({ status, count: n, label: `${num} could not be read`, title: `${num} ${items(n)} could not be read`, tone: 'warning' });
        break;
      case 'stub':
        out.push({
          status,
          count: n,
          label: `${num} Google Docs link ${n === 1 ? 'file' : 'files'}`,
          title: `${num} Google Docs link ${n === 1 ? 'file' : 'files'}`,
          tone: 'neutral',
        });
        break;
      case 'empty':
        out.push({ status, count: n, label: `${num} without text`, title: `${num} ${items(n)} without text`, tone: 'neutral' });
        break;
      case 'unsupported':
        out.push({ status, count: n, label: `${num} unsupported`, title: `${num} ${items(n)} of a type that is not read`, tone: 'neutral' });
        break;
      case 'too-large':
        out.push({ status, count: n, label: `${num} too large`, title: `${num} ${items(n)} too large to read`, tone: 'neutral' });
        break;
    }
  }
  return out;
}

/** A sync counts as active from the moment it is queued until it finishes. */
export function isSyncActive(sync: SyncState): boolean {
  return sync.running || sync.phase === 'queued' || sync.phase === 'scanning' || sync.phase === 'reading';
}

export function anySyncActive(status: LibraryStatus | null): boolean {
  return Boolean(status?.sources.some((s) => isSyncActive(s.sync)));
}

export interface SyncProgress {
  text: string;
  /** 0..1, or null while the amount of work is unknown. */
  fraction: number | null;
  /** The document being read, shown after the count; '' when none. */
  current: string;
}

export function syncProgress(sync: SyncState): SyncProgress {
  switch (sync.phase) {
    case 'queued':
      return { text: 'Waiting for another source to finish', fraction: null, current: '' };
    case 'scanning':
      return { text: 'Looking for changes…', fraction: null, current: '' };
    case 'reading': {
      if (sync.total > 0) {
        const done = Math.min(Math.max(0, sync.done), sync.total);
        return { text: `Reading ${formatNumber(done)} of ${formatNumber(sync.total)}`, fraction: done / sync.total, current: sync.current };
      }
      return { text: 'Reading…', fraction: null, current: sync.current };
    }
    default:
      return { text: 'Starting…', fraction: null, current: '' };
  }
}

// ---------------------------------------------------------------------------------------------
// Sources in settings
// ---------------------------------------------------------------------------------------------

/** Last segment of a path, for the default source name: "/Users/ann/My Drive" → "My Drive". */
export function folderName(path: string): string {
  const trimmed = path.trim();
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return trimmed.startsWith('/') ? '/' : trimmed;
  return parts[parts.length - 1]!;
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * Breadcrumbs for a directory path. POSIX paths start at "/", Windows paths at their drive
 * ("C:\") or UNC share ("\\server\share"); each crumb's path is what to list to get there.
 */
export function breadcrumbs(path: string): Crumb[] {
  const drive = /^([A-Za-z]:)(?:[\\/]+(.*))?$/.exec(path);
  if (drive) {
    const root = `${drive[1]!.toUpperCase()}\\`;
    return withSegments({ label: root, path: root }, drive[2] ?? '', '\\');
  }
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/.exec(path);
  if (unc) {
    const root = `\\\\${unc[1]}\\${unc[2]}`;
    return withSegments({ label: root, path: root }, unc[3] ?? '', '\\');
  }
  if (path.startsWith('/')) return withSegments({ label: '/', path: '/' }, path.slice(1), '/');
  return path ? [{ label: path, path }] : [];
}

function withSegments(root: Crumb, rest: string, sep: string): Crumb[] {
  const crumbs = [root];
  let current = root.path;
  for (const segment of rest.split(/[\\/]+/).filter(Boolean)) {
    current = current.endsWith(sep) ? `${current}${segment}` : `${current}${sep}${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

/** Google Drive for Desktop folders are the likely choice, so they are offered first. */
export function isDriveShortcut(shortcut: { label: string; path: string }): boolean {
  return (
    /google\s*drive|my drive|shared drives?/i.test(shortcut.label) ||
    /GoogleDrive-|[\\/](?:My Drive|Shared drives|Google Drive)(?:[\\/]|$)/i.test(shortcut.path)
  );
}

export function splitShortcuts(shortcuts: DirectoryListing['shortcuts']): {
  drive: DirectoryListing['shortcuts'];
  other: DirectoryListing['shortcuts'];
} {
  return { drive: shortcuts.filter(isDriveShortcut), other: shortcuts.filter((s) => !isDriveShortcut(s)) };
}

/** "Docs", or "Docs 2" when taken (case-insensitively), within the length limit. */
export function uniqueSourceName(base: string, sources: LibrarySource[]): string {
  const clean = (base.trim() || 'Folder').slice(0, SOURCE_NAME_MAX);
  const taken = new Set(sources.map((s) => s.name.trim().toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const candidate = `${clean.slice(0, SOURCE_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function validateSourceName(name: string, sources: LibrarySource[], selfId: string | null): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name.';
  if (trimmed.length > SOURCE_NAME_MAX) return `Use at most ${SOURCE_NAME_MAX} characters.`;
  const clash = sources.find((s) => s.id !== selfId && s.name.trim().toLowerCase() === trimmed.toLowerCase());
  return clash ? `Another source is already called “${clash.name.trim()}”.` : null;
}

/** Comparison key for folder paths: separators unified, trailing separators dropped. */
export function pathKey(path: string): string {
  const unified = path.trim().replace(/\\/g, '/');
  const stripped = unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
  // Windows paths are case-insensitive; POSIX ones are not.
  return /^[A-Za-z]:/.test(stripped) || stripped.startsWith('//') ? stripped.toLowerCase() : stripped;
}

export function validateFolderPath(path: string, sources: LibrarySource[]): string | null {
  const trimmed = path.trim();
  if (!trimmed) return 'Enter or choose a folder.';
  const key = pathKey(trimmed);
  const existing = sources.find((s) => s.kind === 'folder' && pathKey(s.path) === key);
  return existing ? `This folder is already in the library as “${existing.name}”.` : null;
}

/**
 * The settings dialog edits a draft captured when it opens, but library sources, the Notion save
 * location and the composer's library mode are saved the moment they change. Saving the draft
 * must carry those live values, never the stale copies it was opened with.
 */
export function withLiveLibrary(draft: Settings, live: Settings): Settings {
  return {
    ...draft,
    library: {
      ...draft.library,
      sources: live.library.sources,
      mode: live.library.mode,
      notionSaveParent: live.library.notionSaveParent,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------------------------

export interface BrowseSupport {
  yes: string[];
  untested: string[];
  no: string[];
}

/** Which enabled members' providers can open the library themselves in browse mode. */
export function browseSupport(settings: Settings, providers: ProviderInfo[]): BrowseSupport {
  const result: BrowseSupport = { yes: [], untested: [], no: [] };
  for (const m of settings.members) {
    if (!m.enabled) continue;
    const browse = providers.find((p) => p.id === m.provider)?.browse ?? 'no';
    result[browse].push(m.name);
  }
  return result;
}

export function browseNote(support: BrowseSupport): string {
  const parts: string[] = [];
  if (support.yes.length) parts.push(`Can open files: ${support.yes.join(', ')}.`);
  if (support.untested.length) parts.push(`Untested: ${support.untested.join(', ')}.`);
  if (support.no.length) parts.push(`Passages only: ${support.no.join(', ')}.`);
  return parts.join(' ');
}

/** A document attached in the composer. */
export interface AttachedDocument {
  id: string;
  title: string;
  location: string;
  sourceName: string;
  /** Characters of the document's text (for the budget). */
  chars: number;
  /** `chars` is a lower bound: the document was cut when it was last sent. */
  atLeast: boolean;
  /** Why it could not be included last time; '' when it was. */
  problem: string;
}

/** The composer's starting attachments for a conversation: the last turn's, in the same order. */
export function attachmentsFromTurn(attachments: TurnAttachment[]): AttachedDocument[] {
  const seen = new Set<string>();
  const out: AttachedDocument[] = [];
  for (const a of attachments) {
    if (seen.has(a.documentId)) continue;
    seen.add(a.documentId);
    out.push({
      id: a.documentId,
      title: a.title,
      location: a.location,
      sourceName: a.sourceName,
      chars: a.chars,
      atLeast: a.truncated,
      problem: a.problem,
    });
  }
  return out;
}

export interface BudgetItem {
  id: string;
  included: number;
  cut: boolean;
  leftOut: boolean;
}

export interface BudgetPlan {
  total: number;
  budget: number;
  /** Characters beyond the budget; 0 when everything fits. */
  over: number;
  items: BudgetItem[];
}

/**
 * Mirrors how the server shares the attachment budget: in the order given, each document gets
 * what it needs until the budget runs out; the one that does not fit is cut and any after it
 * get nothing. (The server cuts at a part or paragraph boundary, so figures are approximate.)
 */
export function attachmentBudget(docs: { id: string; chars: number }[], budget: number): BudgetPlan {
  const safeBudget = Number.isFinite(budget) && budget > 0 ? budget : 0;
  let remaining = safeBudget;
  let total = 0;
  const items: BudgetItem[] = [];
  for (const d of docs) {
    const chars = Number.isFinite(d.chars) && d.chars > 0 ? d.chars : 0;
    total += chars;
    const included = Math.min(chars, remaining);
    remaining -= included;
    items.push({ id: d.id, included, cut: included > 0 && included < chars, leftOut: chars > 0 && included === 0 });
  }
  return { total, budget: safeBudget, over: Math.max(0, total - safeBudget), items };
}

// ---------------------------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------------------------

export function whereText(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(' · ');
}

export interface ExcerptGroup {
  documentId: string;
  title: string;
  sourceName: string;
  location: string;
  url: string | null;
  excerpts: SourceExcerpt[];
}

/** Passages grouped by document, in the order each document first appears. */
export function groupExcerpts(excerpts: SourceExcerpt[]): ExcerptGroup[] {
  const groups = new Map<string, ExcerptGroup>();
  for (const e of excerpts) {
    const group = groups.get(e.documentId);
    if (group) group.excerpts.push(e);
    else
      groups.set(e.documentId, {
        documentId: e.documentId,
        title: e.title,
        sourceName: e.sourceName,
        location: e.location,
        url: e.url,
        excerpts: [e],
      });
  }
  return [...groups.values()];
}

export interface LibrarySummary {
  text: string;
  tone: 'running' | 'done' | 'quiet' | 'warning';
}

/** Header of a turn's Sources block. */
export function librarySummary(library: TurnLibrary): LibrarySummary {
  if (library.status === 'pending' || library.status === 'running') {
    const searching = library.mode !== 'off';
    return { text: searching ? 'Searching the library…' : 'Reading the attached documents…', tone: 'running' };
  }
  if (library.status === 'error') {
    return { text: library.error?.trim() || 'The library could not be searched.', tone: 'warning' };
  }

  const passages = library.excerpts.length;
  const documents = new Set(library.excerpts.map((e) => e.documentId)).size;
  const attached = library.attachments.length;
  const searched = library.queries.length > 0;
  const parts: string[] = [];
  if (passages > 0) {
    parts.push(attached > 0 ? count(passages, 'passage') : `${count(passages, 'passage')} from ${count(documents, 'document')}`);
  }
  if (attached > 0) parts.push(count(attached, 'attached document'));
  if (passages === 0 && searched) {
    parts.push(attached > 0 ? 'nothing relevant found in the library' : 'Nothing relevant found in the library');
  }
  if (parts.length === 0) {
    parts.push(library.mode === 'off' ? 'The library was not used' : 'The library had no searchable documents');
  }
  if (library.mode === 'browse' && library.browsableDocuments > 0) {
    parts.push(`models could open ${count(library.browsableDocuments, 'document')}`);
  }
  const tone = passages > 0 || attached > 0 ? 'done' : 'quiet';
  return { text: parts.join(' · '), tone };
}

/**
 * What a screen reader hears about syncs: only when one starts, starts reading and finishes,
 * never the counts that change every poll.
 */
export function syncAnnouncements(prev: LibraryStatus | null, next: LibraryStatus): string[] {
  const out: string[] = [];
  for (const s of next.sources) {
    const before = prev?.sources.find((p) => p.source.id === s.source.id);
    if (!before) continue;
    const name = s.source.name;
    const was = isSyncActive(before.sync);
    const is = isSyncActive(s.sync);
    if (!was && is) out.push(`Checking ${name} for changes.`);
    if (is && s.sync.phase === 'reading' && before.sync.phase !== 'reading' && s.sync.total > 0) {
      out.push(`Reading ${count(s.sync.total, 'document')} in ${name}.`);
    }
    if (was && !is) {
      out.push(s.sync.error ? `Checking ${name} stopped: ${s.sync.error}` : `Finished checking ${name}: ${count(s.counts.ok ?? 0, 'document')}.`);
    }
  }
  return out;
}
