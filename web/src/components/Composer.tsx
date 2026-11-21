import { ArrowUp, FastForward, Globe, Layers, Scale, Square } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { ProviderInfo, Settings, Turn } from '../../../shared/types';
import {
  changeSettings,
  clearComposerError,
  openSettings,
  sendMessage,
  setDraft,
  skipToVerdict,
  stopTurn,
} from '../actions';
import { formatNumber, plural } from '../lib/format';
import { activeProtocol, arbiterFromMember, arbiterMatchesMember, enabledMembers } from '../lib/settings';
import { canSkipToVerdict } from '../lib/turn';
import { useStore, type ConversationKey } from '../store';
import { MemberDot, Spinner } from './icons';
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
            {settings && <ProtocolMenu settings={settings} />}
            {settings && <ArbiterMenu settings={settings} />}
            {settings && <WebSearchToggle settings={settings} />}
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
    </div>
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
