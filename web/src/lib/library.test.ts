import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../shared/defaults';
import type { LibrarySourceStatus, ProviderInfo, Settings, SyncState } from '../../../shared/types';
import { count } from './format';
import {
  approxTokens,
  attachmentBudget,
  attachmentsFromTurn,
  breadcrumbs,
  browseNote,
  browseSupport,
  folderName,
  formatChars,
  groupExcerpts,
  isDriveShortcut,
  isSyncActive,
  librarySummary,
  pathKey,
  problemCounts,
  relativeTime,
  sourceStatusLine,
  splitShortcuts,
  syncAnnouncements,
  syncProgress,
  uniqueSourceName,
  validateFolderPath,
  validateSourceName,
  whereText,
  withLiveLibrary,
} from './library';
import { attachment, excerpt, library } from './testFixtures';

const NOW = Date.parse('2026-03-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function idle(): SyncState {
  return { running: false, phase: 'idle', done: 0, total: 0, current: '', error: null };
}

function sourceStatus(patch: Partial<LibrarySourceStatus> = {}): LibrarySourceStatus {
  return {
    source: { id: 's1', kind: 'folder', name: 'Drive', enabled: true, path: '/Users/ann/My Drive' },
    ready: true,
    readyDetail: '',
    counts: { ok: 1204, empty: 0, unsupported: 0, stub: 0, 'too-large': 0, error: 0 },
    chars: 1_000_000,
    lastSyncedAt: ago(5 * MIN),
    sync: idle(),
    ...patch,
  };
}

describe('count', () => {
  it('uses thousands separators and the right noun form', () => {
    expect(count(1, 'document')).toBe('1 document');
    expect(count(0, 'document')).toBe('0 documents');
    expect(count(1204, 'document')).toBe('1,204 documents');
  });
});

describe('formatChars and approxTokens', () => {
  it('formats sizes compactly', () => {
    expect(formatChars(0)).toBe('0 characters');
    expect(formatChars(1)).toBe('1 character');
    expect(formatChars(820)).toBe('820 characters');
    expect(formatChars(4800)).toBe('4.8k characters');
    expect(formatChars(5000)).toBe('5k characters');
    expect(formatChars(48_210)).toBe('48k characters');
    expect(formatChars(1_200_000)).toBe('1.2M characters');
    expect(formatChars(Number.NaN)).toBe('0 characters');
    expect(formatChars(-3)).toBe('0 characters');
  });

  it('estimates tokens as characters divided by four, rounded', () => {
    expect(approxTokens(24_000)).toBe('About 6,000 tokens');
    expect(approxTokens(120_000)).toBe('About 30,000 tokens');
    expect(approxTokens(12_345)).toBe('About 3,100 tokens');
    expect(approxTokens(2000)).toBe('About 500 tokens');
    expect(approxTokens(Number.NaN)).toBe('About 0 tokens');
  });
});

describe('relativeTime', () => {
  it('describes recent and older times', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('just now');
    expect(relativeTime(ago(-60_000), NOW)).toBe('just now');
    expect(relativeTime(ago(MIN), NOW)).toBe('1 minute ago');
    expect(relativeTime(ago(5 * MIN), NOW)).toBe('5 minutes ago');
    expect(relativeTime(ago(3 * 60 * MIN), NOW)).toBe('3 hours ago');
    expect(relativeTime(ago(30 * 60 * MIN), NOW)).toBe('yesterday');
    expect(relativeTime(ago(4 * 24 * 60 * MIN), NOW)).toBe('4 days ago');
    expect(relativeTime('2026-01-02T10:00:00.000Z', NOW)).toBe('on 2 Jan 2026');
    expect(relativeTime('nonsense', NOW)).toBe('at an unknown time');
  });
});

