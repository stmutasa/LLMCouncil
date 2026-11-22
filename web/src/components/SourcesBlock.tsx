import { BookOpen, ChevronDown, ExternalLink, FolderOpen } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState } from 'react';
import type { SourceExcerpt, Turn, TurnAttachment, TurnLibrary } from '../../../shared/types';
import { api, errorMessage } from '../api';
import { formatChars, groupExcerpts, librarySummary, whereText, type ExcerptGroup } from '../lib/library';
import { useStore } from '../store';
import { Spinner, WarningIcon } from './icons';

/** DOM id of a cited item, so a citation chip can bring it into view. */
function itemId(turnId: string, citationId: string): string {
  return `cite-${turnId}-${citationId}`;
}

/**
 * "What did the models actually get to read for this answer?" — the searches, attached
 * documents and passages of one turn. Collapsed by default; a citation chip opens it at the
 * cited item.
 */
export const SourcesBlock = memo(function SourcesBlock({ turnId, library }: { turnId: string; library: TurnLibrary }) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
  const target = useStore((s) => (s.citationTarget?.turnId === turnId ? s.citationTarget : null));

  const [lastSeq, setLastSeq] = useState<number | null>(null);
  if (target && target.seq !== lastSeq) {
    setLastSeq(target.seq);
    setOpen(true);
    setFocus({ id: target.id, seq: target.seq });
  }

  useEffect(() => {
    if (!open || !focus) return;
    const el = document.getElementById(itemId(turnId, focus.id));
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  }, [open, focus, turnId]);

  const summary = librarySummary(library);
  const running = library.status === 'pending' || library.status === 'running';
  const icon =
    summary.tone === 'running' ? <Spinner size={15} /> : summary.tone === 'warning' ? <WarningIcon size={15} /> : <BookOpen size={15} aria-hidden="true" />;
  const hasContent = library.queries.length > 0 || library.attachments.length > 0 || library.excerpts.length > 0;

  return (
    <section className={`sources${open ? ' open' : ''}${summary.tone === 'warning' ? ' warning' : ''}`} aria-label="Sources">
      <button type="button" className="sources-header" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <span className="sources-icon">{icon}</span>
        <span className="sources-summary">
          <span className="visually-hidden">Sources: </span>
          {summary.text}
        </span>
        <ChevronDown size={16} className="sources-chevron" aria-hidden="true" />
      </button>
      {library.plannerNote.trim() && <p className="sources-note">{library.plannerNote}</p>}
      <div id={bodyId} className="sources-body" hidden={!open}>
        {open && (
          <>
            {running && !hasContent && <p className="muted small">The library is being searched for this question…</p>}
            {!running && !hasContent && (
              <p className="muted small">Nothing from the library was given to the models for this question.</p>
            )}
            {library.queries.length > 0 && (
              <div className="sources-queries">
                <span className="sources-label">Searched for</span>
                <ul className="query-chips" aria-label="Searches used">
                  {library.queries.map((q, i) => (
                    <li key={`${i}-${q}`} className="query-chip">
                      {q}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {library.attachments.length > 0 && (
              <div className="sources-section">
                <h3 className="sources-label">Attached documents</h3>
                <ul className="sources-list">
                  {library.attachments.map((a) => (
                    <AttachmentItem key={a.id} turnId={turnId} attachment={a} highlight={focus} />
                  ))}
                </ul>
              </div>
            )}
            {library.excerpts.length > 0 && (
              <div className="sources-section">
                <h3 className="sources-label">Passages</h3>
                <ul className="sources-list">
                  {groupExcerpts(library.excerpts).map((g) => (
                    <PassageGroup key={g.documentId} turnId={turnId} group={g} highlight={focus} />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
});

/** Shows a turn's Sources block when the library took part; old turns have none. */
export function TurnSources({ turn }: { turn: Turn }) {
  const library = turn.library ?? null;
  if (!library) return null;
  return <SourcesBlock turnId={turn.id} library={library} />;
}

type Highlight = { id: string; seq: number } | null;

function AttachmentItem({ turnId, attachment: a, highlight }: { turnId: string; attachment: TurnAttachment; highlight: Highlight }) {
  const flash = highlight?.id === a.id;
  return (
    <li
      id={itemId(turnId, a.id)}
      tabIndex={-1}
      key={flash ? `flash-${highlight?.seq}` : undefined}
      className={`source-item${flash ? ' flash' : ''}`}
    >
      <div className="source-item-head">
        <span className="cite-id">{a.id}</span>
        <span className="source-title">{a.title}</span>
        <DocumentLink documentId={a.documentId} url={a.url} />
      </div>
      <p className="source-where">{whereText([a.sourceName, a.location, a.problem ? '' : `${formatChars(a.chars)} included`])}</p>
      {a.problem ? (
        <p className="source-problem">
          <WarningIcon size={13} />
          <span>{a.problem}</span>
        </p>
      ) : (
        a.truncated && <p className="source-cut">Cut to fit the attachment budget; the rest was not sent.</p>
      )}
    </li>
  );
}

function PassageGroup({ turnId, group, highlight }: { turnId: string; group: ExcerptGroup; highlight: Highlight }) {
  return (
    <li className="passage-group">
      <div className="source-item-head">
        <span className="source-title">{group.title}</span>
        <DocumentLink documentId={group.documentId} url={group.url} />
      </div>
      {whereText([group.sourceName, group.location]) && <p className="source-where">{whereText([group.sourceName, group.location])}</p>}
      <ul className="passages">
        {group.excerpts.map((e) => (
          <Passage key={e.id} turnId={turnId} excerpt={e} highlight={highlight} />
        ))}
      </ul>
    </li>
  );
}

function Passage({ turnId, excerpt: e, highlight }: { turnId: string; excerpt: SourceExcerpt; highlight: Highlight }) {
  const targeted = highlight?.id === e.id;
  return (
    <li
      id={itemId(turnId, e.id)}
      tabIndex={-1}
      key={targeted ? `flash-${highlight?.seq}` : undefined}
      className={`passage${targeted ? ' flash' : ''}`}
    >
      <div className="passage-head">
        <span className="cite-id">{e.id}</span>
        {e.part && <span className="passage-part">{e.part}</span>}
      </div>
      <ClampedText text={e.text} expandKey={targeted ? highlight?.seq ?? null : null} />
    </li>
  );
}

const LONG_TEXT = 320;

/**
 * Passage text with line breaks kept, folded to a few lines with "Show more". A new
 * `expandKey` (a citation pointing here) unfolds it.
 */
export function ClampedText({ text, expandKey = null }: { text: string; expandKey?: number | null }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [lastKey, setLastKey] = useState<number | null>(null);
  if (expandKey !== null && expandKey !== lastKey) {
    setLastKey(expandKey);
    setExpanded(true);
  }
  const long = text.length > LONG_TEXT || text.split('\n').length > 4;
  return (
    <>
      <p id={id} className={`passage-text${long && !expanded ? ' clamped' : ''}`}>
        {text}
      </p>
      {long && (
        <button type="button" className="link-button passage-more" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

/** "Open in Notion" for Notion pages; "Show in folder" for local files. */
export function DocumentLink({ documentId, url }: { documentId: string; url: string | null }) {
  if (url) {
    return (
      <a className="source-action" href={url} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={13} aria-hidden="true" />
        <span>Open in Notion</span>
      </a>
    );
  }
  return <RevealButton documentId={documentId} />;
}

export function RevealButton({ documentId, className = 'source-action' }: { documentId: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'pending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const reveal = async () => {
    setState('pending');
    setError(null);
    try {
      await api.revealDocument(documentId);
      setState('done');
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      setState('idle');
      setError(errorMessage(err));
    }
  };
  return (
    <span className="reveal">
      <button type="button" className={className} onClick={() => void reveal()} disabled={state === 'pending'}>
        {state === 'pending' ? <Spinner size={13} /> : <FolderOpen size={13} aria-hidden="true" />}
        <span>{state === 'done' ? 'Opened' : 'Show in folder'}</span>
      </button>
      {error && (
        <span className="reveal-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
