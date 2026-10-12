import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'evals/test/**/*.test.ts'],
    exclude: ['packages/ui/**', '**/node_modules/**'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
