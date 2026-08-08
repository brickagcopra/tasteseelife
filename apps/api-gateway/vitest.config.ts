import { defineConfig } from 'vitest/config';

/**
 * api-gateway unit-test configuration.
 *
 * Integration tests (against a live Redis container via Testcontainers
 * + an in-process downstream stub) land with TS-140-followup-2 once
 * TS-009e establishes Testcontainers infrastructure.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'test/app-module-graph.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/main.ts',
        'src/app.module.ts',
        'src/**/*.module.ts',
      ],
      reporter: ['text', 'lcov'],
    },
  },
});
