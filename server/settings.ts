import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  ArbiterConfig,
  CustomProviderConfig,
  FolderSource,
  LibrarySettings,
  MemberConfig,
  NotionSource,
  Protocol,
  ProviderSettings,
  RoundConfig,
  Settings,
} from '../shared/types';
import {
  BUILTIN_PROTOCOLS,
  DEFAULT_PROTOCOL_ID,
  DEFAULT_PROVIDER_SETTINGS,
  LIMITS,
  MEMBER_COLORS,
  ROLES,
  defaultSettings,
} from '../shared/defaults';
import { mentionHandle } from '../shared/mentions';
import { folderPathProblem, isWithin } from './library/sources/folder';
import { readFileIfExists, withFileLock, writeFileAtomic } from './util/fileQueue';

export const BUILTIN_PROVIDER_IDS = ['claude', 'codex', 'antigravity'] as const;
export const MOCK_PROVIDER_ID = 'mock';
export const CUSTOM_PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

/** Thrown for settings that fail validation; the message is shown to the user as is. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

const providerSettingsSchema = z.object({
  command: z.string(),
  extraArgs: z.array(z.string()),
  timeoutSec: z.number().int(),
  promptMode: z.enum(['stdin', 'arg']),
}) satisfies z.ZodType<ProviderSettings>;

const customProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  modelArgs: z.array(z.string()),
  promptVia: z.enum(['stdin', 'arg']),
}) satisfies z.ZodType<CustomProviderConfig>;

const memberSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
  roleId: z.string(),
  customRole: z.string(),
  enabled: z.boolean(),
  color: z.string(),
}) satisfies z.ZodType<MemberConfig>;

const roundSchema = z.object({
  id: z.string(),
  type: z.enum(['answer', 'review', 'revise']),
  title: z.string(),
  instructions: z.string(),
  anonymize: z.boolean(),
  includeSelf: z.boolean(),
}) satisfies z.ZodType<RoundConfig>;

const protocolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  builtin: z.boolean(),
  rounds: z.array(roundSchema),
}) satisfies z.ZodType<Protocol>;

const arbiterSchema = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  effort: z.string(),
  instructions: z.string(),
  analysis: z.boolean(),
}) satisfies z.ZodType<ArbiterConfig>;

const folderSourceSchema = z.object({
  id: z.string(),
  kind: z.literal('folder'),
  name: z.string(),
  enabled: z.boolean(),
  path: z.string(),
}) satisfies z.ZodType<FolderSource>;

const notionSourceSchema = z.object({
  id: z.string(),
  kind: z.literal('notion'),
  name: z.string(),
  enabled: z.boolean(),
}) satisfies z.ZodType<NotionSource>;

const librarySchema = z.object({
  sources: z.array(z.discriminatedUnion('kind', [folderSourceSchema, notionSourceSchema])),
  mode: z.enum(['off', 'search', 'browse']),
  excerptChars: z.number().int(),
  attachmentChars: z.number().int(),
  planner: z.object({ enabled: z.boolean(), provider: z.string(), model: z.string(), effort: z.string() }),
  browseUntested: z.boolean(),
  autoSyncMinutes: z.number().int(),
  notionSaveParent: z.object({ id: z.string(), title: z.string() }).nullable(),
}) satisfies z.ZodType<LibrarySettings>;

export const settingsSchema = z.object({
  version: z.literal(1),
  members: z.array(memberSchema),
  protocols: z.array(protocolSchema),
  activeProtocolId: z.string(),
  arbiter: arbiterSchema,
  councilRules: z.string(),
  webSearch: z.boolean(),
  defaultTimeoutSec: z.number().int(),
  maxHistoryChars: z.number().int(),
  stripApiKeys: z.boolean(),
  providers: z.record(z.string(), providerSettingsSchema),
  customProviders: z.array(customProviderSchema),
  library: librarySchema,
}) satisfies z.ZodType<Settings>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Objects merge key by key; anything else (arrays included) is taken from `value` when present. */
function mergeOnto(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return structuredClone(defaults);
  if (isPlainObject(defaults) && isPlainObject(value)) {
    const out: Record<string, unknown> = { ...value };
    for (const [key, def] of Object.entries(defaults)) out[key] = mergeOnto(def, value[key]);
    return out;
  }
  return value;
}

function fillEach(list: unknown, template: (index: number) => Record<string, unknown>): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((item, i) => (isPlainObject(item) ? mergeOnto(template(i), item) : item));
}

