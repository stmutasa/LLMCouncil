import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentStatus, LibraryDocument } from '../../../shared/types';
import { api, errorMessage } from '../api';

/** `value`, updated only after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

interface DocumentQueryOptions {
  sourceId?: string;
  status?: DocumentStatus[];
  /** Typed search text; debounced here. */
  q?: string;
  pageSize?: number;
}

export interface DocumentQueryState {
  documents: LibraryDocument[];
  total: number;
  /** True until the first page of the current query has arrived. */
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** True while typed text has not been searched for yet. */
  searching: boolean;
  loadMore: () => void;
  retry: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * One page at a time from GET /api/library/documents, with "load more". A new query (search
 * text, source or status) starts over; answers to superseded queries are ignored.
 */
export function useDocumentQuery({ sourceId, status, q = '', pageSize = 50 }: DocumentQueryOptions): DocumentQueryState {
  const debouncedQ = useDebounced(q.trim(), SEARCH_DEBOUNCE_MS);
  const statusKey = (status ?? []).join(',');
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    const statuses = statusKey ? (statusKey.split(',') as DocumentStatus[]) : undefined;
    api
      .documents({ sourceId, status: statuses, q: debouncedQ, offset: 0, limit: pageSize })
      .then((res) => {
        if (mine !== seq.current) return;
        setDocuments(res.documents);
        setTotal(res.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setDocuments([]);
        setTotal(0);
        setError(errorMessage(err));
        setLoading(false);
      });
  }, [sourceId, statusKey, debouncedQ, pageSize, attempt]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || documents.length >= total) return;
    const mine = seq.current;
    setLoadingMore(true);
    setError(null);
    const statuses = statusKey ? (statusKey.split(',') as DocumentStatus[]) : undefined;
    api
      .documents({ sourceId, status: statuses, q: debouncedQ, offset: documents.length, limit: pageSize })
      .then((res) => {
        if (mine !== seq.current) return;
        // The list can change between pages (a sync is running); never show a document twice.
        setDocuments((current) => {
          const seen = new Set(current.map((d) => d.id));
          return [...current, ...res.documents.filter((d) => !seen.has(d.id))];
        });
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (mine === seq.current) setError(errorMessage(err));
      })
      .finally(() => {
        if (mine === seq.current) setLoadingMore(false);
      });
  }, [loading, loadingMore, documents.length, total, sourceId, statusKey, debouncedQ, pageSize]);

  const retry = useCallback(() => {
    if (documents.length > 0) loadMore();
    else setAttempt((a) => a + 1);
  }, [documents.length, loadMore]);

  return { documents, total, loading, loadingMore, error, searching: q.trim() !== debouncedQ, loadMore, retry };
}
