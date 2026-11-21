import type { ProviderInfo } from '../../shared/types';
import { cleanCliText, cliMessage, joinSentences } from '../util/text';
import {
  baseInfo,
  commandFor,
  detectVersion,
  envFor,
  exitFailure,
  obj,
  parseJsonLine,
  runCli,
  str,
  withLoginHint,
  type CliDescriptor,
  type StreamParser,
} from './cli';
import { API_KEY_VARS } from './env';
import { runCommand, type ProcResult } from './proc';
import { ProviderError, type CliConfig, type Provider, type RunRequest } from './types';

export const CODEX: CliDescriptor = {
  id: 'codex',
  label: 'ChatGPT',
  cliName: 'Codex CLI',
  vendor: 'OpenAI',
  defaultCommand: 'codex',
  apiKeyVars: API_KEY_VARS.codex!,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  webSearch: 'toggle',
  streams: false,
  modelSuggestions: [
    'gpt-6.2-astra',
    'gpt-6.2-sol',
    'gpt-6.1-terra',
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.5',
  ],
  canListModels: true,
  installHint: 'Install Codex CLI: `npm install -g @openai/codex`',
  loginHint: 'Run `codex login` and choose Sign in with ChatGPT.',
  docsUrl: 'https://learn.chatgpt.com/docs/non-interactive-mode',
};

/**
 * `--search` is a top-level flag and must come before `exec`. `-c` values are not quoted: a value
 * that is not valid TOML is taken as a literal string. The trailing `-` reads the prompt from stdin.
 */
export function codexArgs(req: Pick<RunRequest, 'model' | 'effort' | 'webSearch'>, extraArgs: string[]): string[] {
  const args: string[] = [];
  if (req.webSearch) args.push('--search');
  args.push(
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '-s',
    'read-only',
    '--color',
    'never',
    '-c',
    'project_doc_max_bytes=0',
  );
  if (req.model) args.push('-m', req.model);
  if (req.effort) args.push('-c', `model_reasoning_effort=${req.effort}`);
  return [...args, ...extraArgs, '-'];
}

function itemActivity(type: string | null): string | null {
  switch (type) {
    case 'reasoning':
      return 'Reasoning…';
    case 'web_search':
      return 'Searching the web…';
    case 'command_execution':
      return 'Running a command…';
    case 'error':
    case null:
      return null;
    default:
      return 'Working…';
  }
}

export function createCodexParser(handlers: Pick<RunRequest, 'onText' | 'onActivity'>): StreamParser {
  let message: string | null = null;
  let lastError: string | null = null;
  let terminal: { ok: true } | { ok: false; error: string } | null = null;

  return {
    push(line) {
      const ev = parseJsonLine(line);
      if (!ev || terminal) return terminal ? 'terminal' : undefined;
      switch (ev.type) {
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = obj(ev.item);
          if (!item) return;
          const type = str(item.type);
          if (type === 'agent_message') {
            const text = str(item.text);
            if (text !== null) {
              message = text;
              handlers.onActivity('');
              handlers.onText(text, true);
            }
            return;
          }
          if (type === 'error') {
            lastError = str(item.message) ?? lastError;
            return;
          }
          const activity = itemActivity(type);
          if (activity !== null) handlers.onActivity(ev.type === 'item.completed' ? '' : activity);
          return;
        }
        case 'error': {
          lastError = str(ev.message) ?? lastError;
          return;
        }
        case 'turn.failed': {
          const error = obj(ev.error);
          terminal = { ok: false, error: str(error?.message) ?? str(ev.message) ?? lastError ?? 'unknown error' };
          return 'terminal';
        }
        case 'turn.completed': {
          terminal = { ok: true };
          return 'terminal';
        }
        default:
          return;
      }
    },
    finish(res: ProcResult) {
      if (terminal && !terminal.ok) {
        throw new ProviderError(withLoginHint(`Codex CLI failed: ${cliMessage(terminal.error)}`, CODEX));
      }
      if (terminal && terminal.ok) {
        if (message === null || !message.trim()) {
          throw new ProviderError(
            lastError ? `Codex returned no message. Its last notice was: ${cliMessage(lastError)}` : 'Codex returned no message.',
          );
        }
        return { text: message.trim(), model: null, billing: 'unknown' };
      }
      if (res.exitCode !== 0) {
        throw exitFailure(CODEX, res, lastError ? cliMessage(lastError) : undefined);
      }
      throw new ProviderError(
        joinSentences(
          'Codex CLI ended without reporting a result',
          lastError ? cliMessage(lastError) : cliMessage(res.stderrTail),
          'Check that the installed version supports `codex exec --json`.',
        ),
      );
    },
  };
}