/**
 * Fills keys missing from a stored or submitted settings object with defaults, so files written
 * by an older version keep loading. Values that are present are never changed here.
 */
export function fillDefaults(raw: unknown, mock: boolean): unknown {
  const merged = mergeOnto(defaultSettings(mock), raw);
  if (!isPlainObject(merged)) return merged;
  merged.members = fillEach(merged.members, (i) => ({
    model: '',
    effort: '',
    roleId: 'none',
    customRole: '',
    enabled: true,
    color: MEMBER_COLORS[i % MEMBER_COLORS.length]!,
  }));
  merged.protocols = fillEach(merged.protocols, () => ({ description: '', builtin: false }));
  if (Array.isArray(merged.protocols)) {
    for (const p of merged.protocols) {
      if (isPlainObject(p)) {
        p.rounds = fillEach(p.rounds, () => ({
          title: '',
          instructions: '',
          anonymize: false,
          includeSelf: false,
        }));
      }
    }
  }
  merged.customProviders = fillEach(merged.customProviders, () => ({
    args: [],
    modelArgs: [],
    promptVia: 'stdin',
  }));
  if (isPlainObject(merged.library)) {
    merged.library.sources = fillEach(merged.library.sources, () => ({ enabled: true }));
  }
  if (isPlainObject(merged.providers)) {
    for (const [id, p] of Object.entries(merged.providers)) {
      merged.providers[id] = isPlainObject(p) ? mergeOnto(DEFAULT_PROVIDER_SETTINGS, p) : p;
    }
  }
  return merged;
}

function describePath(pathParts: readonly PropertyKey[]): string {
  let out = '';
  for (const part of pathParts) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out || 'settings';
}

export function parseSettingsShape(value: unknown): Settings {
  const result = settingsSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new SettingsError(`Invalid settings at ${describePath(issue.path)}: ${issue.message}.`);
  }
  return result.data;
}

/** Built-in presets always come from code; user protocols keep their place after them. */
export function syncBuiltinProtocols(settings: Settings): Settings {
  const builtinIds = new Set(BUILTIN_PROTOCOLS.map((p) => p.id));
  const user = settings.protocols
    .filter((p) => !builtinIds.has(p.id))
    .map((p) => ({ ...p, builtin: false }));
  const protocols = [...BUILTIN_PROTOCOLS.map((p) => structuredClone(p)), ...user];
  const activeProtocolId = protocols.some((p) => p.id === settings.activeProtocolId)
    ? settings.activeProtocolId
    : DEFAULT_PROTOCOL_ID;
  return { ...settings, protocols, activeProtocolId };
}

// Models and efforts become command-line arguments; refusing a leading dash or whitespace keeps
// a value from being read as an extra flag.
const MODEL_RE = /^[^\s-][^\s]{0,99}$/;
const EFFORT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/;

export function checkModel(model: string, where: string): void {
  if (model !== '' && !MODEL_RE.test(model)) {
    throw new SettingsError(
      `${where}: the model "${model}" is not valid. Use a model name without spaces that does not start with "-", or leave it empty for the CLI default.`,
    );
  }
}

export function checkEffort(effort: string, where: string): void {
  if (effort !== '' && !EFFORT_RE.test(effort)) {
    throw new SettingsError(
      `${where}: the effort "${effort}" is not valid. Use a single word such as "high", or leave it empty for the CLI default.`,
    );
  }
}

function checkText(value: string, max: number, where: string): void {
  if (value.length > max) {
    throw new SettingsError(`${where} is too long (${value.length} characters; the limit is ${max}).`);
  }
}

export interface SemanticOptions {
  /** Whether the mock provider is registered. */
  mock: boolean;
  /** On load, unknown providers are tolerated so files written in mock mode still open. */
  allowUnknownProviders: boolean;
  /**
   * The app's data directory. When given (on save), folder sources are checked: full paths, not
   * a drive's top, not the data directory or a folder around or inside it. On load they are
   * not, so a file stays usable when the data directory moves; such a source is reported as not
   * ready instead.
   */
  dataDir?: string;
}

export const SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SOURCE_NAME = 60;

