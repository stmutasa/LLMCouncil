import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../shared/types';
import { deriveTitle, InvalidIdError, isValidConversationId, Storage } from './storage';

const members = [
  { id: 'c', name: 'Claude' },
  { id: 'g', name: 'Gemini' },
];

describe('deriveTitle', () => {
  it('takes the first non-empty line without mentions, collapsing whitespace', () => {
    expect(deriveTitle('\n\n  @claude   what   is\tthis?\nsecond line', members)).toBe('what is this?');
  });

  it('cuts at a word boundary to at most 60 characters with an ellipsis', () => {
    const title = deriveTitle('word '.repeat(30), members);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('word…')).toBe(true);
    const long = deriveTitle('x'.repeat(100), members);
    expect(long).toBe('x'.repeat(59) + '…');
    expect(deriveTitle('a'.repeat(60), members)).toBe('a'.repeat(60));
  });

  it('falls back to "New chat"', () => {
    expect(deriveTitle('   \n ', members)).toBe('New chat');
    expect(deriveTitle('@claude', members)).toBe('New chat');
  });
});

function conversation(id: string, updatedAt: string): Conversation {
  return { id, title: 't', createdAt: updatedAt, updatedAt, turns: [] };
}

describe('Storage', () => {
  let dir: string;
  let storage: Storage;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'council-storage-'));
    storage = new Storage(dir);
    await storage.init();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('validates ids before touching the filesystem', async () => {
    expect(isValidConversationId(randomUUID())).toBe(true);
    for (const bad of ['../../etc/passwd', '..%2F..', '', 'x'.repeat(36), `${randomUUID()}/`, 'A'.repeat(36)]) {
      expect(isValidConversationId(bad)).toBe(false);
      await expect(storage.load(bad)).rejects.toBeInstanceOf(InvalidIdError);
      await expect(storage.delete(bad)).rejects.toBeInstanceOf(InvalidIdError);
    }
  });

  it('creates, loads, updates and deletes', async () => {
    const id = randomUUID();
    await storage.create(conversation(id, '2026-01-01T00:00:00.000Z'));
    expect((await storage.load(id))!.id).toBe(id);
    const updated = await storage.update(id, (c) => {
      c.title = 'renamed';
    });
    expect(updated!.title).toBe('renamed');
    expect((await storage.load(id))!.title).toBe('renamed');
    expect(await storage.delete(id)).toBe(true);
    expect(await storage.delete(id)).toBe(false);
    expect(await storage.load(id)).toBeNull();
    expect(await storage.update(id, () => undefined)).toBeNull();
    expect(await readdir(path.join(dir, 'conversations'))).toEqual([]);
  });

  it('serializes concurrent read-modify-write updates so none is lost', async () => {
    const id = randomUUID();
    await storage.create({ ...conversation(id, '2026-01-01T00:00:00.000Z'), title: '' });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        storage.update(id, (c) => {
          c.title += `${i},`;
        }),
      ),
    );
    const titles = (await storage.load(id))!.title.split(',').filter(Boolean);
    expect(titles).toHaveLength(40);
    expect((await readdir(path.join(dir, 'conversations'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('lists most recently updated first and skips corrupt or foreign files', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = randomUUID();
    const b = randomUUID();
    await storage.create(conversation(a, '2026-01-01T00:00:00.000Z'));
    await storage.create(conversation(b, '2026-03-01T00:00:00.000Z'));
    const corrupt = randomUUID();
    await writeFile(path.join(dir, 'conversations', `${corrupt}.json`), '{"id":');
    await writeFile(path.join(dir, 'conversations', 'notes.json'), '{}');
    await writeFile(path.join(dir, 'conversations', `${a}.json.1234.tmp`), 'partial');
    expect((await storage.list()).map((c) => c.id)).toEqual([b, a]);
    await storage.list();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
