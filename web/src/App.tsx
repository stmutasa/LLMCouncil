import { RefreshCw } from 'lucide-react';
import { useEffect, useId } from 'react';
import { APP_NAME } from '../../shared/defaults';
import { boot, loadConversation, navigate, setMobileSidebarOpen } from './actions';
import { Composer } from './components/Composer';
import { Dialog } from './components/Dialog';
import { EmptyState } from './components/EmptyState';
import { Spinner, Wordmark } from './components/icons';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { Thread } from './components/Thread';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { NARROW_QUERY, useMediaQuery } from './hooks/useMediaQuery';
import { useStore } from './store';

export function App() {
  const status = useStore((s) => s.boot.status);
  const error = useStore((s) => s.boot.error);

  if (status === 'loading') {
    return (
      <div className="full-page" role="status">
        <Wordmark />
        <p className="full-page-text">
          <Spinner size={15} /> Connecting to the server…
        </p>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="full-page">
        <Wordmark />
        <h1 className="full-page-heading">LLM Council could not start</h1>
        <p className="full-page-text" role="alert">
          {error}
        </p>
        <button type="button" className="button primary" onClick={() => void boot()}>
          <RefreshCw size={15} aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }
  return <Shell />;
}

function Shell() {
  const narrow = useMediaQuery(NARROW_QUERY);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const mobileOpen = useStore((s) => s.mobileSidebarOpen);
  const settingsOpen = useStore((s) => s.settingsDialog.open);
  const title = useStore((s) => (s.open?.status === 'ready' ? s.open.conversation?.title ?? '' : ''));
  const drawerTitleId = useId();

  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);

  useEffect(() => {
    if (!narrow && mobileOpen) setMobileSidebarOpen(false);
  }, [narrow, mobileOpen]);

  const showDesktopSidebar = !narrow && !collapsed;

  return (
    <>
      <div className={`app${showDesktopSidebar ? ' with-sidebar' : ''}`}>
        {showDesktopSidebar && <Sidebar narrow={false} />}
        <main className="main">
          <TopBar narrow={narrow} />
          <MainView />
        </main>
      </div>
      {narrow && mobileOpen && (
        <Dialog onRequestClose={() => setMobileSidebarOpen(false)} labelledBy={drawerTitleId} className="drawer">
          <h2 id={drawerTitleId} className="visually-hidden">
            Conversations
          </h2>
          <Sidebar narrow />
        </Dialog>
      )}
      {settingsOpen && <SettingsDialog />}
      <Toasts />
    </>
  );
}

function MainView() {
  const route = useStore((s) => s.route);
  const open = useStore((s) => s.open);
  const pendingSend = useStore((s) => s.pendingSend);

  if (route.kind === 'home') {
    if (pendingSend?.key === '') {
      return (
        <>
          <Thread threadKey="" conversation={null} pendingMessage={pendingSend.message} />
          <Composer convKey="" runningTurn={null} ready />
        </>
      );
    }
    return <EmptyState />;
  }

  const id = route.id;
  if (!open || open.id !== id || open.status === 'loading') {
    return (
      <>
        <Thread threadKey={id} conversation={null} pendingMessage={null}>
          <p className="thread-state" role="status">
            <Spinner size={15} /> Loading the conversation…
          </p>
        </Thread>
        <Composer convKey={id} runningTurn={null} ready={false} />
      </>
    );
  }

  if (open.status === 'notfound') {
    return (
      <div className="center-state">
        <h2 className="center-heading">Conversation not found</h2>
        <p className="muted">It may have been deleted, or the link is wrong.</p>
        <a
          className="button"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate({ kind: 'home' });
          }}
        >
          Start a new chat
        </a>
      </div>
    );
  }

  if (open.status === 'error' || !open.conversation) {
    return (
      <div className="center-state">
        <h2 className="center-heading">Could not load this conversation</h2>
        <p className="muted" role="alert">
          {open.error}
        </p>
        <button type="button" className="button" onClick={() => void loadConversation(id)}>
          <RefreshCw size={15} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  const conversation = open.conversation;
  const runningTurn = conversation.turns.find((t) => t.status === 'running') ?? null;
  return (
    <>
      <Thread threadKey={id} conversation={conversation} pendingMessage={pendingSend?.key === id ? pendingSend.message : null} />
      <Composer convKey={id} runningTurn={runningTurn} ready autoFocus />
    </>
  );
}
