import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileIfExists, withFileLock } from '../util/fileQueue';

interface Secrets {
  notionToken?: string;
}

/**
 * <data>/secrets.json, readable by the owner only where the platform supports it. Its contents
 * are never returned by the API, logged, or written anywhere else.
 */
export class SecretsStore {
  readonly file: string;
  private cache: Secrets | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'secrets.json');
  }

  private async read(): Promise<Secrets> {
    if (this.cache) return this.cache;
    let secrets: Secrets = {};
    try {
      const raw = await readFileIfExists(this.file);
      if (raw !== null) {
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const token = (value as Record<string, unknown>).notionToken;
          if (typeof token === 'string' && token !== '') secrets = { notionToken: token };
        }
      }
    } catch {
      // An unreadable secrets file means no stored token; the user can connect again.
      console.warn('[library] secrets.json could not be read; treating it as empty.');
    }
    this.cache = secrets;
    return secrets;
  }

  async notionToken(): Promise<string | null> {
    return (await this.read()).notionToken ?? null;
  }

  async setNotionToken(token: string | null): Promise<void> {
    await withFileLock(this.file, async () => {
      const next: Secrets = { ...(await this.read()) };
      if (token) next.notionToken = token;
      else delete next.notionToken;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      // Created with owner-only permissions before any secret is written into it.
      const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
      const handle = await fs.open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(next), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(tmp, 0o600).catch(() => undefined);
      try {
        await fs.rename(tmp, this.file);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      this.cache = next;
    });
  }
}
