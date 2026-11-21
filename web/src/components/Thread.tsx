import { ArrowDown } from 'lucide-react';
import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import type { Conversation } from '../../../shared/types';
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
  const turns = conversation?.turns ?? [];

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
                <UserMessage text={turn.userMessage} members={turn.members} />
                <AssistantTurn
                  turn={turn}
                  conversationId={conversation?.id ?? threadKey}
                  isLast={i === turns.length - 1}
                  streamState={streams[turn.id] ?? null}
                />
              </Fragment>
            ))}
            {pendingMessage !== null && <UserMessage text={pendingMessage} members={settingsMembers ?? []} pending />}
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
