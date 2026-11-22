import { ARBITER_MARKER, splitArbiterOutput } from '../../shared/arbiter';
import { labelFor } from '../../shared/defaults';
import { parseMentions } from '../../shared/mentions';
import type {
  CallResult,
  Conversation,
  LeaderboardEntry,
  MemberConfig,
  MemberResponse,
  ProviderInfo,
  RoundResult,
  RunEvent,
  Settings,
  Turn,
} from '../../shared/types';
import { withoutFinalPeriod } from '../util/text';
import { isAbortError, type Provider } from '../providers/types';
import { runLibraryPhase, type LibraryAccess, type TurnLibraryMaterial } from './libraryPhase';
import type { TurnPlan } from './plan';
import {
  buildAnswerPrompt,
  buildArbiterPrompt,
  buildReviewPrompt,
  buildRevisePrompt,
  historySection,
  type HistoryTurn,
  type LabeledAnswer,
  type MemberPromptContext,
  type RoundPromptInfo,
} from './prompts';
import { buildLeaderboard, parseRanking, type ReviewerRanking } from './ranking';
import { INTERRUPTED_MESSAGE, settleOpenParts } from './turnState';

/** What the orchestrator needs from the provider registry. */
export interface ProviderSource {
  get(id: string, settings: Settings): Provider | null;
  webSearchSupport(id: string, settings: Settings): ProviderInfo['webSearch'];
  timeoutMs(id: string, settings: Settings): number;
  /** Billing mode from the last provider detection, for CLIs that do not report it per call. */
  billingHint?(id: string): ProviderInfo['billing'];
  /** Whether the provider can open library files itself; absent means 'no'. */
  browseSupport?(id: string, settings: Settings): ProviderInfo['browse'];
  /** Short label for messages ("Claude"); falls back to the id. */
  label?(id: string, settings: Settings): string;
}

/** Passed as the abort reason when the server shuts down, so the turn ends as 'interrupted'. */
export class ShutdownReason extends Error {
  constructor() {
    super('The server is shutting down.');
    this.name = 'ShutdownReason';
  }
}

/** Lets the HTTP layer ask a running turn to skip to the verdict. */
export class RunControl {
  /** 'library': the library is being searched; skipping to the verdict does not apply yet. */
  phase: 'library' | 'rounds' | 'arbiter' | 'finished';
  skipRequested = false;
  private roundController: AbortController | null = null;

  constructor(
    readonly mode: Turn['mode'],
    usesLibrary = false,
  ) {
    this.phase = usesLibrary ? 'library' : 'rounds';
  }

  canSkip(): boolean {
    return this.mode === 'council' && this.phase === 'rounds' && !this.skipRequested;
  }

  /** false when skipping is not possible now (direct mode, or the arbiter already started). */
  requestSkip(): boolean {
    if (!this.canSkip()) return false;
    this.skipRequested = true;
    this.roundController?.abort();
    return true;
  }

  beginRound(parent: AbortSignal): AbortSignal {
    this.roundController = new AbortController();
    if (this.skipRequested) this.roundController.abort();
    return AbortSignal.any([parent, this.roundController.signal]);
  }
}

export interface OrchestratorInput {
  /** The conversation the turn belongs to; turns other than `turn` provide the history. */
  conversation: Conversation;
  plan: TurnPlan;
  settings: Settings;
  providers: ProviderSource;
  rng: () => number;
  emit: (event: RunEvent) => void;
  /** Aborted by "stop" (or shutdown, with a ShutdownReason). */
  signal: AbortSignal;
  control: RunControl;
  /** The document library; null when the server has none (the library phase then reports it). */
  library?: LibraryAccess | null;
}

interface AnswerSet {
  id: number;
  /** label -> memberId */
  labels: Record<string, string>;
  labelOf: Map<string, string>;
  reviews: { reviewerId: string; text: string }[];
  reviewsAnonymized: boolean;
  leaderboard: LeaderboardEntry[] | null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Questions as they were sent to models, with each earlier turn's final answer. */
export function historyTurns(conversation: Conversation, currentTurnId: string): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const t of conversation.turns) {
    if (t.id === currentTurnId) break;
    if (t.status === 'running' || !t.finalText.trim()) continue;
    const lib = t.library;
    const citesLibrary = !!lib && (lib.excerpts.length > 0 || lib.attachments.some((a) => !a.problem));
    out.push({ question: parseMentions(t.userMessage, t.members).cleaned, answer: t.finalText, citesLibrary });
  }
  return out;
}

