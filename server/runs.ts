import type { Conversation, RunEvent, Settings, Turn } from '../shared/types';
import { RunControl, runTurn, ShutdownReason, type ProviderSource } from './engine/orchestrator';
import type { TurnPlan } from './engine/plan';
import type { Storage } from './storage';

export type RunListener = (event: RunEvent) => void;

type DeltaEvent = Extract<RunEvent, { type: 'member.delta' | 'arbiter.delta' }>;

const COALESCE_MS = 50;

export interface RunManagerOptions {
  storage: Storage;
  providers: ProviderSource;
  rng?: () => number;
  /** Delta coalescing window (tests may shorten it). */
  coalesceMs?: number;
}

/** In-memory state of one running turn. Runs continue when every browser disconnects. */
export class Run {
  readonly abort = new AbortController();
  readonly control: RunControl;
  readonly finished: Promise<void>;
  private resolveFinished!: () => void;
  private readonly listeners = new Set<RunListener>();
  private readonly buffers = new Map<string, { event: DeltaEvent; text: string }>();
  private flushTimer: NodeJS.Timeout | null = null;
  private ended = false;
  private started = false;

  constructor(
    private readonly manager: RunManager,
    readonly conversationId: string,
    readonly plan: TurnPlan,
    private readonly settings: Settings,
  ) {
    this.control = new RunControl(plan.turn.mode);
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
  }

  /** The live turn (mutated as the run progresses). */
  get turn(): Turn {
    return this.plan.turn;
  }

  /**
   * Sends a snapshot and subscribes in one synchronous step, so no event can fall between them.
   * Buffered text is flushed to existing listeners first: it is already part of the snapshot.
   */
  subscribe(listener: RunListener): () => void {
    this.flush();
    listener({ type: 'snapshot', turn: structuredClone(this.turn) });
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(conversation: Conversation): void {
    if (this.started) return;
    this.started = true;
    runTurn({
      conversation,
      plan: this.plan,
      settings: this.settings,
      providers: this.manager.options.providers,
      rng: this.manager.options.rng ?? Math.random,
      emit: (event) => this.handle(event),
      signal: this.abort.signal,
      control: this.control,
    }).catch((err: unknown) => {
      // runTurn is written never to reject; if it does, release the conversation regardless.
      console.error('[runs] A turn ended abnormally:', err);
      const turn = this.turn;
      turn.status = 'error';
      turn.error = turn.error ?? 'Something went wrong while running this turn.';
      turn.finishedAt = turn.finishedAt ?? new Date().toISOString();
      this.handle({ type: 'turn.end', turn: structuredClone(turn) });
    });
  }

  private broadcast(event: RunEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('[runs] A subscriber failed:', err);
      }
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffers.size === 0) return;
    const pending = [...this.buffers.values()];
    this.buffers.clear();
    for (const { event, text } of pending) this.broadcast({ ...event, text });
  }

  private handle(event: RunEvent): void {
    if (this.ended) return;
    if (event.type === 'member.delta' || event.type === 'arbiter.delta') {
      const key = event.type === 'member.delta' ? `m:${event.round}:${event.memberId}` : 'arbiter';
      if (event.replace) {
        this.buffers.delete(key);
        this.broadcast(event);
        return;
      }
      const buffered = this.buffers.get(key);
      if (buffered) buffered.text += event.text;
      else this.buffers.set(key, { event, text: event.text });
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), this.manager.options.coalesceMs ?? COALESCE_MS);
      }
      return;
    }
    this.flush();
    if (event.type === 'turn.end') {
      this.ended = true;
      void this.finish(event);
      return;
    }
    this.broadcast(event);
    if (event.type === 'member.end' || event.type === 'round.end' || event.type === 'arbiter.end') {
      void this.manager.persistTurn(this.conversationId, structuredClone(this.turn), false);
    }
  }

  private async finish(event: Extract<RunEvent, { type: 'turn.end' }>): Promise<void> {
    // Persist first, so a client that reloads after 'turn.end' reads the same turn from disk.
    await this.manager.persistTurn(this.conversationId, event.turn, true);
    this.manager.release(this);
    this.broadcast(event);
    this.listeners.clear();
    this.resolveFinished();
  }
}

export class RunManager {
  private readonly runs = new Map<string, Run>();

  constructor(readonly options: RunManagerOptions) {}

  get(conversationId: string): Run | undefined {
    return this.runs.get(conversationId);
  }

  has(conversationId: string): boolean {
    return this.runs.has(conversationId);
  }

  /**
   * Registers a run before its turn is persisted, so the conversation counts as busy (409 for a
   * second turn, no "interrupted" repair) from this moment on. Returns null if it already has one.
   */
  create(conversationId: string, plan: TurnPlan, settings: Settings): Run | null {
    if (this.runs.has(conversationId)) return null;
    const run = new Run(this, conversationId, plan, settings);
    this.runs.set(conversationId, run);
    return run;
  }

  /** Unregisters a run that never started (its turn could not be saved). */
  discard(run: Run): void {
    if (this.runs.get(run.conversationId) === run) this.runs.delete(run.conversationId);
  }

  release(run: Run): void {
    this.discard(run);
  }

  async persistTurn(conversationId: string, turn: Turn, final: boolean): Promise<void> {
    try {
      await this.options.storage.update(conversationId, (conversation) => {
        const i = conversation.turns.findIndex((t) => t.id === turn.id);
        if (i < 0) return;
        conversation.turns[i] = turn;
        if (final) conversation.updatedAt = turn.finishedAt ?? new Date().toISOString();
      });
    } catch (err) {
      console.error(`[runs] Could not save conversation ${conversationId}:`, err);
    }
  }

  /** Stops the run and waits (briefly) for it to end. false when nothing was running. */
  async stop(conversationId: string, turnId?: string, reason?: unknown): Promise<boolean> {
    const run = this.runs.get(conversationId);
    if (!run || (turnId !== undefined && run.turn.id !== turnId)) return false;
    run.abort.abort(reason);
    await Promise.race([run.finished, new Promise((r) => setTimeout(r, 5_000).unref())]);
    return true;
  }

  /** Aborts every run as a shutdown (turns end as 'interrupted') and waits for them to save. */
  async shutdown(timeoutMs = 3_000): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) run.abort.abort(new ShutdownReason());
    await Promise.race([
      Promise.all(runs.map((r) => r.finished)),
      new Promise((r) => setTimeout(r, timeoutMs).unref()),
    ]);
  }
}
