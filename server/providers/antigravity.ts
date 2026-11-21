import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BillingMode } from '../../shared/types';
import { cleanCliText, cliMessage } from '../util/text';
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

export const ANTIGRAVITY: CliDescriptor = {
  id: 'antigravity',
  label: 'Gemini',
  cliName: 'Antigravity CLI',
  vendor: 'Google',
  defaultCommand: 'agy',
  apiKeyVars: API_KEY_VARS.antigravity!,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  webSearch: 'builtin',
  streams: true,
  modelSuggestions: [
    'gemini-4-neon-xhigh',
    'gemini-4-neon-high',
    'gemini-4-carbon-high',
    'gemini-4-hydrogen-high',
    'gemini-3.8-flash-high',
    'gemini-3.1-pro-high',
  ],
  canListModels: true,
  installHint:
    'Install Antigravity CLI: `curl -fsSL https://antigravity.google/cli/install.sh | bash` (Windows PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`)',
  loginHint: 'Run `agy` once and sign in with the Google account that holds your AI subscription.',
  docsUrl: 'https://antigravity.google/docs/cli/headless',
};

export const MAX_ARG_PROMPT_CHARS = 30_000;

const NOT_SIGNED_IN =
  'Antigravity CLI is not signed in. Run `agy` once in a terminal and sign in with your Google account.';

export interface AntigravityInvocation {
  args: string[];
  stdin: string;
}

export function antigravityInvocation(
  req: Pick<RunRequest, 'model' | 'effort' | 'prompt'>,
  cfg: Pick<CliConfig, 'extraArgs' | 'promptMode'>,
): AntigravityInvocation {
  const tailArgs: string[] = ['--disable-slash-commands'];
  if (req.model) tailArgs.push('--model', req.model);
  if (req.effort) tailArgs.push('--effort', req.effort);
  tailArgs.push(...cfg.extraArgs);
  if (cfg.promptMode === 'arg') {
    if (req.prompt.length > MAX_ARG_PROMPT_CHARS) {
      throw new ProviderError(
        `The prompt is ${req.prompt.length.toLocaleString('en-US')} characters, too long for an argument; switch the provider's prompt delivery to stdin (Settings → Providers → Gemini).`,
      );
    }
    return { args: ['-p', req.prompt, '--output-format', 'stream-json', ...tailArgs], stdin: '' };
  }
  return {
    args: ['--input-format', 'stream-json', '--output-format', 'stream-json', ...tailArgs],
    stdin: JSON.stringify({ event: 'user', message: { content: req.prompt } }) + '\n',
  };
}

export function createAntigravityParser(handlers: Pick<RunRequest, 'onText' | 'onActivity'>): StreamParser {
  let model: string | null = null;
  let sawEvent = false;
  let rawStdout = '';
  let currentStep: number | null = null;
  let currentText = '';
  let result: { ok: true; text: string } | { ok: false; error: string } | null = null;

  const appendToCurrent = (text: string) => {
    if (!text) return;
    currentText += text;
    handlers.onText(text, false);
  };

  return {
    push(line) {
      if (!sawEvent) rawStdout += line + '\n';
      const ev = parseJsonLine(line);
      const kind = ev ? str(ev.event) : null;
      if (!ev || !kind) return;
      sawEvent = true;
      if (result) return 'terminal';
      const payload = obj(ev[kind]);
      switch (kind) {
        case 'init': {
          model = str(payload?.model) ?? str(ev.model) ?? model;
          return;
        }
        case 'step_update': {
          if (!payload) return;
          const type = str(payload.step_type);
          const state = str(payload.state);
          if (type === 'agent_response') {
            const index = typeof payload.step_index === 'number' ? payload.step_index : (currentStep ?? 0);
            if (currentStep !== null && index < currentStep) return;
            if (currentStep !== null && index > currentStep) {
              // A later response step supersedes the earlier one (a tool call came in between).
              currentText = '';
              handlers.onText('', true);
            }
            if (currentStep !== index) handlers.onActivity('');
            currentStep = index;
            const delta = str(payload.text_delta) ?? '';
            if (state === 'DONE' && currentText !== '' && delta.startsWith(currentText)) {
              // Cumulative final delivery: only the part not yet shown is new.
              appendToCurrent(delta.slice(currentText.length));
            } else {
              appendToCurrent(delta);
            }
            return;
          }
          if (type === 'tool') {
            const name = str(payload.tool_name) ?? 'a tool';
            handlers.onActivity(state === 'DONE' ? '' : `Using ${name}…`);
            return;
          }
          return;
        }
        case 'result': {
          const status = str(payload?.status) ?? 'UNKNOWN';
          if (status === 'SUCCESS') {
            result = { ok: true, text: str(payload?.response) ?? '' };
          } else {
            const error = str(payload?.error)?.trim();
            result = { ok: false, error: error || `Antigravity CLI ended with status ${status}` };
          }
          return 'terminal';
        }
        default:
          return;
      }
    },
    finish(res: ProcResult): { text: string; model: string | null; billing: BillingMode } {
      if (result && !result.ok) {
        const message = /authentication required/i.test(result.error)
          ? NOT_SIGNED_IN
          : withLoginHint(`Antigravity CLI reported an error: ${cliMessage(result.error)}`, ANTIGRAVITY);
        throw new ProviderError(message);
      }
      if (result && result.ok) {
        const text = result.text.trim() ? result.text : currentText;
        if (!text.trim()) throw new ProviderError('Antigravity CLI returned an empty answer.');
        return { text: text.trim(), model, billing: 'unknown' };
      }
      if (!sawEvent && res.exitCode === 0) {
        const plain = cleanCliText(rawStdout);
        if (plain) {
          // Not the documented stream format: treat the output as the plain-text answer.
          handlers.onText(plain, true);
          return { text: plain, model, billing: 'unknown' };
        }
      }
      if (/authentication required/i.test(`${res.stderrTail}\n${res.stdoutTail}`)) {
        throw new ProviderError(NOT_SIGNED_IN);
      }
      if (res.exitCode !== 0) throw exitFailure(ANTIGRAVITY, res);
      if (currentText.trim()) return { text: currentText.trim(), model, billing: 'unknown' };
      throw new ProviderError(
        'Antigravity CLI ended without a result or any answer text. Check that the installed version supports `--output-format stream-json`.',
      );
    },
  };
}

