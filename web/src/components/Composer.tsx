import { ArrowUp, FastForward, FileText, Globe, Layers, Library, Paperclip, Scale, Square, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LibraryMode, ProviderInfo, Settings, Turn } from '../../../shared/types';
import {
  changeSettings,
  clearComposerError,
  openSettings,
  removeAttachment,
  sendMessage,
  setDraft,
  skipToVerdict,
  stopTurn,
} from '../actions';
import { formatNumber, plural } from '../lib/format';
import { anySyncActive, attachedSize, attachmentBudget, browseNote, browseSupport, type AttachedDocument } from '../lib/library';
import { activeProtocol, arbiterFromMember, arbiterMatchesMember, enabledMembers } from '../lib/settings';
import { canSkipToVerdict } from '../lib/turn';
import { useStore, type ConversationKey } from '../store';
import { MemberDot, Spinner, WarningIcon } from './icons';
import { AttachmentPicker } from './library/AttachmentPicker';
import { Menu, MenuGroup, MenuItem, MenuSeparator } from './Menu';

interface ComposerProps {
  convKey: ConversationKey;
  /** The running turn of this conversation, if any. */
  runningTurn: Turn | null;
  /** False while the conversation is still loading or failed to load. */
  ready: boolean;
  autoFocus?: boolean;
}

const HINT =
  'Runs on your Claude, ChatGPT and Gemini subscriptions through their official CLIs. @name asks a single member.';

