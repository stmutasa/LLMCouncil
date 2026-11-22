import type { BillingMode, ProviderInfo, ProviderSettings } from '../../shared/types';

export interface RunRequest {
  /** The complete prompt (see engine/prompts.ts). */
  prompt: string;
  /** '' = the CLI's default model. */
  model: string;
  /** '' = the CLI's default effort. */
  effort: string;
  webSearch: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  /** Append `text`, or (replace) replace everything shown so far with it. */
  onText(text: string, replace: boolean): void;
  /** A transient progress label; '' clears it. */
  onActivity(label: string): void;
  /**
   * Browse mode: the library mirror, used as the CLI's working directory so it can open the
   * documents. Only given to providers whose `browse` capability is not 'no'.
   */
  browseDir?: string;
}

export interface RunOutcome {
  text: string;
  model: string | null;
  billing: BillingMode;
  /** Tail of the raw CLI output, for troubleshooting. */
  diagnostics: string;
}

export interface Provider {
  id: string;
  /** Detection; may be slow, so the registry caches it. */
  info(signal?: AbortSignal): Promise<ProviderInfo>;
  /** Rejects with an Error whose message can be shown to the user as is. */
  run(req: RunRequest): Promise<RunOutcome>;
  listModels?(signal?: AbortSignal): Promise<string[]>;
}

/** Per-call configuration a CLI adapter is created with. */
export interface CliConfig extends ProviderSettings {
  stripApiKeys: boolean;
}

/** A provider failure that carries the CLI's raw output for the troubleshooting panel. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly diagnostics = '',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function abortError(): Error {
  const err = new Error('The call was stopped.');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