function checkLibrary(lib: LibrarySettings, opts: SemanticOptions, checkProvider: (provider: string, where: string) => void): void {
  if (lib.sources.length > LIMITS.maxLibrarySources) {
    throw new SettingsError(`The library can have at most ${LIMITS.maxLibrarySources} sources.`);
  }
  const ids = new Set<string>();
  const names = new Map<string, string>();
  const folders: { name: string; path: string }[] = [];
  let notion = 0;
  lib.sources.forEach((src, i) => {
    const name = src.name.trim();
    const where = name ? `Library source "${name}"` : `Library source ${i + 1}`;
    if (!SOURCE_ID_RE.test(src.id)) {
      throw new SettingsError(`${where}: the id "${src.id}" is not valid. Use 1–64 letters, digits, dashes or underscores.`);
    }
    if (ids.has(src.id)) throw new SettingsError(`Two library sources share the id "${src.id}".`);
    ids.add(src.id);
    if (!name) throw new SettingsError(`Library source ${i + 1} needs a name.`);
    if (name.length > MAX_SOURCE_NAME) {
      throw new SettingsError(`${where}: names can be at most ${MAX_SOURCE_NAME} characters.`);
    }
    const lower = name.toLowerCase();
    if (names.has(lower)) throw new SettingsError(`Two library sources are named "${name}". Source names must be unique.`);
    names.set(lower, name);
    if (src.kind === 'notion') {
      notion++;
      if (notion > 1) throw new SettingsError('The library can have only one Notion source.');
      return;
    }
    checkText(src.path, 4096, `${where}: the folder path`);
    if (opts.dataDir === undefined) return;
    const problem = folderPathProblem(src.path, opts.dataDir);
    if (problem) throw new SettingsError(`${where}: ${problem}`);
    for (const other of folders) {
      if (isWithin(src.path, other.path) || isWithin(other.path, src.path)) {
        throw new SettingsError(
          `Library sources "${other.name}" and "${name}" overlap: one folder is the same as, or inside, the other. Each document should come from one source only.`,
        );
      }
    }
    folders.push({ name, path: src.path });
  });

  if (lib.excerptChars < LIMITS.minExcerptChars || lib.excerptChars > LIMITS.maxExcerptChars) {
    throw new SettingsError(
      `The passage budget must be between ${LIMITS.minExcerptChars.toLocaleString('en-US')} and ${LIMITS.maxExcerptChars.toLocaleString('en-US')} characters.`,
    );
  }
  if (lib.attachmentChars < LIMITS.minAttachmentChars || lib.attachmentChars > LIMITS.maxAttachmentChars) {
    throw new SettingsError(
      `The attachment budget must be between ${LIMITS.minAttachmentChars.toLocaleString('en-US')} and ${LIMITS.maxAttachmentChars.toLocaleString('en-US')} characters.`,
    );
  }
  checkProvider(lib.planner.provider, 'The search planner');
  checkModel(lib.planner.model, 'The search planner');
  checkEffort(lib.planner.effort, 'The search planner');
  if (lib.autoSyncMinutes !== 0 && (lib.autoSyncMinutes < 5 || lib.autoSyncMinutes > 1440)) {
    throw new SettingsError('Checking for changes must be every 5 to 1,440 minutes, or 0 to check only when asked.');
  }
  const parent = lib.notionSaveParent;
  if (parent) {
    if (parent.id.length < 1 || parent.id.length > 64) {
      throw new SettingsError('The Notion page to save answers under has an invalid id.');
    }
    checkText(parent.title, 300, 'The title of the Notion page to save answers under');
  }
}

