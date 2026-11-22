import { createHash } from 'node:crypto';
import { parseMentions } from '../../shared/mentions';
import type {
  Conversation,
  LibraryDocument,
  RunEvent,
  Settings,
  SourceExcerpt,
  Turn,
  TurnAttachment,
  TurnLibrary,
} from '../../shared/types';
import { combineQueries, runPlanner } from '../library/planner';
import { cutAtBoundary, renderParts } from '../library/render';
import type { FoundPassage } from '../library/search';
import type { Part } from '../library/types';
import { withoutFinalPeriod } from '../util/text';
import type { LibraryPromptMaterial } from './prompts';
import type { ProviderSource } from './orchestrator';

/**
 * An excerpt as stored on a turn: the contract fields plus `key`, which recognises the same
 * passage (same document, same chunks, same text) in a later turn so it keeps its citation id.
 */
export interface StoredExcerpt extends SourceExcerpt {
  key?: string;
}

/** A turn's library record as stored: `attachmentIds` keeps what was asked for, for regenerate. */
export interface StoredTurnLibrary extends TurnLibrary {
  attachmentIds?: string[];
  excerpts: StoredExcerpt[];
}

/** What the library phase needs from the library (server/library/library.ts implements it). */
export interface LibraryAccess {
  /** Searchable (status ok) documents in the given sources. */
  searchableCount(sourceIds: string[]): number;
  search(queries: string[], opts: { budgetChars: number; sourceIds: string[]; signal?: AbortSignal }): Promise<FoundPassage[]>;
  /** A document of a source that still exists in the settings; null otherwise. */
  document(id: string): LibraryDocument | null;
  readParts(id: string): Promise<Part[] | null>;
  /** Brings the browse mirror up to date (repairing changes) and returns where it is. */
  prepareBrowse(signal?: AbortSignal): Promise<{ dir: string; documents: number }>;
}

/** The library material of a running turn: what prompts show, and where browsing CLIs run. */
export interface TurnLibraryMaterial extends LibraryPromptMaterial {
  browseDir: string | null;
}

export const BUDGET_USED = 'Not included: the attachment budget was already used by the documents before it.';
export const CUT_MARKER = '[… cut: the document is longer than the attachment limit]';
export const STOPPED_DURING_LIBRARY = 'Stopped before the library was searched.';
const UNKNOWN_DOCUMENT = 'This document is no longer in the library.';
const UNKNOWN_TITLE = 'Unknown document';