export function Composer({ convKey, runningTurn, ready, autoFocus = false }: ComposerProps) {
  const draft = useStore((s) => s.drafts[convKey] ?? '');
  const pending = useStore((s) => s.pendingSend !== null);
  const error = useStore((s) => s.composerErrors[convKey] ?? null);
  const settings = useStore((s) => s.settings);
  const maxChars = useStore((s) => s.meta?.limits.maxMessageChars ?? 200_000);
  const turnAction = useStore((s) => (runningTurn ? s.turnActions[runningTurn.id] ?? null : null));
  const attachments = useStore((s) => s.attachments[convKey] ?? NO_ATTACHMENTS);
  const [picking, setPicking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  const counterId = useId();

  const tooLong = draft.length > maxChars;
  const canSend = ready && !pending && !runningTurn && !tooLong && draft.trim().length > 0 && settings !== null;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft]);

  useEffect(() => {
    // On touch devices focusing would pop up the keyboard unasked.
    if (autoFocus && window.matchMedia('(hover: hover) and (pointer: fine)').matches) textareaRef.current?.focus();
  }, [autoFocus, convKey]);

  const submit = () => {
    if (!canSend) return;
    void sendMessage(convKey, draft.trim());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // keyCode 229 covers browsers that report IME composition keys without isComposing.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };

  const skippable = runningTurn ? canSkipToVerdict(runningTurn) : false;
  const conversationId = convKey;

  return (
    <div className="composer-wrap">
      {error && (
        <div className="composer-error" role="alert" id={errorId}>
          <span>{error}</span>
          <button type="button" className="link-button" onClick={() => clearComposerError(convKey)}>
            Dismiss
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {attachments.length > 0 && settings && (
          <AttachmentChips convKey={convKey} attachments={attachments} budget={settings.library.attachmentChars} />
        )}
        <label className="visually-hidden" htmlFor={`composer-${convKey || 'new'}`}>
          Message the council
        </label>
        <textarea
          id={`composer-${convKey || 'new'}`}
          ref={textareaRef}
          className="composer-input"
          rows={1}
          placeholder="Ask the council…"
          value={draft}
          onChange={(e) => setDraft(convKey, e.target.value)}
          onKeyDown={onKeyDown}
          aria-invalid={tooLong || undefined}
          aria-describedby={[error ? errorId : '', tooLong ? counterId : ''].filter(Boolean).join(' ') || undefined}
        />
        {tooLong && (
          <p className="composer-counter" id={counterId}>
            The message is too long: {formatNumber(draft.length)} of {formatNumber(maxChars)} characters.
          </p>
        )}
        <div className="composer-bar">
          <div className="composer-controls">
            {settings && (settings.library.sources.length > 0 || attachments.length > 0) && (
              <button
                type="button"
                className={`chip-button icon-only${attachments.length > 0 ? ' on' : ''}`}
                onClick={() => setPicking(true)}
                disabled={!ready}
                aria-haspopup="dialog"
                aria-label={attachments.length > 0 ? `Attach documents (${attachments.length} attached)` : 'Attach documents'}
                title="Attach documents for every model to read in full"
              >
                <Paperclip size={15} aria-hidden="true" />
              </button>
            )}
            {settings && <ProtocolMenu settings={settings} />}
            {settings && <ArbiterMenu settings={settings} />}
            {settings && <WebSearchToggle settings={settings} />}
            {settings && <LibraryMenu settings={settings} />}
          </div>
          <div className="composer-send">
            {runningTurn && skippable && (
              <button
                type="button"
                className="text-button"
                onClick={() => void skipToVerdict(conversationId, runningTurn.id)}
                disabled={turnAction !== null}
                aria-label="Skip to verdict"
                title="End the current round now and let the arbiter decide with the answers so far"
              >
                {turnAction === 'skip' ? <Spinner size={14} /> : <FastForward size={14} aria-hidden="true" />}
                <span>Skip to verdict</span>
              </button>
            )}
            {runningTurn ? (
              <button
                type="button"
                className="send-button stop"
                onClick={() => void stopTurn(conversationId, runningTurn.id)}
                disabled={turnAction === 'stop'}
                aria-label={turnAction === 'stop' ? 'Stopping' : 'Stop'}
                title="Stop"
              >
                {turnAction === 'stop' ? <Spinner size={16} /> : <Square size={14} fill="currentColor" aria-hidden="true" />}
              </button>
            ) : (
              <button type="submit" className="send-button" disabled={!canSend} aria-label={pending ? 'Sending' : 'Send'} title="Send (Enter)">
                {pending ? <Spinner size={16} /> : <ArrowUp size={18} aria-hidden="true" />}
              </button>
            )}
          </div>
        </div>
      </form>
      <p className="composer-hint">{HINT}</p>
      {picking && <AttachmentPicker convKey={convKey} onClose={() => setPicking(false)} />}
    </div>
  );
}

const NO_ATTACHMENTS: AttachedDocument[] = [];

function AttachmentChips({ convKey, attachments, budget }: { convKey: string; attachments: AttachedDocument[]; budget: number }) {
  const plan = attachmentBudget(attachments, budget);
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  return (
    <div className="composer-attachments">
      <ul className="attachment-chips" aria-label="Attached documents">
        {attachments.map((d) => {
          const item = byId.get(d.id);
          const note = d.problem ? d.problem : item?.leftOut ? 'Over the attachment budget: it will not be included.' : item?.cut ? 'Over the attachment budget: it will be cut.' : '';
          return (
            <li key={d.id} className={`attachment-chip${note ? ' over' : ''}`} title={note ? `${d.title}\n${note}` : d.title}>
              {note ? <WarningIcon size={13} /> : <FileText size={13} aria-hidden="true" />}
              <span className="attachment-chip-title">{d.title}</span>
              <span className="attachment-chip-size">{attachedSize(d)}</span>
              {note && <span className="visually-hidden">{note}</span>}
              <button
                type="button"
                className="attachment-chip-remove"
                onClick={() => removeAttachment(convKey, d.id)}
                aria-label={`Remove ${d.title}`}
                title="Remove"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {plan.over > 0 && (
        <p className="composer-attachments-note">
          Over the attachment budget by {formatNumber(plan.over)} characters: the documents marked will be cut or left out.
        </p>
      )}
    </div>
  );
}

function LibraryMenu({ settings }: { settings: Settings }) {
  const status = useStore((s) => s.library.status);
  const providers = useStore((s) => s.providers.list);
  const mode = settings.library.mode;
  const hasSources = settings.library.sources.length > 0;
  // Unknown (not loaded yet, or the check failed) counts as usable: never hide the mode choice
  // because of a failed status request.
  const documents = status ? status.documents : null;
  const empty = !hasSources || documents === 0;
  const allOff = hasSources && settings.library.sources.every((src) => !src.enabled);
  const reading = documents === 0 && anySyncActive(status);

  const label = !hasSources ? 'Library' : allOff ? 'Library: sources off' : reading ? 'Library: reading…' : documents === 0 ? 'Library: empty' : `Library: ${mode}`;
  const active = !empty && mode !== 'off';
  const note = providers ? browseNote(browseSupport(settings, providers)) : '';
  const setMode = (next: LibraryMode) => {
    if (next === mode) return;
    changeSettings((s) => ({ ...s, library: { ...s.library, mode: next } }), 'the library setting');
  };

  return (
    <Menu
      trigger={
        <>
          <Library size={15} aria-hidden="true" />
          <span className="chip-label">{label}</span>
        </>
      }
      triggerLabel={label}
      triggerClassName={`chip-button${active ? ' on' : ''}`}
      triggerTitle="How questions use your document library"
      placement="top-start"
      menuLabel="Library"
      className="menu-wide"
    >
      {empty ? (
        <MenuItem
          description={
            !hasSources
              ? 'Add folders or a Notion workspace so the council can use your own documents.'
              : allOff
                ? 'Every source is turned off.'
                : reading
                ? 'Your documents are being read. They can be searched as soon as some are ready.'
                : 'None of the documents in your sources could be read yet.'
          }
          onSelect={() => openSettings('library')}
        >
          {allOff ? 'Manage library…' : 'Add documents…'}
        </MenuItem>
      ) : (
        <>
          <MenuGroup label="Library">
            <MenuItem checked={mode === 'off'} description="Questions do not use the library. Attached documents are still read." onSelect={() => setMode('off')}>
              Off
            </MenuItem>
            <MenuItem checked={mode === 'search'} description="Every model gets the same relevant passages." onSelect={() => setMode('search')}>
              Search the library
            </MenuItem>
            <MenuItem
              checked={mode === 'browse'}
              description={
                <>
                  Models with file tools also open documents themselves. Slower.
                  {note && <span className="menu-item-note">{note}</span>}
                </>
              }
              onSelect={() => setMode('browse')}
            >
              Let models browse
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onSelect={() => openSettings('library')}>Manage library…</MenuItem>
        </>
      )}
    </Menu>
  );
}

function ProtocolMenu({ settings }: { settings: Settings }) {
  const active = activeProtocol(settings);
  return (
    <Menu
      trigger={
        <>
          <Layers size={15} aria-hidden="true" />
          <span className="chip-label">{active?.name ?? 'Protocol'}</span>
        </>
      }
      triggerLabel={`Protocol: ${active?.name ?? 'none'}`}
      triggerClassName="chip-button"
      triggerTitle="Protocol"
      placement="top-start"
      menuLabel="Protocol"
      className="menu-wide"
    >
      <MenuGroup label="Protocol">
        {settings.protocols.map((p) => (
          <MenuItem
            key={p.id}
            checked={p.id === active?.id}
            description={`${p.description ? `${p.description} ` : ''}${plural(p.rounds.length, 'round')}.`}
            onSelect={() => {
              if (p.id === active?.id) return;
              changeSettings((s) => ({ ...s, activeProtocolId: p.id }), 'the protocol');
            }}
          >
            {p.name}
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onSelect={() => openSettings('protocol')}>Edit protocols…</MenuItem>
    </Menu>
  );
}

function ArbiterMenu({ settings }: { settings: Settings }) {
  const arbiter = settings.arbiter;
  const matches = settings.members.filter((m) => arbiterMatchesMember(arbiter, m));
  const direct = enabledMembers(settings).length === 1;
  const providers = useStore((s) => s.providers.list);
  return (
    <Menu
      trigger={
        <>
          <Scale size={15} aria-hidden="true" />
          <span className="chip-label">Arbiter: {arbiter.name}</span>
        </>
      }
      triggerLabel={`Arbiter: ${arbiter.name}`}
      triggerClassName="chip-button"
      triggerTitle={direct ? 'Arbiter (not used while only one member is enabled)' : 'Arbiter'}
      placement="top-start"
      menuLabel="Arbiter"
      className="menu-wide"
    >
      <MenuGroup label="Arbiter">
        {matches.length === 0 && (
          <MenuItem checked description={describeSeat(providers, arbiter.provider, arbiter.model)} onSelect={() => undefined}>
            {arbiter.name}
          </MenuItem>
        )}
        {settings.members.map((m) => (
          <MenuItem
            key={m.id}
            checked={matches[0]?.id === m.id}
            icon={<MemberDot color={m.color} />}
            description={describeSeat(providers, m.provider, m.model) + (m.enabled ? '' : ' · disabled in the council')}
            onSelect={() => {
              if (matches[0]?.id === m.id) return;
              changeSettings((s) => ({ ...s, arbiter: arbiterFromMember(s.arbiter, m) }), 'the arbiter');
            }}
          >
            {m.name}
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem onSelect={() => openSettings('arbiter')}>Customise…</MenuItem>
    </Menu>
  );
}

function describeSeat(providers: ProviderInfo[] | null, provider: string, model: string): string {
  const label = providers?.find((p) => p.id === provider)?.label ?? provider;
  return model ? `${label} · ${model}` : `${label} · default model`;
}

function WebSearchToggle({ settings }: { settings: Settings }) {
  const on = settings.webSearch;
  return (
    <button
      type="button"
      className={`chip-button${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-label="Web search"
      title={on ? 'Web search is on' : 'Web search is off'}
      onClick={() => changeSettings((s) => ({ ...s, webSearch: !s.webSearch }), 'the web search setting')}
    >
      <Globe size={15} aria-hidden="true" />
      <span className="chip-label">Web search</span>
    </button>
  );
}
