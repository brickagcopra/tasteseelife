import { compileAppModuleGraph } from '@taste-and-see/testing';
import { describe, expect, it } from 'vitest';

/**
 * Boot-graph guard for service-notification (TS-506).
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
  DATABASE_URL: 'postgresql://stub:stub@127.0.0.1:5432/service_notification?schema=public',
  DUNNING_APP_NAME: 'Taste and See',
  DUNNING_BILLING_URL: 'https://app.taste-and-see.test/billing/invoices',
  DUNNING_NOTIFICATIONS_ENABLED: 'false',
  HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: 'stub-value-long-enough-for-min-length-checks-0123456789',
  HOUSEHOLD_SERVICE_BASE_URL: 'http://127.0.0.1:1/service-household',
  PROVIDER_SERVICE_BASE_URL: 'http://127.0.0.1:1/service-household',
  PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY:
    'stub-value-long-enough-for-min-length-checks-0123456789',
  PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: 'x-provider-billing-contacts-internal-api-key',
  IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'stub-value-long-enough-for-min-length-checks-0123456789',
  IDENTITY_SERVICE_BASE_URL: 'http://127.0.0.1:1/service-identity',
  REDIS_URL: 'redis://127.0.0.1:6379',
  FIREBASE_PROJECT_ID: 'stub-value-long-enough-for-min-length-checks-0123456789',
  FIREBASE_SERVICE_ACCOUNT_B64: 'eyJzdHViIjogdHJ1ZX0=',
  JWT_ACCESS_SECRET: 'stub-value-long-enough-for-min-length-checks-0123456789',
  INTERNAL_TRUST_SIGNING_SECRET: 'stub-value-long-enough-for-min-length-checks-0123456789',
  JWT_AUDIENCE: 'taste-and-see',
  JWT_ISSUER: 'https://identity.taste-and-see.test',
  LOG_LEVEL: 'warn',
  NODE_ENV: 'test',
  NOTIFICATION_DISPATCH_API_KEY: 'stub-value-long-enough-for-min-length-checks-0123456789',
  NOTIFICATION_DISPATCH_HEADER_NAME: 'x-internal-api-key',
  NOTIFICATION_EMAIL_FROM_ADDRESS: 'stub@example.com',
  NOTIFICATION_EMAIL_FROM_NAME: 'Taste and See',
  NOTIFICATION_RENDER_API_KEY: 'stub-value-long-enough-for-min-length-checks-0123456789',
  NOTIFICATION_RENDER_HEADER_NAME: 'x-internal-api-key',
  NOTIFICATION_SMS_FROM_NUMBER: '+15555550100',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/stub',
  OTEL_METRICS_ENABLED: 'false',
  OTEL_TRACES_ENABLED: 'false',
  PORT: '3999',
  POSTMARK_SERVER_TOKEN: 'stub-value-long-enough-for-min-length-checks-0123456789',
  SERVICE_VERSION: 'boot-graph-test',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'stub-value-long-enough-for-min-length-checks-0123456789',
};

describe('service-notification AppModule dependency graph', () => {
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