describe('sourceStatusLine', () => {
  it('shows documents and when the source was last checked', () => {
    expect(sourceStatusLine(sourceStatus(), NOW)).toEqual({ text: '1,204 documents · last checked 5 minutes ago', tone: 'neutral' });
    expect(sourceStatusLine(sourceStatus({ lastSyncedAt: null }), NOW).text).toBe('1,204 documents · not checked yet');
  });

  it('shows why a source is not ready, in the warning tone', () => {
    expect(sourceStatusLine(sourceStatus({ ready: false, readyDetail: 'The folder does not exist.' }), NOW)).toEqual({
      text: 'The folder does not exist.',
      tone: 'warning',
    });
    expect(sourceStatusLine(sourceStatus({ ready: false }), NOW).text).toBe('This folder cannot be read.');
  });
});

describe('problemCounts', () => {
  it('lists non-zero problems in a fixed order, warning only for read failures', () => {
    const list = problemCounts({ ok: 10, error: 38, stub: 12, empty: 5, unsupported: 7, 'too-large': 1 }, 'folder');
    expect(list.map((p) => p.label)).toEqual([
      '38 could not be read',
      '12 Google Docs link files',
      '5 without text',
      '7 unsupported',
      '1 too large',
    ]);
    expect(list.map((p) => p.tone)).toEqual(['warning', 'neutral', 'neutral', 'neutral', 'neutral']);
    expect(list[0]!.title).toBe('38 files could not be read');
  });

  it('omits zero counts, tolerates missing keys and names Notion pages as pages', () => {
    expect(problemCounts({ ok: 3 }, 'folder')).toEqual([]);
    const notion = problemCounts({ error: 1, stub: 1 }, 'notion');
    expect(notion[0]!.title).toBe('1 page could not be read');
    expect(notion[1]!.label).toBe('1 Google Docs link file');
  });
});

describe('sync helpers', () => {
  it('treats queued, scanning and reading as active', () => {
    expect(isSyncActive(idle())).toBe(false);
    expect(isSyncActive({ ...idle(), phase: 'queued' })).toBe(true);
    expect(isSyncActive({ ...idle(), running: true })).toBe(true);
  });

  it('describes progress', () => {
    expect(syncProgress({ ...idle(), running: true, phase: 'reading', done: 212, total: 640, current: 'Q3 board deck.pdf' })).toEqual({
      text: 'Reading 212 of 640',
      fraction: 212 / 640,
      current: 'Q3 board deck.pdf',
    });
    expect(syncProgress({ ...idle(), running: true, phase: 'reading', done: 9, total: 4 }).text).toBe('Reading 4 of 4');
    expect(syncProgress({ ...idle(), running: true, phase: 'reading' }).fraction).toBeNull();
    expect(syncProgress({ ...idle(), phase: 'queued' }).text).toBe('Waiting for another source to finish');
    expect(syncProgress({ ...idle(), running: true, phase: 'scanning' }).text).toBe('Looking for changes…');
  });
});