class TurnRunner {
  private readonly turn: Turn;
  private readonly participants: MemberConfig[];
  private readonly history: string;
  private readonly internal = new AbortController();
  private readonly answers = new Map<string, string>();
  private answerSet: AnswerSet | null = null;
  private nextSetId = 1;
  private latestLeaderboard: { entries: LeaderboardEntry[]; setId: number } | null = null;
  private material: TurnLibraryMaterial | null = null;

  constructor(private readonly input: OrchestratorInput) {
    this.turn = input.plan.turn;
    this.participants = input.plan.participants;
    const budget = input.settings.maxHistoryChars;
    this.history = historySection(historyTurns(input.conversation, this.turn.id), budget);
  }

  private emit(event: RunEvent): void {
    this.input.emit(event);
  }

  private get stopped(): boolean {
    return this.input.signal.aborted;
  }

  private memberById(id: string): MemberConfig {
    return this.participants.find((m) => m.id === id)!;
  }

  private webOn(providerId: string): boolean {
    return (
      this.input.settings.webSearch && this.input.providers.webSearchSupport(providerId, this.input.settings) !== 'none'
    );
  }

  private promptContext(m: MemberConfig): MemberPromptContext {
    return {
      name: m.name,
      roleId: m.roleId,
      customRole: m.customRole,
      councilSize: this.participants.length,
      mode: this.turn.mode,
      webSearch: this.webOn(m.provider),
      councilRules: this.input.settings.councilRules,
      history: this.history,
      question: this.input.plan.question,
      library: this.material,
      browse: this.browses(m.provider),
    };
  }

  /** Whether this provider's calls run in the browse mirror (browse mode, a capable CLI). */
  private browses(providerId: string): boolean {
    if (!this.material?.browseDir) return false;
    const support = this.input.providers.browseSupport?.(providerId, this.input.settings) ?? 'no';
    return support !== 'no';
  }

  private roundInfo(index: number): RoundPromptInfo {
    const r = this.turn.rounds[index]!;
    return {
      index,
      total: this.turn.rounds.length,
      title: r.title,
      instructions: r.instructions,
      anonymize: r.anonymize,
      includeSelf: r.includeSelf,
    };
  }

