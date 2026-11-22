import type {
  ArbiterResult,
  MemberResponse,
  MemberSnapshot,
  RoundResult,
  RoundType,
  SourceExcerpt,
  Turn,
  TurnAttachment,
  TurnLibrary,
} from '../../../shared/types';

/** Test data builders shared by the unit tests. */

export function member(id: string, name = id, color = '#123456'): MemberSnapshot {
  return { id, name, provider: 'mock', providerLabel: 'Demo', model: '', effort: '', roleId: 'none', roleLabel: '', color };
}

export function response(memberId: string, patch: Partial<MemberResponse> = {}): MemberResponse {
  return {
    memberId,
    status: 'pending',
    text: '',
    activity: '',
    error: null,
    startedAt: null,
    durationMs: null,
    model: null,
    billing: 'unknown',
    ranking: null,
    ...patch,
  };
}

export function round(index: number, type: RoundType, memberIds: string[], patch: Partial<RoundResult> = {}): RoundResult {
  return {
    index,
    type,
    title: '',
    instructions: '',
    anonymize: false,
    includeSelf: false,
    status: 'pending',
    labels: {},
    responses: memberIds.map((id) => response(id)),
    leaderboard: null,
    ...patch,
  };
}

export function arbiter(patch: Partial<ArbiterResult> = {}): ArbiterResult {
  return {
    status: 'pending',
    text: '',
    activity: '',
    error: null,
    startedAt: null,
    durationMs: null,
    model: null,
    billing: 'unknown',
    name: 'Judge',
    provider: 'mock',
    providerLabel: 'Demo',
    configuredModel: '',
    effort: '',
    analysisEnabled: true,
    ...patch,
  };
}

export function councilTurn(patch: Partial<Turn> = {}): Turn {
  const ids = ['a', 'b', 'c'];
  return {
    id: 't1',
    createdAt: '2026-01-01T10:00:00.000Z',
    userMessage: 'Question?',
    mode: 'council',
    status: 'running',
    error: null,
    members: ids.map((id) => member(id, id.toUpperCase())),
    protocolName: 'Council',
    councilRules: '',
    webSearch: false,
    rounds: [round(0, 'answer', ids), round(1, 'review', ids, { anonymize: true })],
    arbiter: arbiter(),
    analysisText: '',
    library: null,
    finalText: '',
    finalSource: { kind: 'none', name: '', memberId: null },
    finishedAt: null,
    ...patch,
  };
}

export function directTurn(patch: Partial<Turn> = {}): Turn {
  return {
    ...councilTurn(),
    mode: 'direct',
    members: [member('a', 'A')],
    rounds: [round(0, 'answer', ['a'])],
    arbiter: null,
    ...patch,
  };
}

export function excerpt(id: string, documentId: string, patch: Partial<SourceExcerpt> = {}): SourceExcerpt {
  return {
    id,
    documentId,
    title: `${documentId}.pdf`,
    sourceName: 'Drive',
    location: 'Contracts',
    part: 'p. 1',
    url: null,
    text: `Text of ${id}`,
    ...patch,
  };
}

export function attachment(id: string, documentId: string, patch: Partial<TurnAttachment> = {}): TurnAttachment {
  return {
    id,
    documentId,
    title: `${documentId}.docx`,
    sourceName: 'Drive',
    location: '',
    url: null,
    chars: 1000,
    truncated: false,
    problem: '',
    ...patch,
  };
}

export function library(patch: Partial<TurnLibrary> = {}): TurnLibrary {
  return {
    mode: 'search',
    status: 'done',
    queries: [],
    plannerNote: '',
    excerpts: [],
    attachments: [],
    browsableDocuments: 0,
    error: null,
    ...patch,
  };
}
