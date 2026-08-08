import { compileAppModuleGraph } from '@taste-and-see/testing';
import { describe, expect, it } from 'vitest';

/**
 * Boot-graph guard for service-media (TS-506).
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
  DATABASE_URL: 'postgresql://stub:stub@127.0.0.1:5432/service_media?schema=public',
  JWT_ACCESS_SECRET: 'stub-value-long-enough-for-min-length-checks-0123456789',
  INTERNAL_TRUST_SIGNING_SECRET: 'stub-value-long-enough-for-min-length-checks-0123456789',
  JWT_AUDIENCE: 'taste-and-see',
  JWT_ISSUER: 'https://identity.taste-and-see.test',
  LOG_LEVEL: 'warn',
  MEDIA_SCAN_EVENTS_API_KEY: 'stub-value-long-enough-for-min-length-checks-0123456789',
  MEDIA_SCAN_EVENTS_HEADER_NAME: 'x-internal-api-key',
  NODE_ENV: 'test',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/stub',
  OTEL_METRICS_ENABLED: 'false',
  OTEL_TRACES_ENABLED: 'false',
  PORT: '3999',
  S3_ACCESS_KEY_ID: 'stub-value-long-enough-for-min-length-checks-0123456789',
  S3_BUCKET_NAME: 'stub-value-long-enough-for-min-length-checks-0123456789',
  S3_ENDPOINT_URL: 'http://127.0.0.1:1/stub',
  S3_FORCE_PATH_STYLE: 'true',
  S3_REGION: 'us-east-1',
  S3_SECRET_ACCESS_KEY: 'stub-value-long-enough-for-min-length-checks-0123456789',
  S3_SIGNING_SECRET: 'stub-value-long-enough-for-min-length-checks-0123456789',
  SERVICE_VERSION: 'boot-graph-test',
};

describe('service-media AppModule dependency graph', () => {
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
