import { defineConfig } from 'vitest/config';

/**
 * service-accounting unit-test configuration.
 *
 * Mirrors the layout of `service-identity`, `service-household`,
 * `service-subscription`, and `service-provider` so a future
 * consolidation of the per-service vitest configs into a shared
 * `packages/testing` is a code-move, not a behavioural change.
 *
 * Integration tests (PrismaService against a real Postgres) land with
 * TS-009e (Testcontainers); they will run under a separate vitest
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
