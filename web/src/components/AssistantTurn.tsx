import { ChevronsDownUp, ChevronsUpDown, NotebookText, RotateCcw } from 'lucide-react';
import { memo, useState } from 'react';
import type { Turn } from '../../../shared/types';
import { openSettings, regenerateTurn } from '../actions';
import { useFollowing } from '../hooks/followContext';
import { separateAnalysisEntries } from '../lib/analysis';
import type { CitationLookup } from '../lib/citations';
import { answerPlaceholder, finalSourceLabel, isArbiterPhase, memberInfo } from '../lib/turn';
import { useStore, type StreamState } from '../store';
import { BillingBadge } from './BillingBadge';
import { CitationContext } from './Citation';
import { CopyButton } from './CopyButton';
import { CallMeta, Deliberation } from './Deliberation';
import { Disclosure } from './Disclosure';
import { MemberDot, Spinner, WarningIcon } from './icons';
import { Markdown } from './Markdown';
import { SaveToNotionDialog } from './SaveToNotionDialog';
import { TurnSources } from './SourcesBlock';

interface AssistantTurnProps {
  turn: Turn;
  conversationId: string;
  isLast: boolean;
  streamState: StreamState | null;
  /** Citation ids the turn's text can refer to (its own library and earlier turns'). */
  citations: CitationLookup;
}

export const AssistantTurn = memo(function AssistantTurn({ turn, conversationId, isLast, streamState, citations }: AssistantTurnProps) {
  const running = turn.status === 'running';
  const hasFinal = turn.finalText.trim().length > 0;
  const council = turn.mode === 'council';

  // null = automatic. The deliberation stays open until the final answer starts; the analysis
  // stays open while it streams and folds away once the answer begins. A manual toggle wins.
  const [deliberationManual, setDeliberationManual] = useState<boolean | null>(null);
  const [analysisManual, setAnalysisManual] = useState<boolean | null>(null);
  const following = useFollowing();
  // When the answer starts while the user is reading the deliberation (scrolled up), keep it
  // open instead of folding the text away under them; they can still collapse it themselves.
  const [prevHasFinal, setPrevHasFinal] = useState(hasFinal);
  if (hasFinal !== prevHasFinal) {
    setPrevHasFinal(hasFinal);
    if (hasFinal && !following) {
      if (deliberationManual === null) setDeliberationManual(true);
      if (analysisManual === null) setAnalysisManual(true);
    }
  }
  const deliberationOpen = deliberationManual ?? !hasFinal;
  const analysisOpen = analysisManual ?? !hasFinal;
  const showAnalysis = council && turn.analysisText.trim().length > 0;

  return (
    <CitationContext.Provider value={citations}>
    <article className="assistant-turn" aria-label="Council answer" aria-busy={running || undefined}>
      <TurnSources turn={turn} />
      {council ? (
        <Deliberation
          turn={turn}
          open={deliberationOpen}
          onToggle={() => setDeliberationManual(!deliberationOpen)}
          streamState={streamState}
        />
      ) : (
        streamState === 'reconnecting' && (
          <p className="stream-note" role="status">
            <Spinner size={13} /> Connection to the server lost. Reconnecting…
          </p>
        )
      )}

      {showAnalysis && (
        <Disclosure
          open={analysisOpen}
          onToggle={() => setAnalysisManual(!analysisOpen)}
          summary={
            <span className="analysis-summary">
              Council analysis
              {running && !hasFinal && <Spinner size={12} />}
            </span>
          }
          className="analysis"
        >
          <Markdown text={separateAnalysisEntries(turn.analysisText)} className="analysis-text" />
        </Disclosure>
      )}

      <FinalAnswer turn={turn} />

      <StatusNotes turn={turn} />

      {!running && (
        <TurnActions
          turn={turn}
          conversationId={conversationId}
          isLast={isLast}
          deliberationOpen={deliberationOpen}
          onToggleDeliberation={council ? () => setDeliberationManual(!deliberationOpen) : null}
        />
      )}
    </article>
    </CitationContext.Provider>
  );
});

function FinalAnswer({ turn }: { turn: Turn }) {
  const running = turn.status === 'running';
  const hasFinal = turn.finalText.trim().length > 0;

  if (!hasFinal) {
    if (!running) return null;
    const activity =
      turn.mode === 'direct' ? turn.rounds[0]?.responses[0]?.activity ?? '' : isArbiterPhase(turn) ? turn.arbiter?.activity ?? '' : '';
    return (
      <div className="final-placeholder" role="status">
        <span className="pulse-dot" aria-hidden="true" />
        <span>{answerPlaceholder(turn)}</span>
        {activity && <span className="muted">· {activity}</span>}
      </div>
    );
  }

  return (
    <div className="final-answer">
      <SourceLine turn={turn} />
      <Markdown text={turn.finalText} className="final-text" />
      {running && <span className="streaming-caret" aria-hidden="true" />}
    </div>
  );
}

