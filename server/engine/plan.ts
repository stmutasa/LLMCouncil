import { randomUUID } from 'node:crypto';
import { DEFAULT_PROTOCOL_ID, LIMITS, roundTitle } from '../../shared/defaults';
import { parseMentions } from '../../shared/mentions';
import type {
  ArbiterResult,
  MemberConfig,
  MemberResponse,
  MemberSnapshot,
  RoundConfig,
  RoundResult,
  Settings,
  Turn,
} from '../../shared/types';
import type { StoredTurnLibrary } from './libraryPhase';
import { resolveRole } from './prompts';

/** A request that cannot become a turn; the HTTP layer answers 400 with the message. */
export class TurnPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnPlanError';
  }
}

export interface TurnPlan {
  turn: Turn;
  /** The question as sent to models (mentions removed). */
  question: string;
  /** Members taking part, in settings order. */
  participants: MemberConfig[];
  /** Round configurations, parallel to turn.rounds. */
  rounds: RoundConfig[];
  /** Library documents the user attached, in the order given. */
  attachmentIds: string[];
}

const DIRECT_ROUND: RoundConfig = {
  id: 'direct',
  type: 'answer',
  title: '',
  instructions: '',
  anonymize: false,
  includeSelf: false,
};

function emptyCall(): Omit<MemberResponse, 'memberId' | 'ranking'> {
  return {
    status: 'pending',
    text: '',
    activity: '',
    error: null,
    startedAt: null,
    durationMs: null,
    model: null,
    billing: 'unknown',
  };
}

export function snapshotMember(m: MemberConfig, providerLabel: string): MemberSnapshot {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    providerLabel,
    model: m.model,
    effort: m.effort,
    roleId: m.roleId,
    roleLabel: resolveRole(m.roleId, m.customRole)?.label ?? '',
    color: m.color,
  };
}

/** SendTurnRequest.attachments: absent, or up to LIMITS.maxAttachments strings (duplicates dropped). */
export function checkAttachments(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new TurnPlanError('"attachments" must be a list of document ids.');
  }
  const ids = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
  if (ids.length > LIMITS.maxAttachments) {
    throw new TurnPlanError(`At most ${LIMITS.maxAttachments} documents can be attached to one question.`);
  }
  if (ids.some((id) => id.length > 64)) throw new TurnPlanError('An attachment id is too long.');
  return ids;
}

/**
 * The turn's library record before the library phase runs: null when the library is not used
 * (mode off, or no enabled source) and nothing is attached.
 */
export function plannedLibrary(settings: Settings, attachmentIds: string[]): StoredTurnLibrary | null {
  const hasSources = settings.library.sources.some((s) => s.enabled);
  const searching = settings.library.mode !== 'off' && hasSources;
  if (!searching && attachmentIds.length === 0) return null;
  return {
    mode: settings.library.mode,
    status: 'pending',
    queries: [],
    plannerNote: '',
    excerpts: [],
    attachments: [],
    browsableDocuments: 0,
    error: null,
    attachmentIds: [...attachmentIds],
  };
}

export function checkMessage(message: unknown): string {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new TurnPlanError('Type a message to send to the council.');
  }
  if (message.length > LIMITS.maxMessageChars) {
    throw new TurnPlanError(
      `The message is ${message.length.toLocaleString('en-US')} characters long; the limit is ${LIMITS.maxMessageChars.toLocaleString('en-US')}.`,
    );
  }
  return message;
}

/**
 * Builds the complete turn up front, every round and response present in 'pending' state, so the
 * first snapshot already shows the whole plan.
 */
export function planTurn(
  message: string,
  settings: Settings,
  providerLabel: (id: string) => string,
  now = new Date(),
  attachmentIds: string[] = [],
): TurnPlan {
  checkMessage(message);
  const attachments = checkAttachments(attachmentIds);
  const mentions = parseMentions(message, settings.members);
  const participants =
    mentions.memberIds.length > 0
      ? settings.members.filter((m) => mentions.memberIds.includes(m.id))
      : settings.members.filter((m) => m.enabled);
  if (participants.length === 0) throw new TurnPlanError('Enable at least one council member.');
  const question = mentions.cleaned.trim();
  if (!question) throw new TurnPlanError('Add a question after the @mention.');

  const direct = participants.length === 1;
  const protocol =
    settings.protocols.find((p) => p.id === settings.activeProtocolId) ??
    settings.protocols.find((p) => p.id === DEFAULT_PROTOCOL_ID) ??
    settings.protocols[0];
  if (!direct && !protocol) throw new TurnPlanError('No protocol is configured.');
  const rounds = direct ? [DIRECT_ROUND] : protocol!.rounds.map((r) => structuredClone(r));

  const roundResults: RoundResult[] = rounds.map((r, index) => ({
    index,
    type: r.type,
    title: roundTitle(r),
    instructions: r.instructions,
    anonymize: r.anonymize,
    includeSelf: r.includeSelf,
    status: 'pending',
    labels: {},
    responses: participants.map((m) => ({ ...emptyCall(), memberId: m.id, ranking: null })),
    leaderboard: null,
  }));

  const arbiter: ArbiterResult | null = direct
    ? null
    : {
        ...emptyCall(),
        name: settings.arbiter.name.trim(),
        provider: settings.arbiter.provider,
        providerLabel: providerLabel(settings.arbiter.provider),
        configuredModel: settings.arbiter.model,
        effort: settings.arbiter.effort,
        analysisEnabled: settings.arbiter.analysis,
      };

  const turn: Turn = {
    id: randomUUID(),
    createdAt: now.toISOString(),
    userMessage: message,
    mode: direct ? 'direct' : 'council',
    status: 'running',
    error: null,
    members: participants.map((m) => snapshotMember(m, providerLabel(m.provider))),
    protocolName: direct ? 'Direct answer' : protocol!.name,
    councilRules: settings.councilRules,
    webSearch: settings.webSearch,
    rounds: roundResults,
    arbiter,
    analysisText: '',
    library: plannedLibrary(settings, attachments),
    finalText: '',
    finalSource: { kind: 'none', name: '', memberId: null },
    finishedAt: null,
  };
  return { turn, question, participants, rounds, attachmentIds: attachments };
}