describe('paths', () => {
  it('takes the last segment as the folder name', () => {
    expect(folderName('/Users/ann/My Drive')).toBe('My Drive');
    expect(folderName('/Users/ann/My Drive/')).toBe('My Drive');
    expect(folderName('C:\\Users\\ann\\Documents')).toBe('Documents');
    expect(folderName('G:\\')).toBe('G:');
    expect(folderName('/')).toBe('/');
  });

  it('builds breadcrumbs for POSIX, Windows and UNC paths', () => {
    expect(breadcrumbs('/Users/ann')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'ann', path: '/Users/ann' },
    ]);
    expect(breadcrumbs('/')).toEqual([{ label: '/', path: '/' }]);
    expect(breadcrumbs('c:\\Users\\ann\\')).toEqual([
      { label: 'C:\\', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'ann', path: 'C:\\Users\\ann' },
    ]);
    expect(breadcrumbs('G:')).toEqual([{ label: 'G:\\', path: 'G:\\' }]);
    expect(breadcrumbs('\\\\nas\\share\\docs')).toEqual([
      { label: '\\\\nas\\share', path: '\\\\nas\\share' },
      { label: 'docs', path: '\\\\nas\\share\\docs' },
    ]);
    expect(breadcrumbs('')).toEqual([]);
  });

  it('compares paths ignoring trailing separators, and case on Windows only', () => {
    expect(pathKey('/a/b/')).toBe(pathKey('/a/b'));
    expect(pathKey('/A/b')).not.toBe(pathKey('/a/b'));
    expect(pathKey('C:\\Docs\\')).toBe(pathKey('c:/docs'));
    expect(pathKey('/')).toBe('/');
  });

  it('recognises Google Drive for Desktop shortcuts and lists them first', () => {
    expect(isDriveShortcut({ label: 'Google Drive (ann@example.com)', path: '/Users/ann/Library/CloudStorage/GoogleDrive-ann@example.com' })).toBe(true);
    expect(isDriveShortcut({ label: 'My Drive', path: 'G:\\My Drive' })).toBe(true);
    expect(isDriveShortcut({ label: 'Drive', path: '/Users/ann/Library/CloudStorage/GoogleDrive-x/Shared drives' })).toBe(true);
    expect(isDriveShortcut({ label: 'Documents', path: '/Users/ann/Documents' })).toBe(false);
    const split = splitShortcuts([
      { label: 'Home', path: '/Users/ann' },
      { label: 'Google Drive', path: '/Users/ann/Google Drive' },
    ]);
    expect(split.drive.map((s) => s.label)).toEqual(['Google Drive']);
    expect(split.other.map((s) => s.label)).toEqual(['Home']);
  });
});

describe('source names and paths in settings', () => {
  const sources = [
    { id: 'a', kind: 'folder' as const, name: 'Docs', enabled: true, path: '/Users/ann/Docs' },
    { id: 'n', kind: 'notion' as const, name: 'Notion', enabled: true },
  ];

  it('makes default names unique', () => {
    expect(uniqueSourceName('Contracts', sources)).toBe('Contracts');
    expect(uniqueSourceName('docs', sources)).toBe('docs 2');
    expect(uniqueSourceName('   ', [])).toBe('Folder');
    expect(uniqueSourceName('x'.repeat(80), [])).toHaveLength(60);
    const long = 'y'.repeat(60);
    expect(uniqueSourceName(long, [{ id: 'b', kind: 'notion', name: long, enabled: true }])).toBe(`${'y'.repeat(58)} 2`);
  });

  it('validates names', () => {
    expect(validateSourceName(' ', sources, null)).toBe('Enter a name.');
    expect(validateSourceName('z'.repeat(61), sources, null)).toBe('Use at most 60 characters.');
    expect(validateSourceName('NOTION', sources, 'a')).toBe('Another source is already called “Notion”.');
    expect(validateSourceName('Notion', sources, 'n')).toBeNull();
  });

  it('validates folder paths', () => {
    expect(validateFolderPath('  ', sources)).toBe('Enter or choose a folder.');
    expect(validateFolderPath('/Users/ann/Docs/', sources)).toBe('This folder is already in the library as “Docs”.');
    expect(validateFolderPath('/Users/ann/Other', sources)).toBeNull();
  });
});

describe('withLiveLibrary', () => {
  it('keeps draft edits and takes sources, mode and save location from the live settings', () => {
    const opened = defaultSettings();
    const draft: Settings = structuredClone(opened);
    draft.library.excerptChars = 30_000;
    draft.councilRules = 'Be brief.';

    const live: Settings = structuredClone(opened);
    live.library.sources = [{ id: 'f1', kind: 'folder', name: 'Drive', enabled: true, path: '/d' }];
    live.library.mode = 'browse';
    live.library.notionSaveParent = { id: 'p', title: 'Council answers' };
    live.library.excerptChars = 1;

    const merged = withLiveLibrary(draft, live);
    expect(merged.library.excerptChars).toBe(30_000);
    expect(merged.councilRules).toBe('Be brief.');
    expect(merged.library.sources).toEqual(live.library.sources);
    expect(merged.library.mode).toBe('browse');
    expect(merged.library.notionSaveParent).toEqual({ id: 'p', title: 'Council answers' });
    expect(draft.library.sources).toEqual([]);
  });
});

