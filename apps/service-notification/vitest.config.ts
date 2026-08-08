import { defineConfig } from 'vitest/config';

/**
 * service-notification unit-test configuration.
 *
 * Integration tests (against a real Postgres + the MJML/Handlebars
 * pipeline under load) land with TS-009e (Testcontainers) and the
 * TS-072-followup-5 entry.
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