/** Rules zod cannot express. Throws SettingsError with a message naming the offending field. */
export function checkSemantics(s: Settings, opts: SemanticOptions): void {
  // Custom providers first, because members may refer to them.
  const builtinIds = new Set<string>([...BUILTIN_PROVIDER_IDS, MOCK_PROVIDER_ID]);
  const customIds = new Set<string>();
  s.customProviders.forEach((cp, i) => {
    const where = `Custom provider ${i + 1}`;
    if (!CUSTOM_PROVIDER_ID_RE.test(cp.id)) {
      throw new SettingsError(
        `${where}: the id "${cp.id}" is not valid. Use 2–31 lower-case letters, digits or dashes, starting with a letter.`,
      );
    }
    if (builtinIds.has(cp.id)) {
      throw new SettingsError(`${where}: the id "${cp.id}" is reserved for a built-in provider.`);
    }
    if (customIds.has(cp.id)) throw new SettingsError(`Two custom providers use the id "${cp.id}".`);
    customIds.add(cp.id);
    if (!cp.label.trim()) throw new SettingsError(`Custom provider "${cp.id}" needs a label.`);
    checkText(cp.label, LIMITS.maxNameChars, `The label of custom provider "${cp.id}"`);
    if (!cp.command.trim()) throw new SettingsError(`Custom provider "${cp.id}" needs a command.`);
    checkText(cp.command, 1000, `The command of custom provider "${cp.id}"`);
  });

  const knownProviders = new Set<string>([...BUILTIN_PROVIDER_IDS, ...customIds]);
  if (opts.mock) knownProviders.add(MOCK_PROVIDER_ID);
  const checkProvider = (provider: string, where: string) => {
    if (opts.allowUnknownProviders || knownProviders.has(provider)) return;
    throw new SettingsError(
      `${where} uses the provider "${provider}", which is not available. Choose one of: ${[...knownProviders].join(', ')}.`,
    );
  };

  if (s.members.length < 1) throw new SettingsError('The council needs at least one member.');
  if (s.members.length > LIMITS.maxMembers) {
    throw new SettingsError(`The council can have at most ${LIMITS.maxMembers} members.`);
  }
  const ids = new Set<string>();
  const names = new Map<string, string>();
  const handles = new Map<string, string>();
  const roleIds = new Set(ROLES.map((r) => r.id));
  s.members.forEach((m, i) => {
    const name = m.name.trim();
    const where = name ? `Member "${name}"` : `Member ${i + 1}`;
    if (!m.id.trim()) throw new SettingsError(`Member ${i + 1} has no id.`);
    if (ids.has(m.id)) throw new SettingsError(`Two members share the id "${m.id}".`);
    ids.add(m.id);
    if (!name) throw new SettingsError(`Member ${i + 1} needs a name.`);
    if (name.length > LIMITS.maxNameChars) {
      throw new SettingsError(`${where}: names can be at most ${LIMITS.maxNameChars} characters.`);
    }
    const lower = name.toLowerCase();
    if (names.has(lower)) {
      throw new SettingsError(`Two members are named "${name}". Member names must be unique.`);
    }
    names.set(lower, name);
    const handle = mentionHandle(name);
    if (!handle) {
      throw new SettingsError(`${where}: the name needs at least one letter or digit so it can be @mentioned.`);
    }
    const clash = handles.get(handle);
    if (clash) {
      throw new SettingsError(
        `Members "${clash}" and "${name}" would both be addressed as @${handle}. Rename one of them.`,
      );
    }
    handles.set(handle, name);
    if (!/^#[0-9a-fA-F]{6}$/.test(m.color)) {
      throw new SettingsError(`${where}: the colour "${m.color}" is not a #rrggbb hex colour.`);
    }
    checkProvider(m.provider, where);
    checkModel(m.model, where);
    checkEffort(m.effort, where);
    if (!roleIds.has(m.roleId)) throw new SettingsError(`${where}: unknown role "${m.roleId}".`);
    checkText(m.customRole, LIMITS.maxRulesChars, `${where}: the custom role`);
  });

  const arbiterName = s.arbiter.name.trim();
  if (!arbiterName) throw new SettingsError('The arbiter needs a name.');
  if (arbiterName.length > LIMITS.maxNameChars) {
    throw new SettingsError(`The arbiter's name can be at most ${LIMITS.maxNameChars} characters.`);
  }
  checkProvider(s.arbiter.provider, 'The arbiter');
  checkModel(s.arbiter.model, 'The arbiter');
  checkEffort(s.arbiter.effort, 'The arbiter');
  checkText(s.arbiter.instructions, LIMITS.maxRulesChars, "The arbiter's instructions");

  const protocolIds = new Set<string>();
  for (const p of s.protocols) {
    const where = `Protocol "${p.name.trim() || p.id}"`;
    if (!p.id.trim()) throw new SettingsError('Every protocol needs an id.');
    if (protocolIds.has(p.id)) throw new SettingsError(`Two protocols share the id "${p.id}".`);
    protocolIds.add(p.id);
    if (!p.name.trim()) throw new SettingsError(`Protocol "${p.id}" needs a name.`);
    checkText(p.name, 80, `${where}: the name`);
    checkText(p.description, LIMITS.maxRulesChars, `${where}: the description`);
    if (p.rounds.length < 1) throw new SettingsError(`${where} needs at least one round.`);
    if (p.rounds.length > LIMITS.maxRounds) {
      throw new SettingsError(`${where} has ${p.rounds.length} rounds; the limit is ${LIMITS.maxRounds}.`);
    }
    const roundIds = new Set<string>();
    p.rounds.forEach((r, i) => {
      if (!r.id.trim()) throw new SettingsError(`${where}: round ${i + 1} has no id.`);
      if (roundIds.has(r.id)) throw new SettingsError(`${where}: two rounds share the id "${r.id}".`);
      roundIds.add(r.id);
      if (i === 0 && r.type !== 'answer') {
        throw new SettingsError(`${where}: round 1 must be "Independent answers".`);
      }
      if (i > 0 && r.type === 'answer') {
        throw new SettingsError(
          `${where}: round ${i + 1} must be "Peer review & ranking" or "Rebuttal & revision"; only round 1 collects independent answers.`,
        );
      }
      checkText(r.title, 80, `${where}: the title of round ${i + 1}`);
      checkText(r.instructions, LIMITS.maxRulesChars, `${where}: the rules for round ${i + 1}`);
    });
  }

  checkText(s.councilRules, LIMITS.maxRulesChars, 'The council rules');
  const { minTimeoutSec, maxTimeoutSec } = LIMITS;
  if (s.defaultTimeoutSec < minTimeoutSec || s.defaultTimeoutSec > maxTimeoutSec) {
    throw new SettingsError(
      `The default timeout must be between ${minTimeoutSec} and ${maxTimeoutSec} seconds.`,
    );
  }
  if (s.maxHistoryChars < 0 || s.maxHistoryChars > 1_000_000) {
    throw new SettingsError('The history budget must be between 0 and 1,000,000 characters.');
  }
  checkLibrary(s.library, opts, checkProvider);
  for (const [id, p] of Object.entries(s.providers)) {
    if (p.timeoutSec !== 0 && (p.timeoutSec < minTimeoutSec || p.timeoutSec > maxTimeoutSec)) {
      throw new SettingsError(
        `The timeout for provider "${id}" must be 0 (use the default) or between ${minTimeoutSec} and ${maxTimeoutSec} seconds.`,
      );
    }
    checkText(p.command, 1000, `The command for provider "${id}"`);
    if (p.extraArgs.length > 64) throw new SettingsError(`Provider "${id}" has too many extra arguments.`);
    p.extraArgs.forEach((a) => checkText(a, 1000, `An extra argument for provider "${id}"`));
  }
}

