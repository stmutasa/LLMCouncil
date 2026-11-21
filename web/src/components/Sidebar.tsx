import { Ellipsis, Monitor, Moon, PanelLeftClose, Pencil, Settings, SquarePen, Sun, Trash } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ConversationSummary } from '../../../shared/types';
import {
  deleteConversation,
  navigate,
  openSettings,
  renameConversation,
  setMobileSidebarOpen,
  setTheme,
  toggleSidebarCollapsed,
} from '../actions';
import { errorMessage } from '../api';
import { groupConversations } from '../lib/dates';
import { plural } from '../lib/format';
import { useStore, type ThemePreference } from '../store';
import { ConfirmDialog } from './Dialog';
import { Spinner, Wordmark } from './icons';
import { Menu, MenuItem } from './Menu';

const TITLE_MAX = 120;

export function Sidebar({ narrow }: { narrow: boolean }) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => (s.route.kind === 'conversation' ? s.route.id : null));
  // Re-evaluated when the list changes; date buckets only need day precision.
  const groups = useMemo(() => groupConversations(conversations, new Date()), [conversations]);

  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="sidebar-header">
        <a
          className="sidebar-brand"
          href="/"
          onClick={(e) => {
            if (isPlainClick(e)) {
              e.preventDefault();
              navigate({ kind: 'home' });
            }
          }}
        >
          <Wordmark />
        </a>
        <button
          type="button"
          className="icon-button"
          onClick={() => (narrow ? setMobileSidebarOpen(false) : toggleSidebarCollapsed())}
          aria-label="Close sidebar"
          title="Close sidebar"
        >
          <PanelLeftClose size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-actions">
        <a
          className="sidebar-new"
          href="/"
          onClick={(e) => {
            if (isPlainClick(e)) {
              e.preventDefault();
              navigate({ kind: 'home' });
            }
          }}
        >
          <SquarePen size={16} aria-hidden="true" />
          <span>New chat</span>
        </a>
      </div>

      <div className="sidebar-list">
        {groups.length === 0 ? (
          <p className="sidebar-empty">Your conversations will appear here.</p>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="sidebar-group" aria-label={group.label}>
              <h2 className="sidebar-group-label">{group.label}</h2>
              <ul>
                {group.items.map((c) => (
                  <ConversationRow key={c.id} conversation={c} active={c.id === activeId} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-settings" onClick={() => openSettings('council')}>
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </button>
        <ThemeToggle />
      </div>
    </nav>
  );
}

function isPlainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

const ConversationRow = memo(function ConversationRow({ conversation, active }: { conversation: ConversationSummary; active: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const refocusLink = useRef(false);

  useEffect(() => {
    if (!editing && refocusLink.current) {
      refocusLink.current = false;
      linkRef.current?.focus();
    }
  }, [editing]);

  const onDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteConversation(conversation.id);
      setConfirmDelete(false);
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <li className={`conv-row${active ? ' active' : ''}${menuOpen ? ' menu-open' : ''}`}>
      {editing ? (
        <RenameField
          conversation={conversation}
          onDone={(byKeyboard) => {
            refocusLink.current = byKeyboard;
            setEditing(false);
          }}
        />
      ) : (
        <>
          <a
            ref={linkRef}
            className="conv-link"
            href={`/c/${encodeURIComponent(conversation.id)}`}
            aria-current={active ? 'page' : undefined}
            title={conversation.title}
            onClick={(e) => {
              if (isPlainClick(e)) {
                e.preventDefault();
                navigate({ kind: 'conversation', id: conversation.id });
              }
            }}
          >
            <span className="conv-title">{conversation.title}</span>
            {conversation.running && (
              <span className="conv-running">
                <Spinner size={13} label="Running" />
              </span>
            )}
          </a>
          <Menu
            trigger={<Ellipsis size={16} aria-hidden="true" />}
            triggerLabel={`Options for “${conversation.title}”`}
            triggerClassName="icon-button small conv-menu-button"
            placement="bottom-end"
            menuLabel="Conversation options"
            onOpenChange={setMenuOpen}
          >
            <MenuItem icon={<Pencil size={15} aria-hidden="true" />} onSelect={() => setEditing(true)} restoreFocus={false}>
              Rename
            </MenuItem>
            <MenuItem
              icon={<Trash size={15} aria-hidden="true" />}
              danger
              onSelect={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
            >
              Delete
            </MenuItem>
          </Menu>
        </>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete conversation?"
          message={
            <p>
              “{conversation.title}” and its {plural(conversation.turnCount, 'turn')} will be deleted permanently.
              {conversation.running ? ' The run in progress will be stopped first.' : ''}
            </p>
          }
          confirmLabel="Delete"
          danger
          pending={deleting}
          error={deleteError}
          onConfirm={onDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </li>
  );
});

function RenameField({ conversation, onDone }: { conversation: ConversationSummary; onDone: (byKeyboard: boolean) => void }) {
  const [value, setValue] = useState(conversation.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // The input was disabled while saving; give focus back once a failure re-enables it.
  useEffect(() => {
    if (!pending && error) inputRef.current?.focus();
  }, [pending, error]);

  const submit = async (byKeyboard: boolean) => {
    if (submitted.current) return;
    const title = value.trim();
    if (!title || title === conversation.title) {
      submitted.current = true;
      onDone(byKeyboard);
      return;
    }
    if (title.length > TITLE_MAX) {
      setError(`Use at most ${TITLE_MAX} characters.`);
      return;
    }
    submitted.current = true;
    setPending(true);
    setError(null);
    try {
      await renameConversation(conversation.id, title);
      onDone(byKeyboard);
    } catch (err) {
      submitted.current = false;
      setPending(false);
      setError(`Could not rename: ${errorMessage(err)}`);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      submitted.current = true;
      onDone(true);
    }
  };

  return (
    <div className="conv-rename">
      <input
        ref={inputRef}
        className="conv-rename-input"
        value={value}
        maxLength={TITLE_MAX + 20}
        aria-label="Conversation title"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `rename-error-${conversation.id}` : undefined}
        disabled={pending}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!error) void submit(false);
        }}
      />
      {pending && <Spinner size={14} label="Saving" />}
      {error && (
        <p className="conv-rename-error" id={`rename-error-${conversation.id}`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const THEMES: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'system', label: 'System theme', Icon: Monitor },
  { value: 'light', label: 'Light theme', Icon: Sun },
  { value: 'dark', label: 'Dark theme', Icon: Moon },
];

function ThemeToggle() {
  const theme = useStore((s) => s.theme);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + THEMES.length) % THEMES.length;
    setTheme(THEMES[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {THEMES.map(({ value, label, Icon }, i) => (
        <button
          key={value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          tabIndex={theme === value ? 0 : -1}
          className="theme-option"
          onClick={() => setTheme(value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <Icon size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
