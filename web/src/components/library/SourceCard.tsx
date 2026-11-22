import { BookOpen, Folder, Info, RefreshCw, Trash } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import type { LibrarySource, LibrarySourceStatus } from '../../../../shared/types';
import { errorMessage } from '../../api';
import { isSyncActive, problemCounts, SOURCE_NAME_MAX, sourceStatusLine, syncProgress, validateSourceName, type ProblemCount } from '../../lib/library';
import { cancelSync, removeSource, syncSource, updateSource } from '../../librarySync';
import { ConfirmDialog } from '../Dialog';
import { Spinner, WarningIcon } from '../icons';
import { Switch } from '../settings/fields';
import { ProblemListDialog } from './ProblemListDialog';

interface SourceCardProps {
  source: LibrarySource;
  /** null until the library status has been read (or when the source is brand new). */
  status: LibrarySourceStatus | null;
  sources: LibrarySource[];
  supportedTypes: string[];
  now: number;
}

/** One library source: switch, name, status, sync progress, problem counts, removal. Every change saves at once. */
export function SourceCard({ source, status, sources, supportedTypes, now }: SourceCardProps) {
  const headingId = useId();
  const [busy, setBusy] = useState<null | 'enable' | 'sync' | 'cancel' | 'remove'>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemCount | null>(null);

  const run = async (kind: 'enable' | 'sync' | 'cancel', action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    setRemoveError(null);
    try {
      await removeSource(source.id);
      setConfirmRemove(false);
    } catch (err) {
      setRemoveError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const syncing = status ? isSyncActive(status.sync) : false;
  const line = status ? sourceStatusLine(status, now) : null;
  const problems = status ? problemCounts(status.counts, source.kind) : [];
  const allRead = status && status.ready && status.lastSyncedAt && !syncing && problems.length === 0 && (status.counts.ok ?? 0) > 0;
  const kindIcon = source.kind === 'folder' ? <Folder size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />;
  const displayName = source.name.trim() || (source.kind === 'folder' ? 'Folder' : 'Notion');

  return (
    <section className={`card source-card${source.enabled ? '' : ' disabled'}`} aria-labelledby={headingId}>
      <div className="card-header source-card-header">
        <span className="source-kind">{kindIcon}</span>
        <h4 className="visually-hidden" id={headingId}>
          {displayName}
        </h4>
        <SourceName source={source} sources={sources} />
        <div className="card-header-actions">
          {busy === 'enable' && <Spinner size={13} label="Saving" />}
          <Switch
            checked={source.enabled}
            onChange={(enabled) => void run('enable', () => updateSource(source.id, { enabled }))}
            label={`Use ${displayName}`}
            disabled={busy === 'enable'}
            compact
          />
          <button
            type="button"
            className="icon-button small"
            onClick={() => {
              setRemoveError(null);
              setConfirmRemove(true);
            }}
            aria-label={`Remove ${displayName}`}
            title="Remove from the library"
          >
            <Trash size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {source.kind === 'folder' && <p className="source-path mono">{source.path}</p>}

      <div className="source-status">
        {!source.enabled ? (
          <p className="muted small">Turned off: not searched, attached from or browsed.</p>
        ) : !status || !line ? (
          <p className="muted small">
            <Spinner size={12} /> Checking…
          </p>
        ) : (
          <p className={`small source-line-text${line.tone === 'warning' ? ' warning' : ''}`}>
            {line.tone === 'warning' && <WarningIcon size={13} />}
            <span>{line.text}</span>
          </p>
        )}

        {source.enabled && status && (
          <div className="sync-row">
            {syncing ? (
              <SyncProgressView status={status} onCancel={() => void run('cancel', () => cancelSync(source.id))} cancelling={busy === 'cancel'} />
            ) : (
              <button type="button" className="button small" onClick={() => void run('sync', () => syncSource(source.id))} disabled={busy === 'sync'}>
                {busy === 'sync' ? <Spinner size={13} /> : <RefreshCw size={13} aria-hidden="true" />}
                {busy === 'sync' ? 'Starting…' : 'Check now'}
              </button>
            )}
          </div>
        )}

        {source.enabled && status && (
          <div className="problem-row">
            {problems.map((p) => (
              <button key={p.status} type="button" className={`problem-link${p.tone === 'warning' ? ' warning' : ''}`} onClick={() => setProblem(p)}>
                {p.label}
              </button>
            ))}
            {allRead && <span className="muted small">Every {source.kind === 'notion' ? 'page' : 'file'} could be read.</span>}
          </div>
        )}

        {source.enabled && status?.sync.error && !syncing && (
          <p className="small source-line-text">
            <Info size={13} aria-hidden="true" />
            <span>{status.sync.error}</span>
          </p>
        )}

        {/* A refused check of an unreachable source repeats the reason already shown above. */}
        {error && error !== status?.readyDetail && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>

      {problem && (
        <ProblemListDialog source={source} problem={problem} supportedTypes={supportedTypes} onClose={() => setProblem(null)} />
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={`Remove “${displayName}” from the library?`}
          message={
            <p>
              {source.kind === 'folder'
                ? 'Its documents leave the library and are no longer searched or attached. The files in the folder are not touched.'
                : 'Its pages leave the library and are no longer searched or attached. Nothing in Notion is changed, and the connection stays.'}
            </p>
          }
          confirmLabel="Remove"
          danger
          pending={busy === 'remove'}
          error={removeError}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </section>
  );
}

function SyncProgressView({ status, onCancel, cancelling }: { status: LibrarySourceStatus; onCancel: () => void; cancelling: boolean }) {
  const progress = syncProgress(status.sync);
  const percent = progress.fraction === null ? null : Math.round(progress.fraction * 100);
  return (
    <div className="sync-progress">
      <div className="sync-progress-text small">
        <span className="sync-count">{progress.text}</span>
        {progress.current && (
          <span className="sync-current" title={progress.current}>
            · {progress.current}
          </span>
        )}
      </div>
      <div
        className={`progress${percent === null ? ' indeterminate' : ''}`}
        role="progressbar"
        aria-label={`Checking ${status.source.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={progress.text}
      >
        <span style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      <button type="button" className="button small" onClick={onCancel} disabled={cancelling}>
        {cancelling && <Spinner size={13} />}
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
    </div>
  );
}

/** The source name, edited in place: saved on Enter or when the field loses focus; Escape restores it. */
function SourceName({ source, sources }: { source: LibrarySource; sources: LibrarySource[] }) {
  const id = useId();
  const [text, setText] = useState(source.name);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Follow changes saved elsewhere while the field is not being edited.
  const [lastSaved, setLastSaved] = useState(source.name);
  if (source.name !== lastSaved) {
    setLastSaved(source.name);
    if (!editing && !saving) setText(source.name);
  }

  const commit = async () => {
    setEditing(false);
    const next = text.trim();
    if (next === source.name) {
      setText(source.name);
      setError(null);
      return;
    }
    const invalid = validateSourceName(next, sources, source.id);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateSource(source.id, { name: next });
      setText(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape' && text !== source.name) {
      // Revert instead of closing the dialog.
      e.preventDefault();
      e.stopPropagation();
      setText(source.name);
      setError(null);
    }
  };

  return (
    <div className="source-name">
      <label htmlFor={id} className="visually-hidden">
        Source name
      </label>
      <input
        id={id}
        className="input source-name-input"
        value={text}
        maxLength={SOURCE_NAME_MAX + 10}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
        disabled={saving}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        spellCheck={false}
      />
      {saving && <Spinner size={13} label="Saving the name" />}
      {error && (
        <p className="field-error source-name-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
