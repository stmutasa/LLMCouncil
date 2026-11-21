import { memo, useMemo } from 'react';
import type { MemberSnapshot } from '../../../shared/types';
import { splitMentions } from '../lib/mentionSegments';

interface UserMessageProps {
  text: string;
  /** Members that can be recognised as @mentions in this message. */
  members: MemberSnapshot[] | { id: string; name: string }[];
  pending?: boolean;
}

export const UserMessage = memo(function UserMessage({ text, members, pending = false }: UserMessageProps) {
  const segments = useMemo(() => splitMentions(text, members), [text, members]);
  return (
    <div className={`user-message${pending ? ' pending' : ''}`}>
      <h2 className="visually-hidden">You said:</h2>
      <div className="user-bubble">
        {segments.map((seg, i) =>
          seg.kind === 'mention' ? (
            <span key={i} className="mention-chip">
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </div>
    </div>
  );
});
