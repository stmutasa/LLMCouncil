import { Check, ChevronDown } from 'lucide-react';
import { memo, useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { MemberResponse, MemberSnapshot, RoundResult, Turn } from '../../../shared/types';
import { formatDuration } from '../lib/format';
import {
  answersShownTo,
  deliberationSummary,
  displayRoundTitle,
  FALLBACK_MEMBER_COLOR,
  sortedLabels,
} from '../lib/turn';
import { useFollowing } from '../hooks/followContext';
import { useNow } from '../hooks/useNow';
import type { StreamState } from '../store';
import { Disclosure } from './Disclosure';
import { BillingBadge } from './BillingBadge';
import { CallStatusIcon, MemberDot, Spinner, StoppedIcon, WarningIcon } from './icons';
import { Markdown } from './Markdown';

function lookup(members: MemberSnapshot[], id: string): MemberSnapshot {
  return (
    members.find((m) => m.id === id) ?? {
      id,
      name: id,
      provider: '',
      providerLabel: '',
      model: '',
      effort: '',
      roleId: 'none',
      roleLabel: '',
      color: FALLBACK_MEMBER_COLOR,
    }
  );
}

interface DeliberationProps {
  turn: Turn;
  open: boolean;
  onToggle: () => void;
  streamState: StreamState | null;
}

/** The council's "work shown": a header summarising the run, and one section per round. */
export function Deliberation({ turn, open, onToggle, streamState }: DeliberationProps) {
  const contentId = useId();
  const running = turn.status === 'running';
  // null = automatic: only the active round is expanded (all of them once the turn is over).
  // The first interaction freezes the current layout and hands control to the user.
  const [manualRounds, setManualRounds] = useState<Record<number, boolean> | null>(null);
  // While running, follow the round in progress; between rounds and during the verdict keep
  // the most recent finished round open rather than collapsing everything.
  const activeIndex =
    turn.rounds.find((r) => r.status === 'running')?.index ?? turn.rounds.filter((r) => r.status === 'done').at(-1)?.index ?? null;

  const autoOpen = (round: RoundResult) => (running ? round.index === activeIndex : true);

  // Scrolled up reading? Then a new round starting must not collapse the one being read:
  // freeze the layout as it was, exactly as if the user had interacted.
  const following = useFollowing();
  const [prevActive, setPrevActive] = useState(activeIndex);
  if (activeIndex !== prevActive) {
    setPrevActive(activeIndex);
    if (!following && manualRounds === null && running) {
      const snapshot: Record<number, boolean> = {};
      for (const r of turn.rounds) snapshot[r.index] = r.index === prevActive;
      setManualRounds(snapshot);
    }
  }
  const isRoundOpen = (round: RoundResult) => (manualRounds ? manualRounds[round.index] ?? false : autoOpen(round));

  const roundsRef = useRef(turn.rounds);
  roundsRef.current = turn.rounds;
  const autoRef = useRef(autoOpen);
  autoRef.current = autoOpen;

  const freeze = useCallback(() => {
    setManualRounds((current) => {
      if (current) return current;
      const snapshot: Record<number, boolean> = {};
      for (const r of roundsRef.current) snapshot[r.index] = autoRef.current(r);
      return snapshot;
    });
  }, []);

  const toggleRound = useCallback((index: number) => {
    setManualRounds((current) => {
      const base: Record<number, boolean> = current ?? {};
      if (!current) for (const r of roundsRef.current) base[r.index] = autoRef.current(r);
      return { ...base, [index]: !base[index] };
    });
  }, []);

  return (
    <section className={`deliberation${open ? ' open' : ''}`} aria-label="Deliberation">
      <button type="button" className="deliberation-header" aria-expanded={open} aria-controls={contentId} onClick={onToggle}>
        <DeliberationHeaderContent turn={turn} />
        <ChevronDown size={16} className="deliberation-chevron" aria-hidden="true" />
      </button>
      {streamState === 'reconnecting' && (
        <p className="stream-note" role="status">
          <Spinner size={13} /> Connection to the server lost. Reconnecting…
        </p>
      )}
      <div id={contentId} className="deliberation-body" hidden={!open} onPointerDown={freeze} onKeyDown={freeze}>
        {open &&
          turn.rounds.map((round, pos) => (
            <RoundSection
              key={round.index}
              round={round}
              members={turn.members}
              position={pos}
              open={isRoundOpen(round)}
              onToggle={toggleRound}
            />
          ))}
      </div>
    </section>
  );
}

function DeliberationHeaderContent({ turn }: { turn: Turn }) {
  const running = turn.status === 'running';
  const now = useNow(running);
  const summary = deliberationSummary(turn, now);
  let icon;
  switch (summary.tone) {
    case 'running':
      icon = <Spinner size={15} />;
      break;
    case 'done':
      icon = <Check size={15} aria-hidden="true" className="status-done" />;
      break;
    case 'stopped':
      icon = <StoppedIcon size={15} />;
      break;
    default:
      icon = <WarningIcon size={15} />;
  }
  return (
    <span className="deliberation-header-content">
      <span className="deliberation-icon">{icon}</span>
      <span className="deliberation-summary">{summary.text}</span>
      {summary.time && <span className="deliberation-time">{summary.time}</span>}
    </span>
  );
}

const ROUND_STATUS_LABEL: Record<RoundResult['status'], string> = {
  pending: 'Waiting',
  running: 'In progress',
  done: 'Done',
  skipped: 'Skipped',
};

interface RoundSectionProps {
  round: RoundResult;
  members: MemberSnapshot[];
  position: number;
  open: boolean;
  onToggle: (index: number) => void;
}

const RoundSection = memo(function RoundSection({ round, members, position, open, onToggle }: RoundSectionProps) {
  const bodyId = useId();
  const [rulesOpen, setRulesOpen] = useState(false);
  const labels = sortedLabels(round.labels);
  return (
    <section className={`round${open ? ' open' : ''}`} aria-label={`Round ${position + 1}`}>
      <div className="round-header">
        <button type="button" className="round-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(round.index)}>
          <ChevronDown size={14} className="round-chevron" aria-hidden="true" />
          <span className="round-title">
            Round {position + 1} · {displayRoundTitle(round)}
          </span>
        </button>
        <span className={`status-chip ${round.status}`}>
          {round.status === 'running' && <Spinner size={11} />}
          {ROUND_STATUS_LABEL[round.status]}
        </span>
      </div>
      <div id={bodyId} className="round-body" hidden={!open}>
        {open && (
          <>
            {round.instructions.trim() && (
              <Disclosure open={rulesOpen} onToggle={() => setRulesOpen((v) => !v)} summary="Rules for this round" className="round-rules">
                <p className="pre-wrap">{round.instructions}</p>
              </Disclosure>
            )}
            {round.type !== 'answer' && labels.length > 0 && <LabelLegend round={round} members={members} />}
            {round.type === 'review' && round.leaderboard && round.leaderboard.length > 0 && (
              <Leaderboard round={round} members={members} />
            )}
            {round.responses.length > 0 ? (
              <MemberTabs round={round} members={members} />
            ) : (
              <p className="muted small">No member took part in this round.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
});

function LabelLegend({ round, members }: { round: RoundResult; members: MemberSnapshot[] }) {
  const labels = sortedLabels(round.labels);
  return (
    <div className="legend">
      <ul className="legend-list" aria-label="Response labels">
        {labels.map(([label, memberId]) => {
          const m = lookup(members, memberId);
          return (
            <li key={label}>
              <span className="legend-label">Response {label}</span>
              <MemberDot color={m.color} />
              <span>{m.name}</span>
            </li>
          );
        })}
      </ul>
      {round.anonymize && (
        <p className="legend-note">{round.type === 'review' ? 'Reviewers saw labels only.' : 'Members saw labels only.'}</p>
      )}
    </div>
  );
}

function Leaderboard({ round, members }: { round: RoundResult; members: MemberSnapshot[] }) {
  const entries = round.leaderboard ?? [];
  return (
    <div className="table-wrap leaderboard-wrap" tabIndex={0} role="region" aria-label="Peer ranking">
      <table className="leaderboard">
        <caption className="visually-hidden">Peer ranking, best first</caption>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Member</th>
            <th scope="col" className="num">
              Avg. rank
            </th>
            <th scope="col" className="num">
              Votes
            </th>
            <th scope="col" className="num">
              First place
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => {
            const m = lookup(members, e.memberId);
            return (
              <tr key={e.label}>
                <td>{i + 1}</td>
                <td>
                  <span className="leaderboard-member">
                    <MemberDot color={m.color} />
                    <span>{m.name}</span>
                    <span className="muted">Response {e.label}</span>
                  </span>
                </td>
                <td className="num">{e.averageRank.toFixed(2)}</td>
                <td className="num">{e.votes}</td>
                <td className="num">{e.firstPlaceVotes}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MemberTabs({ round, members }: { round: RoundResult; members: MemberSnapshot[] }) {
  const baseId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const responses = round.responses;
  const current = responses.find((r) => r.memberId === selected) ?? responses[0]!;

  const select = (memberId: string, focus: boolean) => {
    setSelected(memberId);
    if (focus) {
      const el = tabRefs.current.get(memberId);
      el?.focus();
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const index = responses.findIndex((r) => r.memberId === current.memberId);
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % responses.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + responses.length) % responses.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = responses.length - 1;
    if (next === -1) return;
    e.preventDefault();
    select(responses[next]!.memberId, true);
  };

  const tabId = (memberId: string) => `${baseId}-tab-${memberId}`;
  const panelId = `${baseId}-panel`;

  return (
    <div className="member-tabs">
      <div className="tab-strip" role="tablist" aria-label="Council members" onKeyDown={onKeyDown}>
        {responses.map((r) => {
          const m = lookup(members, r.memberId);
          const isSelected = r.memberId === current.memberId;
          return (
            <button
              key={r.memberId}
              ref={(el) => {
                if (el) tabRefs.current.set(r.memberId, el);
                else tabRefs.current.delete(r.memberId);
              }}
              type="button"
              role="tab"
              id={tabId(r.memberId)}
              aria-selected={isSelected}
              aria-controls={panelId}
              tabIndex={isSelected ? 0 : -1}
              className={`tab${isSelected ? ' selected' : ''}`}
              onClick={() => select(r.memberId, false)}
            >
              <MemberDot color={m.color} />
              <span className="tab-name">{m.name}</span>
              <CallStatusIcon status={r.status} size={13} />
            </button>
          );
        })}
      </div>
      <div className="tab-panel" role="tabpanel" id={panelId} aria-labelledby={tabId(current.memberId)} tabIndex={0}>
        <MemberPanel response={current} round={round} members={members} />
      </div>
    </div>
  );
}

const MemberPanel = memo(function MemberPanel({
  response,
  round,
  members,
}: {
  response: MemberResponse;
  round: RoundResult;
  members: MemberSnapshot[];
}) {
  const member = lookup(members, response.memberId);
  const hasText = response.text.trim().length > 0;
  return (
    <div className="member-panel">
      {member.roleLabel && <p className="member-role">Role: {member.roleLabel}</p>}
      {response.status === 'pending' && <p className="muted small">Waiting to start…</p>}
      {response.status === 'running' && (
        <p className="activity" role="status">
          <Spinner size={13} />
          <span>{response.activity || (hasText ? 'Writing…' : 'Working…')}</span>
        </p>
      )}
      {response.status === 'skipped' && (
        <p className="muted small">{hasText ? 'Cut short before finishing. Partial text:' : 'Skipped.'}</p>
      )}
      {hasText && <Markdown text={response.text} className="member-text" />}
      {response.status === 'error' && (
        <div className="error-card" role="alert">
          <WarningIcon size={15} />
          <p className="pre-wrap">{response.error || 'This call failed without an error message.'}</p>
        </div>
      )}
      {round.type === 'review' && response.status === 'done' && answersShownTo(round, response.memberId) >= 2 && (
        <ExtractedRanking response={response} round={round} members={members} />
      )}
      {(response.status === 'done' || response.status === 'error') && <CallMeta response={response} />}
    </div>
  );
});

function ExtractedRanking({ response, round, members }: { response: MemberResponse; round: RoundResult; members: MemberSnapshot[] }) {
  if (!response.ranking || response.ranking.length === 0) {
    return <p className="ranking-row muted small">No ranking could be read from this review.</p>;
  }
  return (
    <div className="ranking-row">
      <span className="ranking-label">Extracted ranking</span>
      <ol className="ranking-list">
        {response.ranking.map((label) => {
          const memberId = round.labels[label];
          const m = memberId ? lookup(members, memberId) : null;
          return (
            <li key={label}>
              {m ? (
                <>
                  <MemberDot color={m.color} /> {m.name} <span className="muted">(Response {label})</span>
                </>
              ) : (
                `Response ${label}`
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function CallMeta({ response }: { response: { model: string | null; durationMs: number | null; billing: MemberResponse['billing'] } }) {
  const parts: string[] = [];
  if (response.model) parts.push(response.model);
  if (response.durationMs !== null) parts.push(formatDuration(response.durationMs));
  if (parts.length === 0 && response.billing === 'unknown') return null;
  return (
    <p className="call-meta">
      {parts.join(' · ')}
      <BillingBadge billing={response.billing} />
    </p>
  );
}
