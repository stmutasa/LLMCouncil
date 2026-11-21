import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './app';
import { parseCliOptions } from './options';

describe('parseCliOptions', () => {
  it('uses defaults relative to the repository, not the working directory', () => {
    expect(parseCliOptions([], {})).toEqual({ port: 8787, host: '127.0.0.1', dataDir: path.join(REPO_ROOT, 'data'), mock: false });
  });

  it('reads environment variables, and flags win over them', () => {
    const env = { PORT: '9000', COUNCIL_DATA_DIR: '/tmp/env-data', COUNCIL_MOCK: '1' };
    expect(parseCliOptions([], env)).toEqual({ port: 9000, host: '127.0.0.1', dataDir: '/tmp/env-data', mock: true });
    expect(parseCliOptions(['--port', '8791', '--data-dir=/tmp/flag-data', '--host', 'localhost'], env)).toEqual({
      port: 8791,
      host: 'localhost',
      dataDir: '/tmp/flag-data',
      mock: true,
    });
    expect(parseCliOptions(['--mock'], {}).mock).toBe(true);
  });

  it('rejects bad input with the usage line', () => {
    expect(() => parseCliOptions(['--port', 'abc'], {})).toThrow(/whole number between 0 and 65535/);
    expect(() => parseCliOptions(['--port'], {})).toThrow(/--port needs a value/);
    expect(() => parseCliOptions(['--verbose'], {})).toThrow(/Unknown option --verbose\. Usage:/);
  });
});
