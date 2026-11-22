import type { ReactNode } from 'react';
import type { LibraryDocument } from '../../../../shared/types';
import type { DocumentQueryState } from '../../hooks/useDocumentQuery';
import { count, formatNumber } from '../../lib/format';
import { Spinner } from '../icons';

interface DocumentListViewProps {
  query: DocumentQueryState;
  label: string;
  emptyText: string;
  renderItem: (doc: LibraryDocument) => ReactNode;
}

/**
 * A scrolling list of documents with the states every such list needs: first load, error with
 * retry, nothing found, and "load more". While a new search runs the previous results stay in
 * place, dimmed, so the list does not jump.
 */
export function DocumentListView({ query, label, emptyText, renderItem }: DocumentListViewProps) {
  const { documents, total, loading, loadingMore, error, searching } = query;
  const busy = loading || searching;
  return (
    <div className="doc-list-wrap">
      <div className="doc-list-scroll" aria-busy={busy || undefined}>
        {loading && documents.length === 0 && !error ? (
          <p className="doc-list-state" role="status">
            <Spinner size={14} /> Loading documents…
          </p>
        ) : error && documents.length === 0 ? (
          <div className="doc-list-state" role="alert">
            <p className="field-error">Could not load the documents: {error}</p>
            <button type="button" className="button small" onClick={query.retry}>
              Try again
            </button>
          </div>
        ) : documents.length === 0 ? (
          <p className="doc-list-state muted">{busy ? 'Searching…' : emptyText}</p>
        ) : (
          <ul className={`doc-list${busy ? ' stale' : ''}`} aria-label={label}>
            {documents.map(renderItem)}
          </ul>
        )}
      </div>
      {documents.length > 0 && (
        <div className="doc-list-footer">
          <span className="muted small" role="status">
            {busy ? 'Searching…' : documents.length < total ? `Showing ${formatNumber(documents.length)} of ${formatNumber(total)}` : count(total, 'document')}
          </span>
          {error && (
            <span className="field-error" role="alert">
              {error}
            </span>
          )}
          {documents.length < total && !busy && (
            <button type="button" className="button small" onClick={error ? query.retry : query.loadMore} disabled={loadingMore}>
              {loadingMore && <Spinner size={13} />}
              {loadingMore ? 'Loading…' : error ? 'Try again' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
