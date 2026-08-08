import { compileAppModuleGraph } from '@taste-and-see/testing';
import { describe, expect, it } from 'vitest';

/**
 * Boot-graph guard for worker-wellness-summary (TS-506).
 *
 * Compiles the REAL `AppModule` and asserts Nest can resolve every
 * dependency in it. This is the test whose absence let 8 of 20 services
 * ship unable to start: the unit suites all build narrow, hand-wired
 * `Test.createTestingModule` graphs, so a provider that no module
 * declared was invisible until a process actually booted.
 *
 * It compiles only — no `init()`, so no `onModuleInit`, no Postgres, no
 * Redis. See `compileAppModuleGraph` for what that does and does not
 * cover.
 *
 * `STUB_ENV` must satisfy this service's own `loadEnv()`. When a new
 * required env var is added, this test fails first — which is the
 * cheapest place to find out.
 */
const STUB_ENV: Record<string, string> = {
  BOOKING_SERVICE_BASE_URL: 'http://127.0.0.1:1/stub',
  BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY:
    'stub-value-long-enough-for-min-length-checks-0123456789',
  BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: 'x-internal-api-key',
  HOUSEHOLD_SERVICE_BASE_URL: 'http://127.0.0.1:1/stub',
  HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY:
    'stub-value-long-enough-for-min-length-checks-0123456789',
  HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: 'x-internal-api-key',
  IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'stub-value-long-enough-for-min-length-checks-0123456789',
  IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-internal-api-key',
  IDENTITY_SERVICE_BASE_URL: 'http://127.0.0.1:1/stub',
  LOG_LEVEL: 'warn',
  NODE_ENV: 'test',
  NOTIFICATION_DISPATCH_API_KEY: 'stub-value-long-enough-for-min-length-checks-0123456789',
  NOTIFICATION_DISPATCH_HEADER_NAME: 'x-internal-api-key',
  NOTIFICATION_SERVICE_BASE_URL: 'http://127.0.0.1:1/stub',
  PORT: '3999',
  SERVICE_VERSION: 'boot-graph-test',
  WELLNESS_SUMMARY_APP_NAME: 'stub-value-long-enough-for-min-length-checks-0123456789',
  WELLNESS_SUMMARY_ENABLED: 'false',
};

describe('worker-wellness-summary AppModule dependency graph', () => {
  it('resolves every provider', async () => {
    await expect(
      compileAppModuleGraph({
        env: STUB_ENV,
        importAppModule: async () => import('../src/app.module'),
      }),
    ).resolves.toBeUndefined();
    // Generous, and deliberately so: this test imports the service's whole
    // dependency tree (Prisma client included) and runs Nest's injector over
    // it. Under `turbo run test` the 20 services compile concurrently and a
    // cold import can take ~10s on a loaded machine. vitest's 5s default made
    // this flaky — a different service failed on each full run.
  }, 60_000);
});