function SourceLine({ turn }: { turn: Turn }) {
  const src = turn.finalSource;
  if (turn.mode === 'direct') {
    const response = turn.rounds[0]?.responses[0];
    const member = response ? memberInfo(turn, response.memberId) : turn.members[0];
    return (
      <div className="source-line">
        {member && <MemberDot color={member.color} />}
        <span className="source-name">{member?.name ?? finalSourceLabel(turn)}</span>
        {response && turn.status !== 'running' && <CallMeta response={response} />}
      </div>
    );
  }
  if (src.kind === 'fallback') {
    const member = src.memberId ? memberInfo(turn, src.memberId) : null;
    return (
      <div className="source-line warning">
        <WarningIcon size={14} />
        {member && <MemberDot color={member.color} />}
        <span className="source-name">{finalSourceLabel(turn)}</span>
      </div>
    );
  }
  const arbiter = turn.arbiter;
  return (
    <div className="source-line">
      <span className="source-name">{finalSourceLabel(turn)}</span>
      {arbiter?.model && <span className="muted">· {arbiter.model}</span>}
      {arbiter && <BillingBadge billing={arbiter.billing === 'api-key' ? 'api-key' : 'unknown'} />}
    </div>
  );
}

function StatusNotes({ turn }: { turn: Turn }) {
  switch (turn.status) {
    case 'error':
      return (
        <div className="error-card turn-error" role="alert">
          <WarningIcon size={16} />
          <div>
            <p className="pre-wrap">{turn.error || 'The turn ended without an answer.'}</p>
            <button type="button" className="button small" onClick={() => openSettings('providers')}>
              Check providers
            </button>
          </div>
        </div>
      );
    case 'stopped':
      return <p className="status-note">Stopped.</p>;
    case 'interrupted':
      return (
        <p className="status-note warning pre-wrap">
          {turn.error || 'The server stopped while this turn was running.'}
        </p>
      );
    case 'complete':
      // A degraded success (the arbiter failed and a member's answer stands in) explains itself.
      return turn.error ? <p className="status-note warning pre-wrap">{turn.error}</p> : null;
    default:
      return null;
  }
}

interface TurnActionsProps {
  turn: Turn;
  conversationId: string;
  isLast: boolean;
  deliberationOpen: boolean;
  onToggleDeliberation: (() => void) | null;
}

function TurnActions({ turn, conversationId, isLast, deliberationOpen, onToggleDeliberation }: TurnActionsProps) {
  const regenerating = useStore((s) => s.turnActions[turn.id] === 'regenerate');
  const notionConnected = useStore((s) => s.notion.status?.connected === true);
  const [error, setError] = useState<string | null>(null);
  const [savingToNotion, setSavingToNotion] = useState(false);
  const hasFinal = turn.finalText.trim().length > 0;

  const onRegenerate = async () => {
    setError(null);
    const message = await regenerateTurn(conversationId, turn.id);
    if (message) setError(message);
  };

  return (
    <div className="turn-actions">
      {hasFinal && <CopyButton getText={() => turn.finalText} label="Copy answer" showLabel className="action-button" />}
      {isLast && (
        <button type="button" className="action-button" onClick={() => void onRegenerate()} disabled={regenerating}>
          {regenerating ? <Spinner size={14} /> : <RotateCcw size={14} aria-hidden="true" />}
          <span>{regenerating ? 'Regenerating…' : 'Regenerate'}</span>
        </button>
      )}
      {hasFinal && notionConnected && (
        <button type="button" className="action-button" onClick={() => setSavingToNotion(true)} aria-haspopup="dialog">
          <NotebookText size={14} aria-hidden="true" />
          <span>Save to Notion</span>
        </button>
      )}
      {onToggleDeliberation && (
        <button type="button" className="action-button" onClick={onToggleDeliberation} aria-expanded={deliberationOpen}>
          {deliberationOpen ? <ChevronsDownUp size={14} aria-hidden="true" /> : <ChevronsUpDown size={14} aria-hidden="true" />}
          <span>{deliberationOpen ? 'Hide deliberation' : 'Show deliberation'}</span>
        </button>
      )}
      {error && (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
      {savingToNotion && <SaveToNotionDialog turn={turn} conversationId={conversationId} onClose={() => setSavingToNotion(false)} />}
    </div>
  );
}