function provider(id: string, browse: ProviderInfo['browse']): ProviderInfo {
  return {
    id,
    label: id,
    cliName: id,
    vendor: '',
    kind: 'builtin',
    command: id,
    installed: true,
    version: null,
    auth: 'ok',
    authDetail: '',
    billing: 'subscription',
    warnings: [],
    effortLevels: [],
    webSearch: 'toggle',
    streams: true,
    browse,
    modelSuggestions: [],
    canListModels: false,
    installHint: '',
    loginHint: '',
    docsUrl: '',
  };
}

describe('browseSupport', () => {
  it('groups enabled members by what their provider can do', () => {
    const s = defaultSettings();
    s.members.push({ ...s.members[0]!, id: 'x', name: 'Local', provider: 'custom-x' });
    s.members.push({ ...s.members[0]!, id: 'y', name: 'Off', enabled: false });
    const support = browseSupport(s, [provider('claude', 'yes'), provider('codex', 'untested'), provider('antigravity', 'untested')]);
    expect(support).toEqual({ yes: ['Claude'], untested: ['ChatGPT', 'Gemini'], no: ['Local'] });
    expect(browseNote(support)).toBe('Can open files: Claude. Untested: ChatGPT, Gemini. Passages only: Local.');
    expect(browseNote({ yes: [], untested: [], no: ['A'] })).toBe('Passages only: A.');
  });
});

describe('attachments', () => {
  it('starts from the last turn, without duplicates, remembering cuts and problems', () => {
    const docs = attachmentsFromTurn([
      attachment('D1', 'doc1', { chars: 500, truncated: true }),
      attachment('D2', 'doc2', { problem: 'Not included: the attachment budget was already used by the documents before it.' }),
      attachment('D3', 'doc1'),
    ]);
    expect(docs.map((d) => d.id)).toEqual(['doc1', 'doc2']);
    expect(docs[0]).toMatchObject({ title: 'doc1.docx', chars: 500, atLeast: true, problem: '' });
    expect(docs[1]!.problem).toContain('Not included');
  });

  it('shares the budget in order, cutting the document that does not fit', () => {
    const plan = attachmentBudget(
      [
        { id: 'a', chars: 60 },
        { id: 'b', chars: 30 },
        { id: 'c', chars: 50 },
        { id: 'd', chars: 10 },
        { id: 'e', chars: 0 },
      ],
      100,
    );
    expect(plan.total).toBe(150);
    expect(plan.over).toBe(50);
    expect(plan.items).toEqual([
      { id: 'a', included: 60, cut: false, leftOut: false },
      { id: 'b', included: 30, cut: false, leftOut: false },
      { id: 'c', included: 10, cut: true, leftOut: false },
      { id: 'd', included: 0, cut: false, leftOut: true },
      { id: 'e', included: 0, cut: false, leftOut: false },
    ]);
  });

  it('reports no excess when everything fits, and tolerates bad budgets', () => {
    expect(attachmentBudget([{ id: 'a', chars: 10 }], 100).over).toBe(0);
    expect(attachmentBudget([{ id: 'a', chars: 10 }], Number.NaN)).toMatchObject({ budget: 0, over: 10 });
  });
});