  /**
   * One provider call into `target`. Never throws: the outcome is recorded on `target`.
   * Returns true on success.
   */
  private async call(
    target: CallResult,
    providerId: string,
    model: string,
    effort: string,
    prompt: string,
    signal: AbortSignal,
    on: { text(text: string, replace: boolean): void; activity(label: string): void },
  ): Promise<boolean> {
    const started = Date.now();
    let open = true;
    try {
      const provider = this.input.providers.get(providerId, this.input.settings);
      if (!provider) throw new Error(`Provider '${providerId}' is not available.`);
      const out = await provider.run({
        prompt,
        model,
        effort,
        webSearch: this.webOn(providerId),
        timeoutMs: this.input.providers.timeoutMs(providerId, this.input.settings),
        signal,
        browseDir: this.browses(providerId) ? this.material!.browseDir! : undefined,
        onText: (text, replace) => {
          if (!open) return;
          target.text = replace ? text : target.text + text;
          on.text(text, replace);
        },
        onActivity: (label) => {
          if (!open || target.activity === label) return;
          target.activity = label;
          on.activity(label);
        },
      });
      target.text = out.text;
      target.model = out.model;
      target.billing =
        out.billing === 'unknown' ? (this.input.providers.billingHint?.(providerId) ?? 'unknown') : out.billing;
      target.status = 'done';
      target.error = null;
      return true;
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        target.status = 'skipped';
        target.error = null;
      } else {
        target.status = 'error';
        target.error = errorMessage(err) || 'The call failed without an error message.';
      }
      return false;
    } finally {
      open = false;
      target.activity = '';
      target.durationMs = Date.now() - started;
    }
  }

  private async memberCall(roundIndex: number, response: MemberResponse, prompt: string, signal: AbortSignal) {
    const member = this.memberById(response.memberId);
    response.status = 'running';
    response.startedAt = new Date().toISOString();
    this.emit({ type: 'member.start', round: roundIndex, memberId: member.id, startedAt: response.startedAt });
    const direct = this.turn.mode === 'direct';
    const ok = await this.call(response, member.provider, member.model, member.effort, prompt, signal, {
      text: (text, replace) => {
        if (direct) this.turn.finalText = response.text;
        this.emit({ type: 'member.delta', round: roundIndex, memberId: member.id, text, replace });
      },
      activity: (activity) => {
        this.emit({ type: 'member.activity', round: roundIndex, memberId: member.id, activity });
      },
    });
    if (direct) this.turn.finalText = response.text;
    return ok;
  }

  private endMember(roundIndex: number, response: MemberResponse): void {
    this.emit({ type: 'member.end', round: roundIndex, response: clone(response) });
  }

  private endRound(round: RoundResult): void {
    round.status = round.responses.every((r) => r.status === 'skipped' || r.status === 'pending') ? 'skipped' : 'done';
    this.emit({ type: 'round.end', round: round.index, result: clone(round) });
  }

  private newAnswerSet(): void {
    const withAnswers = this.participants.filter((m) => this.answers.has(m.id)).map((m) => m.id);
    // Fisher–Yates with the injected RNG, so a label's position says nothing about its author.
    for (let i = withAnswers.length - 1; i > 0; i--) {
      const j = Math.floor(this.input.rng() * (i + 1));
      [withAnswers[i], withAnswers[j]] = [withAnswers[j]!, withAnswers[i]!];
    }
    const labels: Record<string, string> = {};
    const labelOf = new Map<string, string>();
    withAnswers.forEach((id, i) => {
      labels[labelFor(i)] = id;
      labelOf.set(id, labelFor(i));
    });
    this.answerSet = {
      id: this.nextSetId++,
      labels,
      labelOf,
      reviews: [],
      reviewsAnonymized: false,
      leaderboard: null,
    };
  }

  private labeledAnswers(exclude: string | null): LabeledAnswer[] {
    const set = this.answerSet!;
    return Object.entries(set.labels)
      .filter(([, id]) => id !== exclude)
      .map(([label, id]) => ({ label, name: this.memberById(id).name, text: this.answers.get(id)! }))
      .sort((a, b) => (a.label < b.label ? -1 : 1));
  }

  private async runRounds(): Promise<'continue' | 'stopped' | 'skipped' | 'failed'> {
    const rounds = this.turn.rounds;
    for (let index = 0; index < rounds.length; index++) {
      const round = rounds[index]!;
      if (this.stopped) return 'stopped';
      if (this.input.control.skipRequested) return 'skipped';
      const signal = this.input.control.beginRound(this.internal.signal);
      round.status = 'running';
      if (round.type !== 'answer') round.labels = { ...this.answerSet!.labels };
      this.emit({ type: 'round.start', round: index });

      if (round.type === 'answer') await this.answerRound(round, signal);
      else if (round.type === 'review') await this.reviewRound(round, signal);
      else await this.reviseRound(round, signal);
      this.endRound(round);

      if (this.stopped) return 'stopped';
      if (round.type === 'answer' && this.answers.size === 0) {
        return this.input.control.skipRequested ? 'skipped' : 'failed';
      }
      if (this.input.control.skipRequested) return 'skipped';
    }
    return 'continue';
  }

  private async answerRound(round: RoundResult, signal: AbortSignal): Promise<void> {
    await Promise.all(
      round.responses.map(async (response) => {
        const member = this.memberById(response.memberId);
        const prompt = buildAnswerPrompt(this.promptContext(member), this.roundInfo(round.index));
        if (await this.memberCall(round.index, response, prompt, signal)) {
          this.answers.set(member.id, response.text);
        }
        this.endMember(round.index, response);
      }),
    );
    if (this.answers.size > 0) this.newAnswerSet();
  }

  private async reviewRound(round: RoundResult, signal: AbortSignal): Promise<void> {
    const set = this.answerSet!;
    const rankings: ReviewerRanking[] = [];
    const reviews: { reviewerId: string; text: string }[] = [];
    await Promise.all(
      round.responses.map(async (response) => {
        const member = this.memberById(response.memberId);
        const shown = this.labeledAnswers(round.includeSelf ? null : member.id);
        if (shown.length === 0) {
          response.status = 'skipped';
          this.endMember(round.index, response);
          return;
        }
        const { prompt, asksForRanking } = buildReviewPrompt(
          this.promptContext(member),
          this.roundInfo(round.index),
          shown,
          this.answers.has(member.id),
        );
        if (await this.memberCall(round.index, response, prompt, signal)) {
          reviews.push({ reviewerId: member.id, text: response.text });
          if (asksForRanking) {
            response.ranking = parseRanking(
              response.text,
              shown.map((a) => a.label),
            );
            if (response.ranking) rankings.push({ reviewerId: member.id, ranking: response.ranking });
          }
        }
        this.endMember(round.index, response);
      }),
    );
    // Keep reviewer order stable (settings order) regardless of who finished first.
    const order = this.participants.map((m) => m.id);
    reviews.sort((a, b) => order.indexOf(a.reviewerId) - order.indexOf(b.reviewerId));
    rankings.sort((a, b) => order.indexOf(a.reviewerId) - order.indexOf(b.reviewerId));
    round.leaderboard = buildLeaderboard(rankings, set.labels);
    if (reviews.length > 0) {
      set.reviews = reviews;
      set.reviewsAnonymized = round.anonymize;
    }
    if (round.leaderboard) {
      set.leaderboard = round.leaderboard;
      this.latestLeaderboard = { entries: round.leaderboard, setId: set.id };
    }
  }

  private async reviseRound(round: RoundResult, signal: AbortSignal): Promise<void> {
    const set = this.answerSet!;
    const revised = new Map<string, string>();
    await Promise.all(
      round.responses.map(async (response) => {
        const member = this.memberById(response.memberId);
        const ownLabel = set.labelOf.get(member.id);
        const own = ownLabel ? { label: ownLabel, text: this.answers.get(member.id)! } : null;
        const reviews = set.reviews
          .filter((r) => r.reviewerId !== member.id)
          .map((r) => ({ reviewerName: this.memberById(r.reviewerId).name, text: r.text }));
        const ranking =
          set.leaderboard?.map((e) => ({
            label: e.label,
            averageRank: e.averageRank,
            votes: e.votes,
            mine: e.memberId === member.id,
          })) ?? null;
        const prompt = buildRevisePrompt(
          this.promptContext(member),
          this.roundInfo(round.index),
          own,
          this.labeledAnswers(member.id),
          reviews,
          ranking,
        );
        if (await this.memberCall(round.index, response, prompt, signal)) revised.set(member.id, response.text);
        this.endMember(round.index, response);
      }),
    );
    if (revised.size > 0) {
      // Successful revisions replace answers; failed ones keep the previous answer. New answers
      // get a fresh label map, and reviews of the old answers no longer apply.
      for (const [id, text] of revised) this.answers.set(id, text);
      this.newAnswerSet();
    }
  }

  private skipRemaining(): void {
    for (const round of this.turn.rounds) {
      if (round.status !== 'pending') continue;
      for (const r of round.responses) if (r.status === 'pending') r.status = 'skipped';
      round.status = 'skipped';
      this.emit({ type: 'round.end', round: round.index, result: clone(round) });
    }
  }

  private missingMembers(): { name: string; error: string }[] {
    const first = this.turn.rounds[0]!;
    return this.participants
      .filter((m) => !this.answers.has(m.id))
      .map((m) => {
        const r = first.responses.find((x) => x.memberId === m.id);
        const error =
          r?.error ?? (r?.status === 'skipped' ? 'It had not finished when the council moved on to the verdict.' : 'No answer.');
        return { name: m.name, error };
      });
  }

  private fallbackMember(): MemberConfig | null {
    const set = this.answerSet;
    const leader = set?.leaderboard?.[0]?.memberId;
    if (leader && this.answers.has(leader)) return this.memberById(leader);
    return this.participants.find((m) => this.answers.has(m.id)) ?? null;
  }

  private async runArbiter(): Promise<void> {
    const arbiter = this.turn.arbiter!;
    const settings = this.input.settings;
    this.input.control.phase = 'arbiter';
    const set = this.answerSet!;
    const stale = !!this.latestLeaderboard && this.latestLeaderboard.setId !== set.id;
    const prompt = buildArbiterPrompt({
      name: arbiter.name,
      councilSize: this.participants.length,
      webSearch: this.webOn(arbiter.provider),
      councilRules: settings.councilRules,
      instructions: settings.arbiter.instructions,
      analysis: arbiter.analysisEnabled,
      history: this.history,
      question: this.input.plan.question,
      answers: this.labeledAnswers(null),
      reviews: stale
        ? []
        : set.reviews.map((r) => ({ reviewerName: this.memberById(r.reviewerId).name, text: r.text })),
      reviewsAnonymized: set.reviewsAnonymized,
      leaderboard: this.latestLeaderboard
        ? {
            stale,
            entries: this.latestLeaderboard.entries.map((e) => ({ ...e, name: this.memberById(e.memberId).name })),
          }
        : null,
      missing: this.missingMembers(),
      library: this.material,
      browse: this.browses(arbiter.provider),
    });

    arbiter.status = 'running';
    arbiter.startedAt = new Date().toISOString();
    this.emit({ type: 'arbiter.start', startedAt: arbiter.startedAt });
    const ok = await this.call(
      arbiter,
      arbiter.provider,
      arbiter.configuredModel,
      arbiter.effort,
      prompt,
      this.internal.signal,
      {
        text: (text, replace) => {
          const split = splitArbiterOutput(arbiter.text, arbiter.analysisEnabled, false);
          this.turn.analysisText = split.analysis;
          this.turn.finalText = split.final;
          this.emit({ type: 'arbiter.delta', text, replace });
        },
        activity: (activity) => this.emit({ type: 'arbiter.activity', activity }),
      },
    );

    if (ok) {
      const split = splitArbiterOutput(arbiter.text, arbiter.analysisEnabled, true);
      if (split.final.trim()) {
        this.turn.analysisText = split.analysis;
        this.turn.finalText = split.final;
        this.turn.finalSource = { kind: 'arbiter', name: arbiter.name, memberId: null };
        this.turn.status = 'complete';
      } else {
        arbiter.status = 'error';
        arbiter.error = `It wrote a council analysis but nothing after the ${ARBITER_MARKER} line`;
      }
    }
    // Re-read: the call above has updated the status.
    const status = arbiter.status as CallResult['status'];
    if (status === 'skipped') {
      // Stopped while the verdict was being written: keep the partial final answer, if any.
      const split = splitArbiterOutput(arbiter.text, arbiter.analysisEnabled, false);
      this.turn.analysisText = split.analysis;
      this.turn.finalText = split.final;
      this.turn.finalSource = split.final
        ? { kind: 'arbiter', name: arbiter.name, memberId: null }
        : { kind: 'none', name: '', memberId: null };
    } else if (status === 'error') {
      const member = this.fallbackMember()!;
      this.turn.analysisText = '';
      this.turn.finalText = this.answers.get(member.id)!;
      this.turn.finalSource = { kind: 'fallback', name: member.name, memberId: member.id };
      this.turn.error = `The arbiter (${arbiter.name}) failed: ${withoutFinalPeriod(arbiter.error ?? 'unknown error')}. Showing ${member.name}'s answer instead.`;
      this.turn.status = 'complete';
    }
    this.emit({
      type: 'arbiter.end',
      arbiter: clone(arbiter),
      analysisText: this.turn.analysisText,
      finalText: this.turn.finalText,
    });
  }

  private endStopped(): void {
    this.skipRemaining();
    const shutdown = this.input.signal.reason instanceof ShutdownReason;
    this.turn.status = shutdown ? 'interrupted' : 'stopped';
    if (shutdown) this.turn.error = INTERRUPTED_MESSAGE;
    if (this.turn.mode === 'direct') {
      const text = this.turn.rounds[0]!.responses[0]!.text;
      this.turn.finalText = text;
      const m = this.participants[0]!;
      this.turn.finalSource = text ? { kind: 'member', name: m.name, memberId: m.id } : { kind: 'none', name: '', memberId: null };
    } else if (this.turn.arbiter?.status !== 'skipped') {
      // Stopped before the arbiter started: there is no final text. (A stop during the verdict
      // keeps the partial verdict, which runArbiter already recorded.)
      this.turn.analysisText = '';
      this.turn.finalText = '';
      this.turn.finalSource = { kind: 'none', name: '', memberId: null };
    }
  }

  private async execute(): Promise<void> {
    if (this.turn.library) {
      try {
        this.material = await runLibraryPhase({
          conversation: this.input.conversation,
          turn: this.turn,
          settings: this.input.settings,
          library: this.input.library ?? null,
          providers: this.input.providers,
          question: this.input.plan.question,
          attachmentIds: this.input.plan.attachmentIds,
          signal: this.internal.signal,
          emit: (event) => this.emit(event),
          rng: this.input.rng,
        });
      } catch (err) {
        if (this.stopped) return this.endStopped();
        throw err;
      }
    }
    this.input.control.phase = 'rounds';
    const outcome = await this.runRounds();
    if (outcome === 'stopped') return this.endStopped();

    if (this.turn.mode === 'direct') {
      const response = this.turn.rounds[0]!.responses[0]!;
      const m = this.participants[0]!;
      if (response.status === 'done') {
        this.turn.finalText = response.text;
        this.turn.finalSource = { kind: 'member', name: m.name, memberId: m.id };
        this.turn.status = 'complete';
      } else {
        this.turn.finalText = '';
        this.turn.status = 'error';
        this.turn.error = response.error ?? `${m.name} did not answer.`;
      }
      return;
    }

    if (outcome === 'failed') {
      const lines = this.turn.rounds[0]!.responses.map(
        (r) => `${this.memberById(r.memberId).name}: ${r.error ?? 'No answer.'}`,
      );
      this.skipRemaining();
      this.turn.status = 'error';
      this.turn.error = ['No council member produced an answer.', ...lines].join('\n');
      return;
    }
    if (outcome === 'skipped') {
      this.skipRemaining();
      if (this.answers.size === 0) {
        this.turn.status = 'error';
        this.turn.error = 'Skipped before any member finished answering.';
        return;
      }
    }

    await this.runArbiter();
    // A verdict that completed just as the user pressed stop is kept.
    if (this.stopped && this.turn.status !== 'complete') this.endStopped();
  }

  async run(): Promise<void> {
    const onStop = () => this.internal.abort(this.input.signal.reason);
    if (this.input.signal.aborted) onStop();
    else this.input.signal.addEventListener('abort', onStop, { once: true });
    try {
      await this.execute();
    } catch (err) {
      if (this.stopped) {
        this.endStopped();
      } else {
        console.error('[orchestrator] Unexpected error:', err);
        this.turn.status = 'error';
        this.turn.error = `Something went wrong while running this turn: ${errorMessage(err)}`;
      }
    } finally {
      this.input.signal.removeEventListener('abort', onStop);
      this.internal.abort();
      this.input.control.phase = 'finished';
      settleOpenParts(this.turn);
      if (this.turn.status === 'running') {
        this.turn.status = 'error';
        this.turn.error = this.turn.error ?? 'The turn ended without a result.';
      }
      this.turn.finishedAt = new Date().toISOString();
      this.emit({ type: 'turn.end', turn: clone(this.turn) });
    }
  }
}

/**
 * Runs a planned turn to completion, mutating `plan.turn` and emitting events. Never rejects;
 * 'turn.end' is always the last event and is emitted exactly once.
 */
export async function runTurn(input: OrchestratorInput): Promise<void> {
  let ended = false;
  const emit = (event: RunEvent) => {
    if (ended) return;
    if (event.type === 'turn.end') ended = true;
    try {
      input.emit(event);
    } catch (err) {
      console.error('[orchestrator] Event listener failed:', err);
    }
  };
  try {
    const runner = new TurnRunner({ ...input, emit });
    await runner.run();
  } catch (err) {
    // Reached only if setting up or finishing the run itself fails. The turn must still end,
    // or the conversation would stay blocked as "running".
    console.error('[orchestrator] The turn could not be run:', err);
    const turn = input.plan.turn;
    settleOpenParts(turn);
    turn.status = 'error';
    turn.error = `Something went wrong while running this turn: ${errorMessage(err)}`;
    turn.finishedAt = turn.finishedAt ?? new Date().toISOString();
    input.control.phase = 'finished';
    emit({ type: 'turn.end', turn: clone(turn) });
  }
}
