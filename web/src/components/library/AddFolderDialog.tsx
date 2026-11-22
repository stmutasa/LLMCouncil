import { ChevronRight, CornerLeftUp, Folder, HardDrive, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DirectoryListing, LibrarySource } from '../../../../shared/types';
import { api, errorMessage } from '../../api';
import { breadcrumbs, folderName, pathKey, SOURCE_NAME_MAX, splitShortcuts, uniqueSourceName, validateFolderPath, validateSourceName } from '../../lib/library';
import { addFolderSource } from '../../librarySync';
import { Dialog } from '../Dialog';
import { Spinner, WarningIcon } from '../icons';

interface AddFolderDialogProps {
  sources: LibrarySource[];
  onClose: () => void;
}

/**
 * Picks a folder without a native file dialog (a browser cannot hand the server a path). The
 * path field, the shortcuts and the folder browser are one control: the field always holds the
 * folder being shown, and typing or pasting a path and pressing Enter shows that folder. The
 * folder in the field is the one that is added.
 */
export function AddFolderDialog({ sources, onClose }: AddFolderDialogProps) {
  const titleId = useId();
  const pathId = useId();
  const nameId = useId();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [shortcuts, setShortcuts] = useState<DirectoryListing['shortcuts']>([]);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const seq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const nameEditedRef = useRef(nameEdited);
  nameEditedRef.current = nameEdited;

  const choose = useCallback(
    (next: string) => {
      setPath(next);
      setAddError(null);
      if (!nameEditedRef.current) setName(next.trim() ? uniqueSourceName(folderName(next), sources) : '');
    },
    [sources],
  );

  const go = useCallback(
    async (target: string | null, opts: { fromField?: boolean } = {}) => {
      const mine = ++seq.current;
      setLoading(true);
      setRequestError(null);
      try {
        const result = await api.directories(target ?? undefined);
        if (mine !== seq.current) return;
        setListing(result);
        if (result.shortcuts.length > 0) setShortcuts(result.shortcuts);
        // A folder that cannot be listed keeps what was typed (it may be an unplugged drive).
        if (!result.error || !opts.fromField) choose(result.error && target ? target : result.path);
        listRef.current?.scrollTo({ top: 0 });
      } catch (err) {
        if (mine !== seq.current) return;
        setRequestError(errorMessage(err));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [choose],
  );

  useEffect(() => {
    void go(null);
  }, [go]);

  const { drive, other } = splitShortcuts(shortcuts);
  const crumbs = listing ? breadcrumbs(listing.path) : [];
  const pathError = validateFolderPath(path, sources);
  const nameError = validateSourceName(name, sources, null);
  const showPathError = touched && pathError;
  const showNameError = touched && nameError;
  const shownPath = listing ? pathKey(listing.path) === pathKey(path) : false;
  const homePath = shortcuts.find((s) => /^home$/i.test(s.label))?.path;
  const isHome = homePath !== undefined && pathKey(homePath) === pathKey(path);

  const add = async () => {
    setTouched(true);
    if (pathError || nameError || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await addFolderSource(path, name);
      onClose();
    } catch (err) {
      setAddError(errorMessage(err));
      setAdding(false);
    }
  };

  return (
    <Dialog onRequestClose={adding ? () => undefined : onClose} labelledBy={titleId} className="library-dialog folder-dialog">
      <header className="library-dialog-header">
        <h2 id={titleId} className="dialog-title">
          Add a folder
        </h2>
        <button type="button" className="icon-button" onClick={onClose} disabled={adding} aria-label="Close" title="Close">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="library-dialog-body folder-body">
        {drive.length > 0 && (
          <div className="drive-shortcuts" role="group" aria-label="Google Drive folders on this computer">
            <p className="field-label">Google Drive for Desktop</p>
            <div className="shortcut-buttons">
              {drive.map((s) => (
                <button
                  key={s.path}
                  type="button"
                  className={`drive-shortcut${pathKey(s.path) === pathKey(path) ? ' selected' : ''}`}
                  onClick={() => void go(s.path)}
                  aria-pressed={pathKey(s.path) === pathKey(path)}
                >
                  <HardDrive size={16} aria-hidden="true" />
                  <span className="drive-shortcut-text">
                    <span className="drive-shortcut-label">{s.label}</span>
                    <span className="drive-shortcut-path mono">{s.path}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor={pathId} className="field-label">
            Folder
          </label>
          <div className="path-row">
            <input
              id={pathId}
              className="input mono"
              value={path}
              placeholder="Paste or type a folder path, then press Enter"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={showPathError ? true : undefined}
              aria-describedby={`${pathId}-hint`}
              onChange={(e) => choose(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (path.trim()) void go(path.trim(), { fromField: true });
                }
              }}
              data-autofocus
            />
            <button
              type="button"
              className="button small"
              onClick={() => void go(path.trim(), { fromField: true })}
              disabled={!path.trim() || (shownPath && !listing?.error)}
            >
              Show
            </button>
          </div>
          <p id={`${pathId}-hint`} className={showPathError ? 'field-error' : 'field-hint'}>
            {showPathError
              ? pathError
              : path.trim() && listing && !shownPath && !loading
                ? 'Press Enter to show this folder below, or add it as typed.'
                : 'The path of a folder on this computer, for example one synced by Google Drive for Desktop.'}
          </p>
        </div>

        {other.length > 0 && (
          <div className="shortcut-row" role="group" aria-label="Places">
            {other.map((s) => (
              <button key={s.path} type="button" className="chip-button" onClick={() => void go(s.path)}>
                {s.label}
              </button>
            ))}
          </div>
        )}

        <div className="dir-browser" aria-busy={loading || undefined}>
          <div className="dir-bar">
            <button
              type="button"
              className="icon-button small"
              onClick={() => listing?.parent && void go(listing.parent)}
              disabled={!listing?.parent || loading}
              aria-label="Up one folder"
              title="Up one folder"
            >
              <CornerLeftUp size={15} aria-hidden="true" />
            </button>
            <nav className="crumbs" aria-label="Folder path">
              <ol>
                {crumbs.map((c, i) => (
                  <li key={c.path}>
                    {i > 0 && <ChevronRight size={12} aria-hidden="true" className="crumb-sep" />}
                    {i === crumbs.length - 1 ? (
                      <span className="crumb current" aria-current="location">
                        {c.label}
                      </span>
                    ) : (
                      <button type="button" className="crumb" onClick={() => void go(c.path)}>
                        {c.label}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
            {loading && <Spinner size={13} label="Loading folders" />}
          </div>
          <ul className="dir-list" ref={listRef} aria-label="Folders inside">
            {requestError ? (
              <li className="dir-state" role="alert">
                <span className="field-error">Could not list folders: {requestError}</span>
                <button type="button" className="button small" onClick={() => void go(listing?.path ?? null)}>
                  Try again
                </button>
              </li>
            ) : listing?.error ? (
              <li className="dir-state">
                <WarningIcon size={14} />
                <span>{listing.error}</span>
              </li>
            ) : listing && listing.dirs.length === 0 && !loading ? (
              <li className="dir-state muted">No folders inside this one.</li>
            ) : (
              listing?.dirs.map((d) => (
                <li key={d.path}>
                  <button type="button" className="dir-item" onClick={() => void go(d.path)} disabled={loading}>
                    <Folder size={15} aria-hidden="true" />
                    <span>{d.name}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="field">
          <label htmlFor={nameId} className="field-label">
            Name in the library
          </label>
          <input
            id={nameId}
            className="input"
            value={name}
            maxLength={SOURCE_NAME_MAX + 10}
            aria-invalid={showNameError ? true : undefined}
            aria-describedby={showNameError ? `${nameId}-error` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
          />
          {showNameError && (
            <p className="field-error" id={`${nameId}-error`}>
              {nameError}
            </p>
          )}
        </div>
        {isHome && (
          <p className="field-hint">This is your whole home folder. Reading it can take a long time; a more specific folder is usually better.</p>
        )}
        {listing?.error && path.trim() && !pathError && (
          <p className="field-hint">This folder cannot be read right now. You can still add it; it is read when it becomes available.</p>
        )}
      </div>
      <footer className="library-dialog-footer">
        <div className="settings-footer-message" aria-live="polite">
          {addError && (
            <p className="form-error" role="alert">
              {addError}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose} disabled={adding}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => void add()} disabled={adding || !path.trim()}>
            {adding && <Spinner size={14} />}
            {adding ? 'Adding…' : 'Use this folder'}
          </button>
        </div>
      </footer>
    </Dialog>
  );
}