describe('turn sources', () => {
  it('joins only non-empty pieces', () => {
    expect(whereText(['Drive', '', 'p. 4'])).toBe('Drive · p. 4');
    expect(whereText([null, ' ', undefined])).toBe('');
  });

  it('groups passages by document in first-appearance order', () => {
    const groups = groupExcerpts([excerpt('S1', 'a'), excerpt('S2', 'b'), excerpt('S3', 'a')]);
    expect(groups.map((g) => [g.documentId, g.excerpts.map((e) => e.id)])).toEqual([
      ['a', ['S1', 'S3']],
      ['b', ['S2']],
    ]);
  });

  it('summarises a running library phase', () => {
    expect(librarySummary(library({ status: 'pending' }))).toEqual({ text: 'Searching the library…', tone: 'running' });
    expect(librarySummary(library({ status: 'running', mode: 'off' })).text).toBe('Reading the attached documents…');
  });

  it('summarises what the models were given', () => {
    const passages = [excerpt('S1', 'a'), excerpt('S2', 'b'), excerpt('S3', 'a')];
    const queries = ['acme renewal'];
    expect(librarySummary(library({ excerpts: passages, queries }))).toEqual({ text: '3 passages from 2 documents', tone: 'done' });
    expect(librarySummary(library({ excerpts: [excerpt('S1', 'a')], queries })).text).toBe('1 passage from 1 document');
    expect(librarySummary(library({ mode: 'off', attachments: [attachment('D1', 'x'), attachment('D2', 'y')] })).text).toBe(
      '2 attached documents',
    );
    expect(librarySummary(library({ excerpts: passages, queries, attachments: [attachment('D1', 'x'), attachment('D2', 'y')] })).text).toBe(
      '3 passages · 2 attached documents',
    );
    expect(librarySummary(library({ queries }))).toEqual({ text: 'Nothing relevant found in the library', tone: 'quiet' });
    expect(librarySummary(library({ queries, attachments: [attachment('D1', 'x')] })).text).toBe(
      '1 attached document · nothing relevant found in the library',
    );
    expect(librarySummary(library({})).text).toBe('The library had no searchable documents');
  });

  it('adds the browse count and reports errors', () => {
    expect(librarySummary(library({ mode: 'browse', queries: ['x'], excerpts: [excerpt('S1', 'a')], browsableDocuments: 1204 })).text).toBe(
      '1 passage from 1 document · models could open 1,204 documents',
    );
    expect(librarySummary(library({ status: 'error', error: 'The index is not ready.' }))).toEqual({
      text: 'The index is not ready.',
      tone: 'warning',
    });
    expect(librarySummary(library({ status: 'error', error: null })).text).toBe('The library could not be searched.');
  });
});

describe('syncAnnouncements', () => {
  const status = (sync: Partial<SyncState>, ok = 10) => ({
    sources: [sourceStatus({ sync: { ...idle(), ...sync }, counts: { ok, empty: 0, unsupported: 0, stub: 0, 'too-large': 0, error: 0 } })],
    documents: ok,
    supportedTypes: [],
  });

  it('announces starts, reading and the end, not progress', () => {
    expect(syncAnnouncements(status({}), status({ running: true, phase: 'scanning' }))).toEqual(['Checking Drive for changes.']);
    expect(syncAnnouncements(status({ running: true, phase: 'scanning' }), status({ running: true, phase: 'reading', total: 640 }))).toEqual([
      'Reading 640 documents in Drive.',
    ]);
    expect(
      syncAnnouncements(status({ running: true, phase: 'reading', done: 1, total: 640 }), status({ running: true, phase: 'reading', done: 2, total: 640 })),
    ).toEqual([]);
    expect(syncAnnouncements(status({ running: true, phase: 'reading' }), status({}, 1204))).toEqual(['Finished checking Drive: 1,204 documents.']);
    expect(syncAnnouncements(status({ running: true, phase: 'reading' }), status({ error: 'Cancelled.' }))).toEqual(['Checking Drive stopped: Cancelled.']);
  });

  it('says nothing about sources it has not seen before', () => {
    expect(syncAnnouncements(null, status({ running: true, phase: 'reading', total: 5 }))).toEqual([]);
  });
});
