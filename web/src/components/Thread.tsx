import { ArrowDown } from 'lucide-react';
import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import type { Conversation, Turn, TurnLibrary } from '../../../shared/types';
import { buildCitationLookups, EMPTY_LOOKUP, type CitationLookup } from '../lib/citations';
import { FollowContext } from '../hooks/followContext';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { useStore } from '../store';
import { AssistantTurn } from './AssistantTurn';
import { UserMessage } from './UserMessage';

interface ThreadProps {
  /** Key of the conversation for scroll reset; '' for a new chat. */
  threadKey: string;
  conversation: Conversation | null;
  /** Message being sent, shown optimistically at the end. */
  pendingMessage: string | null;
  /** Content shown instead of turns (loading and error states). */
  children?: ReactNode;
}

export function Thread({ threadKey, conversation, pendingMessage, children }: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { showJump, scrollToBottom, following } = useStickToBottom(scrollRef, contentRef, threadKey);
  const streams = useStore((s) => s.streams);
  const settingsMembers = useStore((s) => s.settings?.members);
  const sentAttachments = useStore((s) => s.sentAttachments);
  const pendingAttachments = useStore((s) => s.pendingSend?.attachments);
  const turns = conversation?.turns ?? [];
  const citations = useCitationLookups(turns);

  // Sending or starting a new turn is a deliberate act: jump to the bottom and follow again.
  const turnCount = turns.length;
  const lastCount = useRef(turnCount);
  useEffect(() => {
    if (pendingMessage !== null) scrollToBottom(false);
  }, [pendingMessage, scrollToBottom]);
  useEffect(() => {
    if (turnCount > lastCount.current) scrollToBottom(false);
    lastCount.current = turnCount;
  }, [turnCount, scrollToBottom]);

  return (
    <div className="thread-area">
      <FollowContext.Provider value={following}>
        <div className="thread-scroll" ref={scrollRef}>
          <div className="thread" ref={contentRef}>
            {children}
            {conversation && <h2 className="visually-hidden">Conversation: {conversation.title}</h2>}
            {turns.map((turn, i) => (
              <Fragment key={turn.id}>
                <UserMessage
                  text={turn.userMessage}
                  members={turn.members}
                  attachments={turnAttachmentTitles(turn, sentAttachments[turn.id])}
                />
                <AssistantTurn
                  turn={turn}
                  conversationId={conversation?.id ?? threadKey}
                  isLast={i === turns.length - 1}
                  streamState={streams[turn.id] ?? null}
                  citations={citations.get(turn.id) ?? EMPTY_LOOKUP}
                />
              </Fragment>
            ))}
            {pendingMessage !== null && (
              <UserMessage
                text={pendingMessage}
                members={settingsMembers ?? []}
                attachments={pendingAttachments ?? NO_ATTACHMENTS}
                pending
              />
            )}
          </div>
        </div>
      </FollowContext.Provider>
      {showJump && (
        <button type="button" className="jump-button" onClick={() => scrollToBottom(true)} aria-label="Scroll to the latest message">
          <ArrowDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

const NO_ATTACHMENTS: readonly { title: string }[] = [];

/**
 * The documents attached to a turn: the server's list once the library phase has run, else what
 * was sent (the server fills its list only when that phase ends). Returns stable arrays so the
 * memoised message does not re-render while the answer streams.
 */
function turnAttachmentTitles(turn: Turn, sent: readonly { title: string }[] | undefined): readonly { title: string }[] {
  const library = turn.library ?? null;
  if (library && library.attachments.length > 0) return library.attachments;
  // A finished phase lists every attachment (with problems); an error or a stop may list none.
  if (library?.status === 'done') return NO_ATTACHMENTS;
  return sent ?? NO_ATTACHMENTS;
}

/**
 * Citation lookups for every turn, rebuilt only when some turn's library changes, so that
 * streaming text (which replaces the turn object every frame) does not re-render every chip.
 */
function useCitationLookups(turns: Turn[]): Map<string, CitationLookup> {
  const cache = useRef<{ ids: string[]; libraries: (TurnLibrary | null)[]; value: Map<string, CitationLookup> } | null>(null);
  const ids = turns.map((t) => t.id);
  const libraries = turns.map((t) => t.library ?? null);
  const current = cache.current;
  if (
    !current ||
    current.ids.length !== ids.length ||
    current.ids.some((id, i) => id !== ids[i]) ||
    current.libraries.some((lib, i) => lib !== libraries[i])
  ) {
    cache.current = {
      ids,
      libraries,
      value: buildCitationLookups(turns.map((t) => ({ turnId: t.id, library: t.library ?? null }))),
    };
  }
  return cache.current!.value;
}
