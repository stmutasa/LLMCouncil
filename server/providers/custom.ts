import type { CustomProviderConfig, ProviderInfo } from '../../shared/types';
import { cleanCliText, stripAnsi } from '../util/text';
import { detectVersion, exitFailure, type CliDescriptor } from './cli';
import { buildChildEnv } from './env';
import { runProcess } from './proc';
import { ProviderError, type CliConfig, type Provider, type RunRequest } from './types';

function descriptorFor(config: CustomProviderConfig): CliDescriptor {
  return {
    id: config.id,
    label: config.label,
    cliName: `${config.label} (custom command)`,
    vendor: 'Custom',
    defaultCommand: config.command,
    apiKeyVars: [],
    effortLevels: [],
    webSearch: 'none',
    streams: true,
    modelSuggestions: [],
    canListModels: false,
    installHint: `Check the command configured for the custom provider "${config.id}".`,
    loginHint: '',
    docsUrl: '',
  };
}

export function customArgs(
  config: CustomProviderConfig,
  req: Pick<RunRequest, 'model' | 'prompt'>,
  extraArgs: string[],
): string[] {
  const sub = (a: string) => a.split('{model}').join(req.model);
  const args = config.args.map(sub);
  if (req.model) args.push(...config.modelArgs.map(sub));
  args.push(...extraArgs);
  if (config.promptVia === 'arg') args.push(req.prompt);
  return args;
}

/** A user-defined CLI whose plain-text stdout is the answer. */
export function customProvider(config: CustomProviderConfig, cfg: CliConfig): Provider {
  const desc = descriptorFor(config);
  return {
    id: config.id,
    async info(signal): Promise<ProviderInfo> {
      const v = await detectVersion(desc, cfg, signal);
      return {
        id: config.id,
        label: config.label,
        cliName: desc.cliName,
        vendor: desc.vendor,
        kind: 'custom',
        command: cfg.command.trim() || config.command,
        installed: v.installed,
        version: v.installed ? v.version : null,
        auth: 'unknown',
        authDetail: v.installed ? 'Custom providers cannot report their sign-in state. Use Test to verify.' : v.reason,
        billing: 'unknown',
        warnings: [],
        effortLevels: [],
        webSearch: 'none',
        streams: true,
        modelSuggestions: [],
        canListModels: false,
        installHint: desc.installHint,
        loginHint: '',
        docsUrl: '',
      };
    },
    async run(req) {
      let raw = '';
      const res = await runProcess({
        command: cfg.command.trim() || config.command,
        args: customArgs(config, req, cfg.extraArgs),
        stdin: config.promptVia === 'stdin' ? req.prompt : null,
        env: buildChildEnv([], false),
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        cliName: desc.cliName,
        installHint: desc.installHint,
        onData: (chunk) => {
          raw += chunk;
          req.onText(stripAnsi(chunk), false);
        },
      });
      if (res.exitCode !== 0) {
        const err = exitFailure(desc, res);
        throw new ProviderError(err.message, res.diagnostics);
      }
      // The full output, cleaned in one piece, is authoritative over the streamed chunks.
      const text = cleanCliText(raw);
      if (!text) throw new ProviderError(`${desc.cliName} printed nothing.`, res.diagnostics);
      req.onText(text, true);
      return { text, model: null, billing: 'unknown', diagnostics: res.diagnostics };
    },
  };
}
