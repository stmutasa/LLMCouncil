import { DEFAULT_PROVIDER_SETTINGS } from '../../shared/defaults';
import type { ProviderInfo, ProviderModelsResult, Settings } from '../../shared/types';
import { antigravityProvider, ANTIGRAVITY } from './antigravity';
import { claudeProvider, CLAUDE } from './claude';
import { baseInfo, type CliDescriptor } from './cli';
import { codexProvider, CODEX } from './codex';
import { customProvider } from './custom';
import { mockProvider, MOCK_ID } from './mock';
import type { ProviderSource } from '../engine/orchestrator';
import type { CliConfig, Provider } from './types';

const BUILTINS: { desc: CliDescriptor; create: (cfg: CliConfig, homeDir?: string) => Provider }[] = [
  { desc: CLAUDE, create: (cfg) => claudeProvider(cfg) },
  { desc: CODEX, create: (cfg) => codexProvider(cfg) },
  { desc: ANTIGRAVITY, create: (cfg, homeDir) => antigravityProvider(cfg, homeDir) },
];

const CACHE_MS = 60_000;
const DETECT_TIMEOUT_MS = 10_000;

export interface RegistryOptions {
  mock: boolean;
  /** Replaces the home directory used to find CLI settings files (tests). */
  homeDir?: string;
  /** Replaces or adds providers by id (tests). */
  overrides?: Record<string, Provider>;
  detectTimeoutMs?: number;
}

export function cliConfigFor(settings: Settings, id: string): CliConfig {
  return {
    ...DEFAULT_PROVIDER_SETTINGS,
    ...(settings.providers[id] ?? {}),
    stripApiKeys: settings.stripApiKeys,
  };
}

export function timeoutMsFor(settings: Settings, id: string): number {
  const own = settings.providers[id]?.timeoutSec ?? 0;
  return (own > 0 ? own : settings.defaultTimeoutSec) * 1000;
}

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, what: string): Promise<T> {
  const ctl = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      ctl.abort();
      reject(new Error(`${what} did not respond within ${ms / 1000} s.`));
    }, ms);
    work(ctl.signal).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export class ProviderRegistry implements ProviderSource {
  private cache: { key: string; at: number; infos: Promise<ProviderInfo[]> } | null = null;
  /** Billing mode per provider from the most recent detection. */
  private readonly billing = new Map<string, ProviderInfo['billing']>();

  constructor(readonly options: RegistryOptions) {}

  billingHint(id: string): ProviderInfo['billing'] {
    return this.billing.get(id) ?? 'unknown';
  }

  /** Provider ids that settings may refer to, in display order. */
  ids(settings: Settings): string[] {
    const ids: string[] = BUILTINS.map((b) => b.desc.id);
    for (const cp of settings.customProviders) ids.push(cp.id);
    if (this.options.mock) ids.push(MOCK_ID);
    for (const id of Object.keys(this.options.overrides ?? {})) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  /** A provider bound to the given settings snapshot, or null when the id is not available. */
  get(id: string, settings: Settings): Provider | null {
    const override = this.options.overrides?.[id];
    if (override) return override;
    const builtin = BUILTINS.find((b) => b.desc.id === id);
    if (builtin) return builtin.create(cliConfigFor(settings, id), this.options.homeDir);
    const custom = settings.customProviders.find((c) => c.id === id);
    if (custom) return customProvider(custom, cliConfigFor(settings, id));
    if (id === MOCK_ID && this.options.mock) return mockProvider();
    return null;
  }

  webSearchSupport(id: string): ProviderInfo['webSearch'] {
    return BUILTINS.find((b) => b.desc.id === id)?.desc.webSearch ?? 'none';
  }

  /** Whether the provider can open library files itself; custom CLIs never get the mirror. */
  browseSupport(id: string): ProviderInfo['browse'] {
    const builtin = BUILTINS.find((b) => b.desc.id === id);
    if (builtin) return builtin.desc.browse;
    return id === MOCK_ID ? 'yes' : 'no';
  }

  timeoutMs(id: string, settings: Settings): number {
    return timeoutMsFor(settings, id);
  }

  /** Short label for a provider id ("Claude"), falling back to the id itself. */
  label(id: string, settings: Settings): string {
    const builtin = BUILTINS.find((b) => b.desc.id === id);
    if (builtin) return builtin.desc.label;
    const custom = settings.customProviders.find((c) => c.id === id);
    if (custom) return custom.label;
    if (id === MOCK_ID && this.options.mock) return 'Demo';
    return id;
  }

  private fallbackInfo(id: string, settings: Settings, reason: string): ProviderInfo {
    const builtin = BUILTINS.find((b) => b.desc.id === id);
    const base: ProviderInfo = builtin
      ? baseInfo(builtin.desc, cliConfigFor(settings, id))
      : {
          id,
          label: this.label(id, settings),
          cliName: this.label(id, settings),
          vendor: 'Custom',
          kind: id === MOCK_ID ? 'mock' : 'custom',
          command: cliConfigFor(settings, id).command,
          installed: false,
          version: null,
          auth: 'unknown',
          authDetail: '',
          billing: 'unknown',
          warnings: [],
          effortLevels: [],
          webSearch: 'none',
          streams: true,
          browse: id === MOCK_ID ? 'yes' : 'no',
          modelSuggestions: [],
          canListModels: false,
          installHint: '',
          loginHint: '',
          docsUrl: '',
        };
    return { ...base, installed: false, authDetail: reason };
  }

  private cacheKey(settings: Settings): string {
    return JSON.stringify([settings.providers, settings.customProviders, settings.stripApiKeys]);
  }

  /** Detection for every provider, cached for a minute (or until provider settings change). */
  listInfo(settings: Settings, opts: { refresh?: boolean } = {}): Promise<ProviderInfo[]> {
    const key = this.cacheKey(settings);
    const now = Date.now();
    if (!opts.refresh && this.cache && this.cache.key === key && now - this.cache.at < CACHE_MS) {
      return this.cache.infos;
    }
    const infos = Promise.all(
      this.ids(settings).map(async (id) => {
        const provider = this.get(id, settings);
        if (!provider) return this.fallbackInfo(id, settings, `Provider '${id}' is not available.`);
        try {
          return await withTimeout(
            (signal) => provider.info(signal),
            this.options.detectTimeoutMs ?? DETECT_TIMEOUT_MS,
            `${this.label(id, settings)}`,
          );
        } catch (err) {
          return this.fallbackInfo(id, settings, `Detection failed: ${(err as Error).message}`);
        }
      }),
    );
    this.cache = { key, at: now, infos };
    void infos.then((list) => {
      for (const info of list) this.billing.set(info.id, info.billing);
    });
    return infos;
  }

  async listModels(id: string, settings: Settings): Promise<ProviderModelsResult | null> {
    const provider = this.get(id, settings);
    if (!provider) return null;
    const builtin = BUILTINS.find((b) => b.desc.id === id);
    const suggestions = builtin ? [...builtin.desc.modelSuggestions] : [];
    if (!provider.listModels) return { models: suggestions, source: 'static', error: null };
    try {
      const models = await withTimeout((signal) => provider.listModels!(signal), 30_000, 'The model list command');
      if (models.length === 0) {
        return { models: suggestions, source: 'static', error: 'The CLI returned no models; showing suggestions instead.' };
      }
      return { models, source: 'cli', error: null };
    } catch (err) {
      return { models: suggestions, source: 'static', error: (err as Error).message };
    }
  }
}