export interface AntigravityLocalConfig {
  billing: BillingMode;
  warnings: string[];
}

/** Reads the CLI's own settings file to tell how calls will be billed. Unreadable files are ignored. */
export async function readAntigravityConfig(homeDir: string = os.homedir()): Promise<AntigravityLocalConfig> {
  const file = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  let value: Record<string, unknown> | null = null;
  try {
    value = obj(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    value = null;
  }
  const warnings: string[] = [];
  let billing: BillingMode = 'subscription';
  if (value?.modelProvider === 'gemini') {
    billing = 'api-key';
    warnings.push(
      `Antigravity CLI is configured for API-key billing ("modelProvider": "gemini" in ${file}). Remove that setting to use your Google AI subscription.`,
    );
  }
  if (value?.useG1Credits === true) {
    warnings.push(
      `Overage AI credits are enabled ("useG1Credits": true in ${file}); they may be charged once your plan's quota is used up.`,
    );
  }
  return { billing, warnings };
}

/** `agy models` prints `<slug>  <display name>` lines. */
export function parseAntigravityModels(stdout: string): string[] {
  const slugs: string[] = [];
  for (const line of cleanCliText(stdout).split('\n')) {
    const token = line.trim().split(/\s+/)[0] ?? '';
    if (/^[a-z0-9][a-z0-9._-]*$/.test(token) && !slugs.includes(token)) slugs.push(token);
  }
  return slugs;
}

export function antigravityProvider(cfg: CliConfig, homeDir?: string): Provider {
  return {
    id: ANTIGRAVITY.id,
    async info(signal) {
      const info = baseInfo(ANTIGRAVITY, cfg);
      const v = await detectVersion(ANTIGRAVITY, cfg, signal);
      if (!v.installed) return { ...info, authDetail: v.reason };
      const local = await readAntigravityConfig(homeDir);
      return {
        ...info,
        installed: true,
        version: v.version,
        auth: 'unknown',
        authDetail: 'Sign-in is checked on first use. Use Test to verify.',
        billing: local.billing,
        warnings: [...info.warnings, ...local.warnings],
      };
    },
    async run(req) {
      const inv = antigravityInvocation(req, cfg);
      const out = await runCli(ANTIGRAVITY, cfg, req, inv.args, inv.stdin, createAntigravityParser(req));
      // The CLI does not report billing; its settings file is the best available indication.
      const local = await readAntigravityConfig(homeDir);
      return { ...out, billing: local.billing };
    },
    async listModels(signal) {
      const res = await runCommand(commandFor(ANTIGRAVITY, cfg), ['models'], {
        env: envFor(ANTIGRAVITY, cfg),
        timeoutMs: 20_000,
        signal,
        cliName: ANTIGRAVITY.cliName,
        installHint: ANTIGRAVITY.installHint,
      });
      if (res.exitCode !== 0) {
        throw new Error(`\`agy models\` exited with code ${res.exitCode}: ${cliMessage(res.stderr || res.stdout, 300)}`);
      }
      return parseAntigravityModels(res.stdout);
    },
  };
}
