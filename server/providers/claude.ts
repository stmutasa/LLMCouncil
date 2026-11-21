import type { BillingMode, ProviderInfo } from '../../shared/types';
import { cliMessage, joinSentences } from '../util/text';
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

export const CLAUDE: CliDescriptor = {
  id: 'claude',
  label: 'Claude',
  cliName: 'Claude Code CLI',
  vendor: 'Anthropic',
  defaultCommand: 'claude',
  apiKeyVars: API_KEY_VARS.claude!,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  webSearch: 'toggle',
  streams: true,
  modelSuggestions: ['fable', 'opus', 'sonnet', 'haiku'],
  canListModels: false,
  installHint: 'Install Claude Code: https://code.claude.com/docs/en/setup',
  loginHint: 'Run `claude` and sign in with your Claude subscription (`/login`).',
  docsUrl: 'https://code.claude.com/docs/en/headless',
};

export const CLAUDE_SYSTEM_PROMPT =
  'You are an expert advisor taking part in a structured deliberation. Follow the instructions in the user message exactly and reply in Markdown.';

/** Never add --bare: it turns off the subscription login. */
export function claudeArgs(req: Pick<RunRequest, 'model' | 'effort' | 'webSearch'>, extraArgs: string[]): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--system-prompt',
    CLAUDE_SYSTEM_PROMPT,
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--setting-sources',
    '',
  ];
  if (req.webSearch) args.push('--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch');
  else args.push('--tools', '');
  if (req.model) args.push('--model', req.model);
  if (req.effort) args.push('--effort', req.effort);
  return [...args, ...extraArgs];
}

function activityFor(block: Record<string, unknown>): string | null {
  switch (block.type) {
    case 'thinking':
    case 'redacted_thinking':
      return 'Thinking…';
    case 'tool_use':
    case 'server_tool_use': {
      const name = str(block.name) ?? 'a tool';
      if (name === 'WebSearch' || name === 'web_search') return 'Searching the web…';
      if (name === 'WebFetch' || name === 'web_fetch') return 'Reading a web page…';
      return `Using ${name}…`;
    }
    case 'text':
      return '';
    default:
      return null;
  }
}

export function createClaudeParser(handlers: Pick<RunRequest, 'onText' | 'onActivity'>): StreamParser {
  let model: string | null = null;
  let billing: BillingMode = 'unknown';
  let streamed = '';
  let result: { ok: true; text: string } | { ok: false; error: string } | null = null;

  return {
    push(line) {
      const ev = parseJsonLine(line);
      if (!ev) return;
      switch (ev.type) {
        case 'system': {
          if (ev.subtype !== 'init') return;
          model = str(ev.model) ?? model;
          const source = str(ev.apiKeySource);
          if (source !== null) billing = source === 'none' ? 'subscription' : 'api-key';
          return;
        }
        case 'stream_event': {
          // Events from sub-agents carry a parent tool id; only the main conversation is the answer.
          if (ev.parent_tool_use_id !== null && ev.parent_tool_use_id !== undefined) return;
          const inner = obj(ev.event);
          if (!inner) return;
          if (inner.type === 'message_start') {
            // A new assistant message after a tool call supersedes what was streamed before it.
            if (streamed !== '') {
              streamed = '';
              handlers.onText('', true);
            }
          } else if (inner.type === 'content_block_start') {
            const block = obj(inner.content_block);
            const activity = block ? activityFor(block) : null;
            if (activity !== null) handlers.onActivity(activity);
          } else if (inner.type === 'content_block_delta') {
            const delta = obj(inner.delta);
            const text = delta && delta.type === 'text_delta' ? str(delta.text) : null;
            if (text) {
              streamed += text;
              handlers.onText(text, false);
            }
          }
          return;
        }
        case 'result': {
          if (result) return 'terminal';
          const success = ev.subtype === 'success' && ev.is_error !== true;
          if (success) {
            result = { ok: true, text: str(ev.result) ?? '' };
          } else {
            const errors = Array.isArray(ev.errors) ? ev.errors.filter((e): e is string => typeof e === 'string') : [];
            const message = str(ev.result)?.trim() || errors.join('; ') || str(ev.subtype) || 'unknown error';
            result = { ok: false, error: message };
          }
          return 'terminal';
        }
        default:
          return;
      }
    },
    finish(res: ProcResult) {
      if (result && !result.ok) {
        let message = withLoginHint(`Claude Code CLI reported an error: ${cliMessage(result.error)}`, CLAUDE);
        if (/selected model|unrecognized_model|model .*(?:not (?:found|exist)|does not exist)/i.test(result.error)) {
          message += ' Check the model name in Settings, or leave it empty to use the CLI default.';
        }
        throw new ProviderError(message);
      }
      if (result && result.ok) {
        const text = result.text.trim() ? result.text : streamed;
        if (!text.trim()) throw new ProviderError('Claude Code CLI returned an empty answer.');
        return { text: text.trim(), model, billing };
      }
      if (res.exitCode !== 0) throw exitFailure(CLAUDE, res);
      throw new ProviderError(
        joinSentences(
          'Claude Code CLI ended without a result',
          cliMessage(res.stderrTail),
          'Check that the installed version supports --output-format stream-json.',
        ),
      );
    },
  };
}

