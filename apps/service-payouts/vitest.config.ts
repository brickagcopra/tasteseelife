import { defineConfig } from 'vitest/config';

/**
 * service-payouts unit-test configuration.
 *
 * Integration tests (against a real Postgres + Stripe test mode) land
 * with TS-009e (Testcontainers) — they run under a separate vitest
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
