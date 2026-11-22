import { z } from 'zod';
import type { Conversation } from '../shared/types';

/**
 * The shape every conversation file must have before the rest of the server touches it. Files
 * can be edited by hand, truncated by a crash or written by another version, and code that
 * assumes `turn.rounds` or `turn.finalText` exists must never see one that lacks them.
 * Unknown extra fields are kept.
 */

const billing = z.enum(['subscription', 'api-key', 'unknown']);

const call = {
  status: z.enum(['pending', 'running', 'done', 'error', 'skipped']),
  text: z.string(),
  activity: z.string(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  model: z.string().nullable(),
  billing,
};

const memberResponse = z.looseObject({
  ...call,
  memberId: z.string(),
  ranking: z.array(z.string()).nullable(),
});

const leaderboardEntry = z.looseObject({
  memberId: z.string(),
  label: z.string(),
  averageRank: z.number(),
  votes: z.number(),
  firstPlaceVotes: z.number(),
});

const round = z.looseObject({
  index: z.number(),
  type: z.enum(['answer', 'review', 'revise']),
  title: z.string(),
  instructions: z.string(),
  anonymize: z.boolean(),
  includeSelf: z.boolean(),
  status: z.enum(['pending', 'running', 'done', 'skipped']),
  labels: z.record(z.string(), z.string()),
  responses: z.array(memberResponse),
  leaderboard: z.array(leaderboardEntry).nullable(),
});

const memberSnapshot = z.looseObject({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  providerLabel: z.string(),
  model: z.string(),
  effort: z.string(),
  roleId: z.string(),
  roleLabel: z.string(),
  color: z.string(),
});

const arbiter = z.looseObject({
  ...call,
  name: z.string(),
  provider: z.string(),
  providerLabel: z.string(),
  configuredModel: z.string(),
  effort: z.string(),
  analysisEnabled: z.boolean(),
});

const excerpt = z.looseObject({
  id: z.string(),
  documentId: z.string(),
  title: z.string(),
  sourceName: z.string(),
  location: z.string(),
  part: z.string(),
  url: z.string().nullable(),
  text: z.string(),
});

const attachment = z.looseObject({
  id: z.string(),
  documentId: z.string(),
  title: z.string(),
  sourceName: z.string(),
  location: z.string(),
  url: z.string().nullable(),
  chars: z.number(),
  truncated: z.boolean(),
  problem: z.string(),
});

const turnLibrary = z.looseObject({
  mode: z.enum(['off', 'search', 'browse']),
  status: z.enum(['pending', 'running', 'done', 'error']),
  queries: z.array(z.string()),
  plannerNote: z.string(),
  excerpts: z.array(excerpt),
  attachments: z.array(attachment),
  browsableDocuments: z.number(),
  error: z.string().nullable(),
});

const turn = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  userMessage: z.string(),
  mode: z.enum(['council', 'direct']),
  status: z.enum(['running', 'complete', 'error', 'stopped', 'interrupted']),
  error: z.string().nullable(),
  members: z.array(memberSnapshot),
  protocolName: z.string(),
  councilRules: z.string(),
  webSearch: z.boolean(),
  rounds: z.array(round),
  arbiter: arbiter.nullable(),
  analysisText: z.string(),
  // Files written before the library existed have no such field; a damaged one is dropped rather
  // than making the whole conversation unreadable.
  library: turnLibrary.nullable().optional().catch(null).transform((v) => v ?? null),
  finalText: z.string(),
  finalSource: z.looseObject({
    kind: z.enum(['arbiter', 'member', 'fallback', 'none']),
    name: z.string(),
    memberId: z.string().nullable(),
  }),
  finishedAt: z.string().nullable(),
});

const conversation = z.looseObject({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  turns: z.array(turn),
});

/** The value as a Conversation, or null when it does not have the required shape. */
export function parseConversation(value: unknown): Conversation | null {
  const result = conversation.safeParse(value);
  // Returning the parsed data as a Conversation also makes the compiler check that the schema
  // requires everything the type does.
  return result.success ? result.data : null;
}
