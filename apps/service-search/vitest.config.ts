import { defineConfig } from 'vitest/config';

/**
 * service-search unit-test configuration.
 *
 * Integration tests (against a live Elasticsearch container via
 * Testcontainers) land with TS-111-followup-2 once the live `@elastic/elasticsearch`
 * client wiring lands (TS-111-followup-1) and TS-009e establishes the
 * Testcontainers infrastructure.
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