interface AuthStatus {
  loggedIn: boolean;
  authMethod: string;
  email: string | null;
}

function parseAuthStatus(stdout: string): AuthStatus | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = obj(JSON.parse(stdout.slice(start, end + 1)));
    if (!value) return null;
    return {
      loggedIn: value.loggedIn === true,
      authMethod: str(value.authMethod) ?? 'none',
      email: str(value.email) ?? str(value.emailAddress),
    };
  } catch {
    return null;
  }
}

const SUBSCRIPTION_METHODS = new Set(['claude.ai', 'oauth_token']);

export function describeClaudeAuth(
  exitCode: number | null,
  stdout: string,
): Pick<ProviderInfo, 'auth' | 'authDetail' | 'billing' | 'warnings'> {
  const status = parseAuthStatus(stdout);
  if (status && status.loggedIn) {
    const who = status.email ? ` as ${status.email}` : '';
    if (SUBSCRIPTION_METHODS.has(status.authMethod)) {
      return {
        auth: 'ok',
        authDetail: `Signed in with a Claude subscription${who}.`,
        billing: 'subscription',
        warnings: [],
      };
    }
    return {
      auth: 'ok',
      authDetail: `Signed in${who} (method: ${status.authMethod}).`,
      billing: 'api-key',
      warnings: [
        `Claude Code is signed in with "${status.authMethod}", so calls are billed to that account rather than a Claude subscription. To use your subscription, run \`claude\`, then \`/login\` and choose your Claude account.`,
      ],
    };
  }
  if (status || (exitCode !== null && exitCode !== 0)) {
    return { auth: 'missing', authDetail: `Not signed in. ${CLAUDE.loginHint}`, billing: 'unknown', warnings: [] };
  }
  return {
    auth: 'unknown',
    authDetail: 'The sign-in state could not be read from `claude auth status`. Use Test to verify.',
    billing: 'unknown',
    warnings: [],
  };
}

export function claudeProvider(cfg: CliConfig): Provider {
  return {
    id: CLAUDE.id,
    async info(signal) {
      const info = baseInfo(CLAUDE, cfg);
      const v = await detectVersion(CLAUDE, cfg, signal);
      if (!v.installed) return { ...info, authDetail: v.reason };
      const auth = await runCommand(commandFor(CLAUDE, cfg), ['auth', 'status'], {
        env: envFor(CLAUDE, cfg),
        timeoutMs: 10_000,
        signal,
        cliName: CLAUDE.cliName,
        installHint: CLAUDE.installHint,
      });
      const a = describeClaudeAuth(auth.exitCode, auth.stdout);
      return { ...info, installed: true, version: v.version, ...a, warnings: [...info.warnings, ...a.warnings] };
    },
    run(req) {
      const parser = createClaudeParser(req);
      return runCli(CLAUDE, cfg, req, claudeArgs(req, cfg.extraArgs), req.prompt, parser);
    },
  };
}
