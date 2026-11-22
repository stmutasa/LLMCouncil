import { FileText, Search, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { DocumentStatus, LibraryDocument, LibraryDocumentText, LibrarySource } from '../../../../shared/types';
import { api, errorMessage } from '../../api';
import { useDocumentQuery } from '../../hooks/useDocumentQuery';
import { count } from '../../lib/format';
import { formatChars, whereText } from '../../lib/library';
import { Dialog } from '../Dialog';
import { Spinner } from '../icons';
import { DocumentLink } from '../SourcesBlock';
import { DocumentListView } from './DocumentListView';

const STATUS_LABEL: Record<DocumentStatus, string> = {
  ok: 'Read',
  empty: 'No text',
  unsupported: 'Not read: file type',
  stub: 'Google Docs link',
  'too-large': 'Too large',
  error: 'Could not be read',
};

const PROBLEM_STATUSES: DocumentStatus[] = ['error', 'stub', 'empty', 'unsupported', 'too-large'];

type StatusFilter = 'all' | 'ok' | 'problems';

/** Every document in the library, so the user can check what was extracted from each. */
export function DocumentBrowser({ sources, onClose }: { sources: LibrarySource[]; onClose: () => void }) {
  const titleId = useId();
  const searchId = useId();
  const sourceId = useId();
  const statusId = useId();
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [viewing, setViewing] = useState<LibraryDocument | null>(null);
  const status = filter === 'ok' ? (['ok'] as DocumentStatus[]) : filter === 'problems' ? PROBLEM_STATUSES : undefined;
  const query = useDocumentQuery({ sourceId: source || undefined, status, q });
  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? '';

  return (
    <Dialog onRequestClose={onClose} labelledBy={titleId} className="library-dialog browser-dialog">
      <header className="library-dialog-header">
        <h2 id={titleId} className="dialog-title">
          Documents in the library
        </h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close" title="Close">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="library-dialog-body">
        <div className="browser-filters">
          <div className="search-field">
            <Search size={15} aria-hidden="true" className="search-field-icon" />
            <label htmlFor={searchId} className="visually-hidden">
              Search by title or folder
            </label>
            <input
              id={searchId}
              type="search"
              className="input"
              placeholder="Search by title or folder"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              data-autofocus
            />
          </div>
          <label htmlFor={sourceId} className="visually-hidden">
            Source
          </label>
          <select id={sourceId} className="input select" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <label htmlFor={statusId} className="visually-hidden">
            Status
          </label>
          <select id={statusId} className="input select" value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)}>
            <option value="all">Any status</option>
            <option value="ok">Read</option>
            <option value="problems">Not read</option>
          </select>
        </div>
        <DocumentListView
          query={query}
          label="Documents"
          emptyText={q.trim() || source || filter !== 'all' ? 'No document matches.' : 'The library has no documents yet.'}
          renderItem={(doc) => (
            <li key={doc.id} className="doc-row">
              <div className="doc-row-main">
                <span className="doc-row-title">{doc.title}</span>
                <span className="doc-row-where">{whereText([sourceName(doc.sourceId), doc.location])}</span>
                <span className="doc-row-meta">
                  {doc.status === 'ok' ? (
                    <>
                      {whereText([formatChars(doc.chars), doc.parts > 0 ? count(doc.parts, partNoun(doc.type)) : ''])}
                      {/* A readable document can carry a note, e.g. an older version is still used. */}
                      {doc.detail && <span className="doc-note">{doc.detail}</span>}
                    </>
                  ) : (
                    <>
                      <span className={`badge${doc.status === 'error' ? ' warning' : ''}`}>{STATUS_LABEL[doc.status]}</span>
                      {doc.detail && <span className="doc-row-detail"> {doc.detail}</span>}
                    </>
                  )}
                </span>
              </div>
              <div className="doc-row-actions">
                {doc.status === 'ok' && (
                  <button type="button" className="source-action" onClick={() => setViewing(doc)} aria-haspopup="dialog">
                    <FileText size={13} aria-hidden="true" />
                    <span>View text</span>
                  </button>
                )}
                <DocumentLink documentId={doc.id} url={doc.url} />
              </div>
            </li>
          )}
        />
      </div>
      {viewing && <DocumentTextDialog document={viewing} sourceName={sourceName(viewing.sourceId)} onClose={() => setViewing(null)} />}
    </Dialog>
  );
}

function partNoun(type: string): string {
  if (type === 'pdf') return 'page';
  if (type === 'pptx') return 'slide';
  if (type === 'xlsx' || type === 'xlsm' || type === 'xls') return 'sheet';
  return 'part';
}

/** The text the library extracted from one document, exactly as the models would see it. */
function DocumentTextDialog({ document: doc, sourceName, onClose }: { document: LibraryDocument; sourceName: string; onClose: () => void }) {
  const titleId = useId();
  const [data, setData] = useState<LibraryDocumentText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .documentText(doc.id)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [doc.id, attempt]);

  return (
    <Dialog onRequestClose={onClose} labelledBy={titleId} className="library-dialog text-dialog">
      <header className="library-dialog-header">
        <div className="text-dialog-heading">
          <h2 id={titleId} className="dialog-title">
            {doc.title}
          </h2>
          <p className="muted small">{whereText([sourceName, doc.location, formatChars(data?.document.chars ?? doc.chars)])}</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close" title="Close" data-autofocus>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="library-dialog-body text-dialog-body">
        {error ? (
          <div className="doc-list-state" role="alert">
            <p className="field-error">Could not load the text: {error}</p>
            <button type="button" className="button small" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
          </div>
        ) : !data ? (
          <p className="doc-list-state" role="status">
            <Spinner size={14} /> Loading the text…
          </p>
        ) : (
          <>
            {(data.document.detail || doc.detail) && <p className="doc-note">{data.document.detail || doc.detail}</p>}
            {data.truncated && (
              <p className="field-hint">Only the beginning is shown here; the library holds the whole text.</p>
            )}
            <pre className="doc-text" tabIndex={0} aria-label={`Extracted text of ${doc.title}`}>
              {data.text || '(no text)'}
            </pre>
          </>
        )}
      </div>
    </Dialog>
  );
}
