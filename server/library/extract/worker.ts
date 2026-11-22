/**
 * Extraction worker: a separate process, so that a malformed file that hangs a parser or
 * exhausts memory takes down only this process. It reads one file per message and replies with
 * its parts. Started by extractor.ts with `child_process.fork`.
 */
import path from 'node:path';
import type { ExtractResult } from '../types';
import { extractFile } from './formats';

export interface WorkerRequest {
  id: number;
  file: string;
  type: string;
  /** The source folder; the file is read only if it is really inside it. */
  root?: string;
}

export interface WorkerResponse {
  id: number;
  result: ExtractResult;
}

const testHooks = process.env.COUNCIL_EXTRACT_TEST_HOOKS === '1';

process.on('message', (message: WorkerRequest) => {
  void (async () => {
    if (testHooks) {
      // Test-only behaviours, enabled by the parent only when a test asks for them.
      const name = path.basename(message.file);
      if (name.includes('__hang__')) for (;;);
      if (name.includes('__crash__')) process.exit(7);
    }
    const result = await extractFile(message.file, message.type, message.root);
    const response: WorkerResponse = { id: message.id, result };
    process.send?.(response);
  })();
});

// A parser may leave a stray rejection behind after its file has been answered. Crashing on it
// would fail whichever file is being read next, so it is ignored; a real hang hits the timeout.
process.on('unhandledRejection', () => undefined);

// The server went away (or closed the channel): there is nobody left to work for.
process.on('disconnect', () => process.exit(0));
