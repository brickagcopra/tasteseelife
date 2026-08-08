import { defineConfig } from 'vitest/config';

/**
 * service-activity unit-test configuration.
 *
 * Integration tests (against a real Postgres + Cassandra) land with
 * TS-009e (Testcontainers) — they will run under a separate vitest
 * project so the unit suite stays pure-Node + millisecond-fast.
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