/** Shape check, defaults, built-in re-sync and semantic rules, in that order. */
export function normalizeSettings(raw: unknown, opts: SemanticOptions): Settings {
  const shaped = parseSettingsShape(fillDefaults(raw, opts.mock));
  const synced = syncBuiltinProtocols(shaped);
  checkSemantics(synced, opts);
  return synced;
}

export class SettingsStore {
  readonly file: string;
  private current: Settings;

  constructor(
    readonly dataDir: string,
    private readonly mock: boolean,
  ) {
    this.file = path.join(dataDir, 'settings.json');
    this.current = syncBuiltinProtocols(defaultSettings(mock));
  }

  /** Reads the settings file. An unusable file is moved aside so the user's data is not lost. */
  async load(): Promise<Settings> {
    const raw = await withFileLock(this.file, () => readFileIfExists(this.file));
    if (raw === null) {
      this.current = syncBuiltinProtocols(defaultSettings(this.mock));
      return this.get();
    }
    try {
      this.current = normalizeSettings(JSON.parse(raw), { mock: this.mock, allowUnknownProviders: true });
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const aside = path.join(this.dataDir, `settings.invalid-${stamp}.json`);
      const reason = err instanceof SyntaxError ? `not valid JSON (${err.message})` : (err as Error).message;
      await withFileLock(this.file, () => fs.rename(this.file, aside)).catch(() => undefined);
      console.warn(`[settings] ${this.file} could not be used: ${reason} It was moved to ${aside}; using defaults.`);
      this.current = syncBuiltinProtocols(defaultSettings(this.mock));
    }
    return this.get();
  }

  /** A deep copy, so callers can neither mutate the stored settings nor see later changes. */
  get(): Settings {
    return structuredClone(this.current);
  }

  async save(input: unknown): Promise<Settings> {
    const next = normalizeSettings(input, { mock: this.mock, allowUnknownProviders: false, dataDir: this.dataDir });
    await withFileLock(this.file, () => writeFileAtomic(this.file, JSON.stringify(next, null, 2)));
    this.current = next;
    return this.get();
  }
}