export function describeCodexLogin(output: string): Pick<ProviderInfo, 'auth' | 'authDetail' | 'billing'> {
  const full = cleanCliText(output);
  const text = cliMessage(full, 300);
  if (/not logged in/i.test(full)) {
    return { auth: 'missing', authDetail: `Not signed in. ${CODEX.loginHint}`, billing: 'unknown' };
  }
  if (/logged in/i.test(full)) {
    if (/api key/i.test(full)) {
      return { auth: 'ok', authDetail: text, billing: 'api-key' };
    }
    return { auth: 'ok', authDetail: text, billing: 'subscription' };
  }
  return {
    auth: 'unknown',
    authDetail: text ? `Unrecognised output from \`codex login status\`: ${text}` : 'The sign-in state could not be read. Use Test to verify.',
    billing: 'unknown',
  };
}

/** `codex debug models` prints {"models":[…]} (or, defensively, a bare array). */
export function parseCodexModels(stdout: string): string[] {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error('`codex debug models` printed no JSON.');
  const value: unknown = JSON.parse(stdout.slice(start));
  const list = Array.isArray(value) ? value : obj(value)?.models;
  if (!Array.isArray(list)) throw new Error('`codex debug models` printed an unexpected format.');
  const slugs: string[] = [];
  for (const entry of list) {
    const m = obj(entry);
    const slug = m ? str(m.slug) : str(entry);
    if (!slug) continue;
    if (m && m.visibility !== undefined && m.visibility !== 'list') continue;
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

export function codexProvider(cfg: CliConfig): Provider {
  return {
    id: CODEX.id,
    async info(signal) {
      const info = baseInfo(CODEX, cfg);
      const v = await detectVersion(CODEX, cfg, signal);
      if (!v.installed) return { ...info, authDetail: v.reason };
      const res = await runCommand(commandFor(CODEX, cfg), ['login', 'status'], {
        env: envFor(CODEX, cfg),
        timeoutMs: 10_000,
        signal,
        cliName: CODEX.cliName,
        installHint: CODEX.installHint,
      });
      const auth = describeCodexLogin(`${res.stdout}\n${res.stderr}`);
      const warnings = [...info.warnings];
      if (auth.billing === 'api-key') {
        warnings.push(
          'Codex CLI is signed in with an API key, so calls are billed to the API. To use your ChatGPT plan, run `codex logout`, then `codex login` and choose Sign in with ChatGPT.',
        );
      }
      return { ...info, installed: true, version: v.version, ...auth, warnings };
    },
    run(req) {
      return runCli(CODEX, cfg, req, codexArgs(req, cfg.extraArgs), req.prompt, createCodexParser(req));
    },
    async listModels(signal) {
      const res = await runCommand(commandFor(CODEX, cfg), ['debug', 'models'], {
        env: envFor(CODEX, cfg),
        timeoutMs: 20_000,
        signal,
        cliName: CODEX.cliName,
        installHint: CODEX.installHint,
      });
      if (res.exitCode !== 0) {
        throw new Error(`\`codex debug models\` exited with code ${res.exitCode}: ${cliMessage(res.stderr, 300)}`);
      }
      return parseCodexModels(res.stdout);
    },
  };
}
