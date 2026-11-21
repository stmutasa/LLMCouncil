import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'web/src/**/*.test.ts'],
    testTimeout: 15000,
    pool: 'forks',
  },
});
