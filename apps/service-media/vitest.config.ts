import { defineConfig } from 'vitest/config';

/**
 * service-media unit-test configuration.
 *
 * Integration tests (against a real Postgres + a local mock S3 + a
 * ClamAV daemon) land with TS-110-followup-7 (Testcontainers). The
 * media-processor worker lands as its own app — TS-110-followup-1 — so
 * its tests live under that app's `vitest.config.ts`, not here.
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