function abortError(): Error {
  const err = new Error('Stopped.');
  err.name = 'AbortError';
  return err;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Stable identity of a passage: document, chunk range and a hash of its text. */
export function excerptKey(p: { documentId: string; partIndex: number; firstChunk: number; lastChunk: number; text: string }): string {
  const hash = createHash('sha1').update(p.text).digest('hex').slice(0, 12);
  return `${p.documentId}:${p.partIndex}:${p.firstChunk}-${p.lastChunk}:${hash}`;
}

/** Excerpts and attachments of the turns before `turnId`, oldest first. */
export function earlierLibraries(conversation: Conversation, turnId: string): StoredTurnLibrary[] {
  const out: StoredTurnLibrary[] = [];
  for (const t of conversation.turns) {
    if (t.id === turnId) break;
    if (t.library) out.push(t.library as StoredTurnLibrary);
  }
  return out;
}

function idNumber(id: string, prefix: 'S' | 'D'): number {
  const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
  return m ? Number(m[1]) : 0;
}

/**
 * Gives every excerpt and attachment its citation id. One that matches an earlier turn's
 * (same passage key, or same attached document) keeps that id; new ones continue the
 * conversation's numbering, S and D counted separately. Excerpts that already carry an id (an
 * earlier passage the question mentions) keep it.
 */
export function assignCitationIds(earlier: StoredTurnLibrary[], excerpts: StoredExcerpt[], attachments: TurnAttachment[]): void {
  const byKey = new Map<string, string>();
  const byDoc = new Map<string, string>();
  let maxS = 0;
  let maxD = 0;
  for (const lib of earlier) {
    for (const e of lib.excerpts) {
      maxS = Math.max(maxS, idNumber(e.id, 'S'));
      if (e.key && !byKey.has(e.key)) byKey.set(e.key, e.id);
    }
    for (const a of lib.attachments) {
      maxD = Math.max(maxD, idNumber(a.id, 'D'));
      if (!byDoc.has(a.documentId)) byDoc.set(a.documentId, a.id);
    }
  }
  const usedS = new Set(excerpts.filter((e) => e.id).map((e) => e.id));
  for (const e of excerpts) {
    if (e.id) continue;
    const reuse = e.key ? byKey.get(e.key) : undefined;
    if (reuse && !usedS.has(reuse)) {
      e.id = reuse;
    } else {
      // Skip numbers taken in this turn by mentioned passages.
      do maxS++;
      while (usedS.has(`S${maxS}`));
      e.id = `S${maxS}`;
    }
    usedS.add(e.id);
  }
  const usedD = new Set<string>();
  for (const a of attachments) {
    const reuse = byDoc.get(a.documentId);
    if (reuse && !usedD.has(reuse)) {
      a.id = reuse;
    } else {
      maxD++;
      a.id = `D${maxD}`;
    }
    usedD.add(a.id);
  }
}

/** Earlier passages the question refers to by id ("[S7]" or "S7"), from the conversation's turns. */
export function mentionedExcerpts(question: string, earlier: StoredTurnLibrary[]): StoredExcerpt[] {
  const ids = new Set([...question.matchAll(/\bS(\d+)\b/g)].map((m) => `S${Number(m[1])}`));
  if (ids.size === 0) return [];
  const out: StoredExcerpt[] = [];
  const seen = new Set<string>();
  for (const lib of earlier) {
    for (const e of lib.excerpts) {
      if (!ids.has(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(structuredClone(e));
    }
  }
  return out.sort((a, b) => idNumber(a.id, 'S') - idNumber(b.id, 'S'));
}

interface AttachmentOutcome {
  attachment: TurnAttachment;
  /** The text shown in prompts; null when the document is not included. */
  text: string | null;
}

/**
 * Loads the attached documents and shares the attachment budget between them in the order
 * given: each gets what it needs while the budget lasts; one that does not fit is cut at a part
 * or paragraph boundary, and those after the budget ran out are not included.
 */
export async function loadAttachments(
  ids: string[],
  settings: Settings,
  library: Pick<LibraryAccess, 'document' | 'readParts'>,
  signal: AbortSignal,
): Promise<AttachmentOutcome[]> {
  const sources = new Map(settings.library.sources.map((s) => [s.id, s]));
  let remaining = settings.library.attachmentChars;
  const out: AttachmentOutcome[] = [];
  for (const id of ids) {
    if (signal.aborted) throw abortError();
    const doc = library.document(id);
    const source = doc ? sources.get(doc.sourceId) : undefined;
    const attachment: TurnAttachment = {
      id: '',
      documentId: id,
      title: doc?.title ?? UNKNOWN_TITLE,
      sourceName: source?.name ?? '',
      location: doc?.location ?? '',
      url: doc?.url ?? null,
      chars: 0,
      truncated: false,
      problem: '',
    };
    const fail = (problem: string) => {
      attachment.problem = problem;
      out.push({ attachment, text: null });
    };
    if (!doc || !source) {
      fail(UNKNOWN_DOCUMENT);
      continue;
    }
    if (!source.enabled) {
      fail(`Its source, “${source.name}”, is turned off in Settings → Library.`);
      continue;
    }
    if (doc.status !== 'ok') {
      fail(`It has no readable text: ${doc.detail || 'it could not be read.'}`);
      continue;
    }
    const parts = await library.readParts(id);
    if (!parts) {
      fail('Its text could not be loaded. Check its source for changes to read it again.');
      continue;
    }
    const full = renderParts(parts);
    if (full.length <= remaining) {
      attachment.chars = full.length;
      remaining -= full.length;
      out.push({ attachment, text: full });
      continue;
    }
    const cut = cutAtBoundary(full, remaining - CUT_MARKER.length - 2);
    if (!cut) {
      fail(BUDGET_USED);
      remaining = 0;
      continue;
    }
    const text = `${cut}\n\n${CUT_MARKER}`;
    attachment.chars = text.length;
    attachment.truncated = true;
    remaining = 0;
    out.push({ attachment, text });
  }
  return out;
}

export interface LibraryPhaseInput {
  conversation: Conversation;
  turn: Turn;
  settings: Settings;
  library: LibraryAccess | null;
  providers: ProviderSource;
  question: string;
  attachmentIds: string[];
  signal: AbortSignal;
  emit: (event: RunEvent) => void;
}

/**
 * Gathers the turn's library material before round 1: attachments, then (search and browse
 * modes) planner and search, then the browse mirror. A failure in any step is recorded on the
 * turn and the turn carries on with what was gathered. Throws only an AbortError (stop).
 */
export async function runLibraryPhase(input: LibraryPhaseInput): Promise<TurnLibraryMaterial | null> {
  const lib = input.turn.library as StoredTurnLibrary | null;
  if (!lib) return null;
  const { settings, signal } = input;
  lib.status = 'running';
  input.emit({ type: 'library.start' });

  const errors: string[] = [];
  const earlier = earlierLibraries(input.conversation, input.turn.id);
  const gathered: Gathered = { outcomes: [], excerpts: [], searched: false, browseDocuments: 0, browseDir: null };
  try {
    await gather(input, lib, earlier, gathered, errors);
  } catch (err) {
    if (signal.aborted) {
      lib.status = 'error';
      lib.error = STOPPED_DURING_LIBRARY;
      input.emit({ type: 'library.end', library: structuredClone(lib) });
      throw abortError();
    }
    // Nothing in the library phase may fail the turn; it continues with what was gathered.
    console.error('[library] The library phase failed:', err);
    errors.push(`The library could not be used: ${withoutFinalPeriod(message(err))}.`);
  }

  const attachments = gathered.outcomes.map((o) => o.attachment);
  assignCitationIds(earlier, gathered.excerpts, attachments);
  lib.excerpts = gathered.excerpts;
  lib.attachments = attachments;
  lib.browsableDocuments = gathered.browseDocuments;
  lib.status = errors.length > 0 ? 'error' : 'done';
  lib.error = errors.length > 0 ? errors.join(' ') : null;

  const material: TurnLibraryMaterial = {
    searched: gathered.searched,
    excerpts: gathered.excerpts.map((e) => ({ ...e })),
    attachments: [],
    notIncluded: [],
    browseDocuments: gathered.browseDocuments,
    browseDir: gathered.browseDir,
  };
  for (const o of gathered.outcomes) {
    if (o.text !== null) {
      material.attachments.push({
        id: o.attachment.id,
        title: o.attachment.title,
        sourceName: o.attachment.sourceName,
        location: o.attachment.location,
        text: o.text,
        truncated: o.attachment.truncated,
      });
    } else {
      material.notIncluded.push({ title: o.attachment.title, problem: o.attachment.problem });
    }
  }
  input.emit({ type: 'library.end', library: structuredClone(lib) });
  return material;
}

interface Gathered {
  outcomes: AttachmentOutcome[];
  excerpts: StoredExcerpt[];
  searched: boolean;
  browseDocuments: number;
  browseDir: string | null;
}

/** The steps of the phase. Each step's failure is recorded in `errors`; only a stop throws. */
async function gather(
  input: LibraryPhaseInput,
  lib: StoredTurnLibrary,
  earlier: StoredTurnLibrary[],
  out: Gathered,
  errors: string[],
): Promise<void> {
  const { settings, signal } = input;
  const library = input.library;
  if (!library) {
    errors.push('The document library is not available.');
    return;
  }
  const step = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      if (signal.aborted) throw abortError();
      errors.push(`${what}: ${withoutFinalPeriod(message(err))}.`);
    }
  };
  const sourceIds = settings.library.sources.filter((s) => s.enabled).map((s) => s.id);
  const sourceName = new Map(settings.library.sources.map((s) => [s.id, s.name]));

  if (input.attachmentIds.length > 0) {
    await step('The attached documents could not be loaded', async () => {
      out.outcomes = await loadAttachments(input.attachmentIds, settings, library, signal);
    });
  }

  if (lib.mode !== 'off' && library.searchableCount(sourceIds) > 0) {
    const planned = await plan(input, lib);
    const queries = combineQueries(input.question, planned);
    lib.queries = queries;
    out.excerpts.push(...mentionedExcerpts(input.question, earlier));
    await step('The library could not be searched', async () => {
      const found = await library.search(queries, { budgetChars: settings.library.excerptChars, sourceIds, signal });
      out.searched = true;
      const keys = new Set(out.excerpts.map((e) => e.key).filter(Boolean));
      for (const p of found) {
        const doc = library.document(p.documentId);
        if (!doc) continue;
        const key = excerptKey(p);
        if (keys.has(key)) continue;
        keys.add(key);
        out.excerpts.push({
          id: '',
          documentId: p.documentId,
          title: doc.title,
          sourceName: sourceName.get(doc.sourceId) ?? '',
          location: doc.location,
          part: p.part,
          url: doc.url,
          text: p.text,
          key,
        });
      }
    });
  }

  if (lib.mode === 'browse') {
    await step('The documents could not be prepared for browsing', async () => {
      const browse = await library.prepareBrowse(signal);
      out.browseDocuments = browse.documents;
      out.browseDir = browse.documents > 0 ? browse.dir : null;
    });
  }
}

/** The planner's queries; [] (with a note on the turn) when planning is off, fails or finds none. */
async function plan(input: LibraryPhaseInput, lib: StoredTurnLibrary): Promise<string[]> {
  const { settings, signal } = input;
  const planner = settings.library.planner;
  if (!planner.enabled) return [];
  const label = input.providers.label?.(planner.provider, settings) ?? planner.provider;
  try {
    const provider = input.providers.get(planner.provider, settings);
    if (!provider) throw new Error(`Provider '${planner.provider}' is not available.`);
    const earlierQuestions: string[] = [];
    for (const t of input.conversation.turns) {
      if (t.id === input.turn.id) break;
      earlierQuestions.push(parseMentions(t.userMessage, t.members).cleaned);
    }
    const planned = await runPlanner(provider, {
      model: planner.model,
      effort: planner.effort,
      question: input.question,
      earlierQuestions,
      signal,
    });
    if (planned.length === 0) {
      lib.plannerNote = `The search planner (${label}) suggested no searches. Searched with the question as typed.`;
    }
    return planned;
  } catch (err) {
    if (signal.aborted) throw abortError();
    lib.plannerNote = `The search planner (${label}) failed: ${withoutFinalPeriod(message(err))}. Searched with the question as typed.`;
    return [];
  }
}
