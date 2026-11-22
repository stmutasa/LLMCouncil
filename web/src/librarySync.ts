import type { FolderSource, LibrarySource, NotionPageRef, NotionSource, Settings } from '../../shared/types';
import { reloadLibrarySettings, saveLibraryChange } from './actions';
import { api, errorMessage } from './api';
import { newId } from './lib/ids';
import { anySyncActive } from './lib/library';
import { getState, setState, useStore, type AppState } from './store';

/**
 * Library status and the library's immediate actions.
 *
 * GET /api/library is read once at start, whenever the settings dialog opens and after any
 * library change, and polled every 1.5 s only while a source is syncing. There is a single
 * timer, owned by this module rather than by components, so React StrictMode's double effects
 * cannot start a second one. Polling pauses while the tab is hidden. A failed check keeps the
 * last known status on screen, reports the error quietly and is retried with backoff.
 */

const POLL_MS = 1500;
/** After an action that starts a sync, keep checking briefly until the sync shows up. */
const EXPECT_SYNC_MS = 8000;

let timer: number | null = null;
let inFlight: Promise<void> | null = null;
let again = false;
let failures = 0;
let expectUntil = 0;

function wanted(state: AppState): boolean {
  if (state.boot.status !== 'ready') return false;
  if (anySyncActive(state.library.status)) return true;
  if (Date.now() < expectUntil) return true;
  // A failed check is retried while the library is on screen; elsewhere the next open retries.
  return state.library.error !== null && state.settingsDialog.open;
}

function clearTimer(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}

function schedule(): void {
  if (timer !== null || inFlight || document.hidden) return;
  if (!wanted(getState())) return;
  const delay = failures > 0 ? Math.min(30_000, POLL_MS * 2 ** failures) : POLL_MS;
  timer = window.setTimeout(() => {
    timer = null;
    void refreshLibrary();
  }, delay);
}

/** Reads the library status now. Concurrent calls collapse into one follow-up request. */
export function refreshLibrary(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  clearTimer();
  inFlight = (async () => {
    try {
      const status = await api.library();
      failures = 0;
      setState({ library: { status, error: null } });
    } catch (err) {
      failures += 1;
      setState((s) => ({ library: { status: s.library.status, error: errorMessage(err) } }));
    } finally {
      inFlight = null;
      if (again) {
        again = false;
        void refreshLibrary();
      } else {
        schedule();
      }
    }
  })();
  return inFlight;
}

/** The server starts a sync asynchronously after some actions; poll until it is visible. */
export function expectSync(): void {
  expectUntil = Date.now() + EXPECT_SYNC_MS;
  void refreshLibrary();
}

let started = false;

/** Starts the status checks. Safe to call more than once; returns a function that stops them. */
export function startLibrarySync(): () => void {
  if (started) return () => undefined;
  started = true;
  let wasReady = false;
  let wasOpen = false;
  const unsubscribe = useStore.subscribe((s) => {
    const ready = s.boot.status === 'ready';
    const opened = s.settingsDialog.open && !wasOpen;
    const becameReady = ready && !wasReady;
    // Record the new state before acting: the actions below update the store synchronously,
    // which re-enters this listener.
    wasReady = ready;
    wasOpen = s.settingsDialog.open;
    if (becameReady) {
      void refreshLibrary();
      if (s.settings?.library.sources.some((src) => src.kind === 'notion')) void loadNotionStatus();
    }
    if (opened && ready) {
      void refreshLibrary();
      void loadNotionStatus();
    }
  });
  const onVisibility = () => {
    if (document.hidden) clearTimer();
    else if (wanted(getState())) void refreshLibrary();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    started = false;
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
    clearTimer();
  };
}

// ---------------------------------------------------------------------------------------------
// Sources (saved immediately; each rejects with the server's message)
// ---------------------------------------------------------------------------------------------

function mapSources(settings: Settings, fn: (sources: LibrarySource[]) => LibrarySource[]): Settings {
  return { ...settings, library: { ...settings.library, sources: fn(settings.library.sources) } };
}

export async function addFolderSource(path: string, name: string): Promise<FolderSource> {
  const source: FolderSource = { id: newId('src'), kind: 'folder', name: name.trim(), enabled: true, path: path.trim() };
  await saveLibraryChange((s) => mapSources(s, (list) => [...list, source]));
  expectSync();
  return source;
}

/** Puts the Notion workspace back into the library after its source was removed. */
export async function addNotionSource(): Promise<void> {
  const source: NotionSource = { id: newId('src'), kind: 'notion', name: 'Notion', enabled: true };
  await saveLibraryChange((s) =>
    s.library.sources.some((x) => x.kind === 'notion') ? s : mapSources(s, (list) => [...list, source]),
  );
  expectSync();
}

export async function updateSource(id: string, patch: { name?: string; enabled?: boolean }): Promise<void> {
  await saveLibraryChange((s) =>
    mapSources(s, (list) => list.map((src) => (src.id === id ? ({ ...src, ...patch } as LibrarySource) : src))),
  );
  if (patch.enabled) expectSync();
  else void refreshLibrary();
}

export async function removeSource(id: string): Promise<void> {
  await saveLibraryChange((s) => mapSources(s, (list) => list.filter((src) => src.id !== id)));
  void refreshLibrary();
}

export async function syncSource(id: string): Promise<void> {
  await api.syncSource(id);
  expectSync();
}

export async function cancelSync(id: string): Promise<void> {
  await api.cancelSync(id);
  void refreshLibrary();
}

export async function setNotionSaveParent(page: NotionPageRef | null): Promise<void> {
  await saveLibraryChange((s) => ({
    ...s,
    library: { ...s.library, notionSaveParent: page ? { id: page.id, title: page.title } : null },
  }));
}

// ---------------------------------------------------------------------------------------------
// Notion connection
// ---------------------------------------------------------------------------------------------

let notionSeq = 0;

export async function loadNotionStatus(): Promise<void> {
  const seq = ++notionSeq;
  setState((s) => ({ notion: { ...s.notion, loading: true, error: null } }));
  try {
    const status = await api.notionStatus();
    if (seq === notionSeq) setState({ notion: { status, loading: false, error: null } });
  } catch (err) {
    if (seq === notionSeq) setState((s) => ({ notion: { status: s.notion.status, loading: false, error: errorMessage(err) } }));
  }
}

/** Checks the token with Notion and stores it; rejects with Notion's message when it is refused. */
export async function connectNotion(token: string): Promise<void> {
  const status = await api.connectNotion(token.trim());
  notionSeq += 1;
  setState({ notion: { status, loading: false, error: null } });
  // The server adds a Notion source when there is none and starts reading it.
  await reloadLibrarySettings();
  expectSync();
}

export async function disconnectNotion(): Promise<void> {
  await api.disconnectNotion();
  notionSeq += 1;
  setState({ notion: { status: { connected: false, workspace: '', identity: '', error: null }, loading: false, error: null } });
  void refreshLibrary();
}
