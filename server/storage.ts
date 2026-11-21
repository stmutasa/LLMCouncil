import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Conversation, ConversationSummary } from '../shared/types';
import { parseMentions, type MentionTarget } from '../shared/mentions';
import { parseConversation } from './conversationSchema';
import { readFileIfExists, withFileLock, writeFileAtomic } from './util/fileQueue';

export const CONVERSATION_ID_RE = /^[0-9a-f-]{36}$/;

export function isValidConversationId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID_RE.test(id);
}

const TITLE_MAX = 60;

/** A local, model-free title: the first line of the first message, tidied and shortened. */
export function deriveTitle(message: string, members: MentionTarget[]): string {
  const cleaned = parseMentions(message, members).cleaned;
  const firstLine = cleaned.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const text = firstLine.replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';
  if (text.length <= TITLE_MAX) return text;
  const room = text.slice(0, TITLE_MAX - 1);
  const lastSpace = room.lastIndexOf(' ');
  const cut = lastSpace > 0 ? room.slice(0, lastSpace) : room;
  return cut.replace(/[\s,;:.\-–—]+$/, '') + '…';
}

export function summarize(conversation: Conversation, running: boolean): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    turnCount: conversation.turns.length,
    running,
  };
}

/** What the conversation list needs from a file, without keeping its turns in memory. */
export interface ListEntry {
  summary: Omit<ConversationSummary, 'running'>;
  /** A turn is stored as running; without a live run it has to be repaired. */
  hasRunningTurn: boolean;
}

export class InvalidIdError extends Error {
  constructor() {
    super('Invalid conversation id.');
    this.name = 'InvalidIdError';
  }
}

export class Storage {
  readonly conversationsDir: string;
  private readonly reportedCorrupt = new Set<string>();
  /** List entries by conversation id, valid while the file's size and modification time match. */
  private readonly listCache = new Map<string, { mtimeMs: number; size: number; entry: ListEntry | null }>();

  constructor(readonly dataDir: string) {
    this.conversationsDir = path.join(dataDir, 'conversations');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.conversationsDir, { recursive: true });
  }

  private fileFor(id: string): string {
    // The id is checked before it is ever joined into a path, which rules out traversal.
    if (!isValidConversationId(id)) throw new InvalidIdError();
    return path.join(this.conversationsDir, `${id}.json`);
  }

  private parse(file: string, raw: string): Conversation | null {
    try {
      const conversation = parseConversation(JSON.parse(raw));
      if (conversation) return conversation;
    } catch {
      // Reported below.
    }
    if (!this.reportedCorrupt.has(file)) {
      this.reportedCorrupt.add(file);
      console.warn(`[storage] Skipping unreadable conversation file: ${file}`);
    }
    return null;
  }

  private async read(file: string): Promise<Conversation | null> {
    const raw = await readFileIfExists(file);
    return raw === null ? null : this.parse(file, raw);
  }

  /** null when the conversation does not exist (or its file is unreadable). */
  async load(id: string): Promise<Conversation | null> {
    const file = this.fileFor(id);
    return withFileLock(file, () => this.read(file));
  }

  async create(conversation: Conversation): Promise<void> {
    const file = this.fileFor(conversation.id);
    await withFileLock(file, () => writeFileAtomic(file, JSON.stringify(conversation, null, 2)));
  }

  /**
   * Read-modify-write under the file's lock. Returns the saved conversation, or null when it
   * does not exist (for example because it was deleted while a run was finishing), in which case
   * nothing is written.
   */
  async update(
    id: string,
    mutate: (conversation: Conversation) => void,
  ): Promise<Conversation | null> {
    const file = this.fileFor(id);
    return withFileLock(file, async () => {
      const conversation = await this.read(file);
      if (!conversation) return null;
      mutate(conversation);
      await writeFileAtomic(file, JSON.stringify(conversation, null, 2));
      return conversation;
    });
  }

  /** false when there was nothing to delete. */
  async delete(id: string): Promise<boolean> {
    const file = this.fileFor(id);
    return withFileLock(file, async () => {
      try {
        await fs.unlink(file);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  private async conversationIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.conversationsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter(isValidConversationId);
  }

  /**
   * The sidebar's view of every readable conversation, most recently updated first. Files are
   * re-read only when they changed, so listing stays cheap however long the history grows.
   */
  async listEntries(): Promise<ListEntry[]> {
    const ids = await this.conversationIds();
    const present = new Set(ids);
    for (const id of this.listCache.keys()) if (!present.has(id)) this.listCache.delete(id);

    const entries = await Promise.all(
      ids.map(async (id) => {
        const file = this.fileFor(id);
        let stat: { mtimeMs: number; size: number };
        try {
          stat = await fs.stat(file);
        } catch {
          this.listCache.delete(id);
          return null;
        }
        const cached = this.listCache.get(id);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.entry;
        let conversation: Conversation | null;
        try {
          conversation = await this.load(id);
        } catch {
          conversation = null;
        }
        const entry: ListEntry | null = conversation
          ? {
              summary: {
                id: conversation.id,
                title: conversation.title,
                createdAt: conversation.createdAt,
                updatedAt: conversation.updatedAt,
                turnCount: conversation.turns.length,
              },
              hasRunningTurn: conversation.turns.some((t) => t.status === 'running'),
            }
          : null;
        this.listCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
        return entry;
      }),
    );
    const list = entries.filter((e): e is ListEntry => e !== null);
    list.sort((a, b) =>
      a.summary.updatedAt < b.summary.updatedAt ? 1 : a.summary.updatedAt > b.summary.updatedAt ? -1 : 0,
    );
    return list;
  }

  /** Every readable conversation, most recently updated first. */
  async list(): Promise<Conversation[]> {
    const ids = await this.conversationIds();
    const loaded = await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.load(id);
        } catch {
          return null;
        }
      }),
    );
    const conversations = loaded.filter((c): c is Conversation => c !== null);
    conversations.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return conversations;
  }
}
