import type { BillingMode, ProviderInfo } from '../../shared/types';
import { cliMessage } from '../util/text';
import { apiKeyWarnings, buildChildEnv } from './env';
import { runCommand, runProcess, type ProcResult } from './proc';
import { ProviderError, type CliConfig, type RunOutcome, type RunRequest } from './types';

/** Static facts about a CLI provider, used for messages and for ProviderInfo. */
export interface CliDescriptor {
  id: string;
  label: string;
  cliName: string;
  vendor: string;
  defaultCommand: string;
  apiKeyVars: string[];
  effortLevels: string[];
  webSearch: ProviderInfo['webSearch'];
  streams: boolean;
  browse: ProviderInfo['browse'];
  modelSuggestions: string[];
  canListModels: boolean;
  installHint: string;
  loginHint: string;
  docsUrl: string;
}

/** A stateful stdout parser for one call. */
export interface StreamParser {
  /** Feeds one stdout line; returns 'terminal' when the CLI's final event was seen. */
  push(line: string): 'terminal' | void;
  /** Interprets the finished process. Throws ProviderError on failure. */
  finish(res: ProcResult): { text: string; model: string | null; billing: BillingMode };
}

export function commandFor(desc: CliDescriptor, cfg: CliConfig): string {
  return cfg.command.trim() || desc.defaultCommand;
}

export function envFor(desc: CliDescriptor, cfg: CliConfig): NodeJS.ProcessEnv {
  return buildChildEnv(desc.apiKeyVars, cfg.stripApiKeys);
}

/** Shared driver: spawn, feed the parser, attach diagnostics to failures. */
export async function runCli(
  desc: CliDescriptor,
  cfg: CliConfig,
  req: RunRequest,
  args: string[],
  stdin: string | null,
  parser: StreamParser,
): Promise<RunOutcome> {
  const res = await runProcess({
    command: commandFor(desc, cfg),
    args,
    stdin,
    env: envFor(desc, cfg),
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    cliName: desc.cliName,
    installHint: desc.installHint,
    onLine: (line) => parser.push(line),
    cwd: req.browseDir,
  });
  try {
    const out = parser.finish(res);
    return { ...out, diagnostics: res.diagnostics };
  } catch (err) {
    if (err instanceof ProviderError && !err.diagnostics) throw new ProviderError(err.message, res.diagnostics);
    throw err;
  }
}

/** Parses a line as a JSON object; anything else (banners, blank lines) yields null. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

const AUTH_RE = /not (?:logged|signed) in|log ?in required|please (?:log|sign) ?in|\/login|unauthori[sz]ed|\b401\b|authentication (?:required|failed)|invalid api key|(?:oauth )?token (?:has )?expired/i;

/** Adds the sign-in hint to errors that look like an authentication problem. */
export function withLoginHint(message: string, desc: CliDescriptor): string {
  return AUTH_RE.test(message) ? `${message} ${desc.loginHint}` : message;
}

/** The message for a non-zero exit with no structured error. */
export function exitFailure(desc: CliDescriptor, res: ProcResult, fallbackDetail?: string): ProviderError {
  const detail = fallbackDetail?.trim() || cliMessage(res.stderrTail) || cliMessage(res.stdoutTail, 600);
  const how = res.exitCode !== null ? `exited with code ${res.exitCode}` : `was terminated (${res.exitSignal ?? 'unknown signal'})`;
  const message = detail ? `${desc.cliName} ${how}: ${detail}` : `${desc.cliName} ${how} without an error message.`;
  return new ProviderError(withLoginHint(message, desc));
}

/** The first non-empty line of `--version` output, cleaned. */
export function versionLine(stdout: string): string | null {
  const line = cliMessage(stdout, 200).split('\n').find((l) => l.trim() !== '');
  return line ? line.trim().slice(0, 80) : null;
}

export function baseInfo(desc: CliDescriptor, cfg: CliConfig): ProviderInfo {
  return {
    id: desc.id,
    label: desc.label,
    cliName: desc.cliName,
    vendor: desc.vendor,
    kind: 'builtin',
    command: commandFor(desc, cfg),
    installed: false,
    version: null,
    auth: 'unknown',
    authDetail: '',
    billing: 'unknown',
    warnings: apiKeyWarnings(desc.apiKeyVars, cfg.stripApiKeys),
    effortLevels: [...desc.effortLevels],
    webSearch: desc.webSearch,
    streams: desc.streams,
    browse: desc.browse,
    modelSuggestions: [...desc.modelSuggestions],
    canListModels: desc.canListModels,
    installHint: desc.installHint,
    loginHint: desc.loginHint,
    docsUrl: desc.docsUrl,
  };
}

/** Runs `<command> --version`; null info fields when the CLI is missing. */
export async function detectVersion(
  desc: CliDescriptor,
  cfg: CliConfig,
  signal?: AbortSignal,
): Promise<{ installed: true; version: string | null } | { installed: false; reason: string }> {
  try {
    const res = await runCommand(commandFor(desc, cfg), ['--version'], {
      env: envFor(desc, cfg),
      timeoutMs: 10_000,
      signal,
      cliName: desc.cliName,
      installHint: desc.installHint,
    });
    if (res.exitCode !== 0) {
      const detail = cliMessage(res.stderr || res.stdout, 300);
      return {
        installed: false,
        reason: `\`${commandFor(desc, cfg)} --version\` exited with code ${res.exitCode}${detail ? `: ${detail}` : '.'}`,
      };
    }
    return { installed: true, version: versionLine(res.stdout) };
  } catch (err) {
    return { installed: false, reason: (err as Error).message };
  }
}
