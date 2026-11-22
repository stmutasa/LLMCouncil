import { Check, ExternalLink, Search, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { NotionPageRef, Settings } from '../../../../shared/types';
import { api, errorMessage } from '../../api';
import { useDebounced } from '../../hooks/useDocumentQuery';
import { addNotionSource, connectNotion, disconnectNotion, loadNotionStatus, setNotionSaveParent } from '../../librarySync';
import { useStore } from '../../store';
import { ConfirmDialog, Dialog } from '../Dialog';
import { Spinner, WarningIcon } from '../icons';

/** Where Notion's two kinds of token are created. */
const NOTION_TOKENS = 'https://www.notion.so/developers/tokens';
const NOTION_CONNECTIONS = 'https://app.notion.com/developers/connections';

/** Connect or disconnect Notion, and choose where answers are saved. The token is never shown. */
export function NotionSection({ live }: { live: Settings }) {
  const headingId = useId();
  const notion = useStore((s) => s.notion);
  const status = notion.status;
  const hasSource = live.library.sources.some((s) => s.kind === 'notion');

  return (
    <section className="library-section" aria-labelledby={headingId}>
      <div className="section-title-row">
        <h4 className="subsection-title" id={headingId}>
          Notion
        </h4>
      </div>
      {!status && notion.loading ? (
        <p className="muted small" role="status">
          <Spinner size={13} /> Checking the Notion connection…
        </p>
      ) : !status && notion.error ? (
        <div className="card notion-card">
          <p className="small source-line-text warning">
            <WarningIcon size={13} />
            <span>Could not check the Notion connection: {notion.error}</span>
          </p>
          <div>
            <button type="button" className="button small" onClick={() => void loadNotionStatus()}>
              Try again
            </button>
          </div>
        </div>
      ) : status?.connected ? (
        <Connected live={live} hasSource={hasSource} />
      ) : (
        <NotConnected tokenError={status?.error ?? null} />
      )}
    </section>
  );
}

function Connected({ live, hasSource }: { live: Settings; hasSource: boolean }) {
  const notion = useStore((s) => s.notion);
  const status = notion.status!;
  const [confirm, setConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const parent = live.library.notionSaveParent;

  const disconnect = async () => {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await disconnectNotion();
      setConfirm(false);
    } catch (err) {
      setDisconnectError(errorMessage(err));
    } finally {
      setDisconnecting(false);
    }
  };

  const addSource = async () => {
    setAdding(true);
    setAddError(null);
    try {
      await addNotionSource();
    } catch (err) {
      setAddError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="card notion-card">
      <div className="notion-connected">
        <Check size={16} aria-hidden="true" className="status-done" />
        <p>
          Connected{status.workspace ? ` to ${status.workspace}` : ''}
          {status.identity && <span className="muted"> as {status.identity}</span>}
        </p>
        <div className="card-header-actions">
          <button type="button" className="button small" onClick={() => void loadNotionStatus()} disabled={notion.loading}>
            {notion.loading && <Spinner size={13} />}
            {notion.loading ? 'Checking…' : 'Check connection'}
          </button>
          <button type="button" className="button small danger-outline" onClick={() => setConfirm(true)}>
            Disconnect
          </button>
        </div>
      </div>
      {notion.error && (
        <p className="field-error" role="alert">
          Could not check the connection: {notion.error}
        </p>
      )}

      {!hasSource && (
        <div className="notion-row">
          <p className="small muted">Your Notion pages are not in the library.</p>
          <button type="button" className="button small" onClick={() => void addSource()} disabled={adding}>
            {adding && <Spinner size={13} />}
            {adding ? 'Adding…' : 'Add Notion to the library'}
          </button>
          {addError && (
            <p className="field-error" role="alert">
              {addError}
            </p>
          )}
        </div>
      )}

      <div className="notion-row">
        <span className="field-label">Save answers under</span>
        <div className="notion-parent">
          {parent ? <span className="notion-parent-title">{parent.title || 'Untitled'}</span> : <span className="muted">Not chosen yet</span>}
          <button type="button" className="button small" onClick={() => setPicking(true)} aria-haspopup="dialog">
            {parent ? 'Change…' : 'Choose a page…'}
          </button>
        </div>
        <p className="field-hint">“Save to Notion” under an answer creates a new page inside this one.</p>
      </div>

      {picking && <NotionPagePicker current={parent?.id ?? null} onClose={() => setPicking(false)} />}
      {confirm && (
        <ConfirmDialog
          title="Disconnect Notion?"
          message={
            <p>
              The token is removed from this computer. Pages already in the library stay until you remove the Notion source, but
              they are no longer updated, and answers cannot be saved to Notion.
            </p>
          }
          confirmLabel="Disconnect"
          danger
          pending={disconnecting}
          error={disconnectError}
          onConfirm={() => void disconnect()}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  );
}

function NotConnected({ tokenError }: { tokenError: string | null }) {
  const tokenId = useId();
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    if (!token.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      await connectNotion(token);
      setToken('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="card notion-card">
      {tokenError && (
        <p className="small source-line-text warning">
          <WarningIcon size={13} />
          <span>The stored token no longer works: {tokenError}</span>
        </p>
      )}
      <p className="section-text small">Add your Notion pages to the library, and save council answers to Notion.</p>
      <p className="section-text small">Paste either kind of Notion token:</p>
      <ul className="notion-options">
        <li>
          <span className="notion-option-title">Personal access token</span>{' '}
          <a className="text-link" href={NOTION_TOKENS} target="_blank" rel="noopener noreferrer">
            Create one <ExternalLink size={12} aria-hidden="true" />
          </a>
          <span className="notion-option-text">
            The simplest: it sees every page you can see, with no sharing needed. It expires (after at most a year), and then a new one
            must be pasted here.
          </span>
        </li>
        <li>
          <span className="notion-option-title">Connection with an API token</span>{' '}
          <a className="text-link" href={NOTION_CONNECTIONS} target="_blank" rel="noopener noreferrer">
            Create one <ExternalLink size={12} aria-hidden="true" />
          </a>
          <span className="notion-option-text">
            Sees only the pages and databases you give it access to (its Content access tab, or a page's ••• menu, then Connections).
            Give it the read content capability, and insert content if answers should be saved to Notion.
          </span>
        </li>
      </ul>
      <form
        className="token-row"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <label htmlFor={tokenId} className="visually-hidden">
          Notion token
        </label>
        <input
          id={tokenId}
          type="password"
          className="input mono"
          value={token}
          placeholder="Notion token"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${tokenId}-error` : `${tokenId}-hint`}
          onChange={(e) => {
            setToken(e.target.value);
            setError(null);
          }}
          disabled={pending}
        />
        <button type="submit" className="button primary small" disabled={!token.trim() || pending}>
          {pending && <Spinner size={13} />}
          {pending ? 'Connecting…' : 'Connect'}
        </button>
      </form>
      {error ? (
        <p className="field-error" id={`${tokenId}-error`} role="alert">
          {error}
        </p>
      ) : (
        <p className="field-hint" id={`${tokenId}-hint`}>
          The token is checked with Notion, then kept only on this computer. It is never shown again.
        </p>
      )}
    </div>
  );
}

function NotionPagePicker({ current, onClose }: { current: string | null; onClose: () => void }) {
  const titleId = useId();
  const searchId = useId();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 300);
  const [pages, setPages] = useState<NotionPageRef[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .notionPages(debounced)
      .then((res) => {
        if (!cancelled) setPages(res.pages);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, attempt]);

  const choose = async (page: NotionPageRef) => {
    setSaving(page.id);
    setSaveError(null);
    try {
      await setNotionSaveParent(page);
      onClose();
    } catch (err) {
      setSaveError(errorMessage(err));
      setSaving(null);
    }
  };

  const busy = loading || q.trim() !== debounced;
  return (
    <Dialog onRequestClose={saving ? () => undefined : onClose} labelledBy={titleId} className="library-dialog picker-dialog">
      <header className="library-dialog-header">
        <h2 id={titleId} className="dialog-title">
          Save answers under
        </h2>
        <button type="button" className="icon-button" onClick={onClose} disabled={saving !== null} aria-label="Close" title="Close">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="library-dialog-body">
        <p className="muted small">Notion pages the token can see, at most 20 at a time; search to find others. New answers are saved as pages inside the one you choose.</p>
        <div className="search-field">
          <Search size={15} aria-hidden="true" className="search-field-icon" />
          <label htmlFor={searchId} className="visually-hidden">
            Search Notion pages
          </label>
          <input
            id={searchId}
            type="search"
            className="input"
            placeholder="Search Notion pages"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            data-autofocus
          />
        </div>
        <div className="doc-list-wrap">
          <div className="doc-list-scroll" aria-busy={busy || undefined}>
            {error ? (
              <div className="doc-list-state" role="alert">
                <p className="field-error">Notion could not be searched: {error}</p>
                <button type="button" className="button small" onClick={() => setAttempt((a) => a + 1)}>
                  Try again
                </button>
              </div>
            ) : !pages ? (
              <p className="doc-list-state" role="status">
                <Spinner size={14} /> Searching Notion…
              </p>
            ) : pages.length === 0 ? (
              <p className="doc-list-state muted">{busy ? 'Searching…' : 'No page matches. Pages appear here once they are shared with the connection.'}</p>
            ) : (
              <ul className={`doc-list${busy ? ' stale' : ''}`} aria-label="Notion pages">
                {pages.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`page-choice${p.id === current ? ' current' : ''}`}
                      onClick={() => void choose(p)}
                      disabled={saving !== null}
                      aria-current={p.id === current ? 'true' : undefined}
                    >
                      <span className="page-choice-title">{p.title || 'Untitled'}</span>
                      {saving === p.id ? <Spinner size={13} label="Saving" /> : p.id === current ? <Check size={15} aria-label="Current" role="img" /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {saveError && (
          <p className="field-error" role="alert">
            {saveError}
          </p>
        )}
      </div>
    </Dialog>
  );
}
