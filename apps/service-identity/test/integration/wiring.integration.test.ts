/**
 * TS-009e — canonical integration test for service-identity.
 *
 * Proves the integration-testing pipeline end-to-end:
 *
 *   1. Postgres + Redis Testcontainers spin up against the local
 *      Docker engine.
 *   2. Prisma migrate-deploy applies the full `identity` schema
 *      against the ephemeral DB.
 *   3. `PrismaService` (the same client production code uses)
 *      round-trips against the `users` table.
 *   4. `ioredis` (the same client `nest-idempotency` uses)
 *      round-trips a SET/GET against Redis.
 *
 * Shape is deliberately focused: this test exists to validate the
 * wiring and the CI gate. Service-level integration tests
 * (signup → login → refresh → reuse-detection round-trip) land
 * with TS-022-followup-5 against the same scaffolding.
 *
 * **TS-009e-followup-2 update.** The Postgres + Redis containers are
 * now shared across every file in the integration suite via vitest's
 * `globalSetup` (see `test/integration/global-setup.ts`); each file
 * carves out its own database for isolation via
 * `createIsolatedDatabase` and drops it in `afterAll`. Net: 5×
 * fewer container starts (the suite has 5 integration files), same
 * per-file migration cost.
 *
 * Per-service concerns (env wiring, AppModule boot, the harness
 * PrismaService) stay in the test file because their shape varies
 * per service and lifting them would force every consumer to take a
 * wider API surface than they need.
 *
 * References: PDD §24.1; CLAUDE.md §9.1 (Testcontainers as the
 * integration-test substrate).
 */

import { resolve } from 'node:path';

import { createIsolatedDatabase, type IsolatedDatabaseHandle } from '@taste-and-see/testing';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { PrismaService } from '../../src/prisma/prisma.service';

const SERVICE_ROOT = resolve(__dirname, '..', '..');

let database: IsolatedDatabaseHandle;
let prisma: PrismaService;
let redis: Redis;

beforeAll(async () => {
  // Carve out a per-file database against the shared Postgres booted
  // by `setupSharedContainers` in `test/integration/global-setup.ts`.
  // The CREATE DATABASE + `prisma migrate deploy` invocation that used
  // to live verbatim in this file now lives in
  // `packages/testing/src/integration/isolated-database.ts` — single
  // source of truth.
  database = await createIsolatedDatabase({
    postgresAdminUrl: inject('postgresAdminUrl'),
    postgresContainerId: inject('postgresContainerId'),
    databaseName: 'identity_test_wiring',
    serviceRoot: SERVICE_ROOT,
  });

  const redisUrl = new URL(inject('redisUrl'));

  prisma = new PrismaService({ datasourceUrl: database.databaseUrl });
  await prisma.onModuleInit();

  redis = new Redis({
    host: redisUrl.hostname,
    port: Number.parseInt(redisUrl.port, 10),
    // Mirror nest-idempotency's degraded-mode posture so we don't
    // silently mask a wiring regression that production wouldn't
    // tolerate (CLAUDE.md §4.3).
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
});

afterAll(async () => {
  // Defensive `?.` against partial bring-up — if `beforeAll`
  // failed mid-flight we still want teardown to release whatever
  // started so the runner doesn't leak Docker resources. The
  // `database.drop()` closure is idempotent on a second call; the
  // shared containers themselves are torn down by globalSetup at
  // suite end.
  if (prisma) {
    await prisma.onModuleDestroy();
  }
  if (redis) {
    redis.disconnect();
  }
  if (database) {
    await database.drop();
  }
});

describe('service-identity wiring (TS-009e canonical)', () => {
  it('PrismaService.ping() round-trips against Postgres', async () => {
    await expect(prisma.ping()).resolves.toBeUndefined();
  });

  it('prisma migrate deploy applied the identity schema', async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'identity'
      ORDER BY table_name
    `;
    const names = tables.map((t) => t.table_name);
    // Sample across the schema's load-bearing tables — proves the
    // full migration set applied, not just the initial one.
    expect(names).toContain('users');
    expect(names).toContain('refresh_tokens');
    expect(names).toContain('roles');
    expect(names).toContain('permissions');
    expect(names).toContain('mfa_methods');
    expect(names).toContain('kyc_records');
  });

  it('round-trips a User row through PrismaClient', async () => {
    const email = `integration+${Date.now()}@tastesee.test`;
    const created = await prisma.user.create({
      data: {
        email,
        passwordHash: 'bcrypt$placeholder',
        status: 'pending_verification',
      },
      select: { id: true, email: true, status: true },
    });

    const fetched = await prisma.user.findUnique({
      where: { id: created.id },
      select: { id: true, email: true, status: true },
    });

    expect(fetched).not.toBeNull();
    expect(fetched?.email).toBe(email);
    expect(fetched?.status).toBe('pending_verification');

    await prisma.user.delete({ where: { id: created.id } });
  });

  it('ioredis SET/GET round-trips against Redis', async () => {
    const key = `ts009e:wiring:${process.pid}:${Date.now()}`;
    await redis.set(key, 'ok', 'EX', 60);
    const value = await redis.get(key);
    expect(value).toBe('ok');
    await redis.del(key);
  });
});
