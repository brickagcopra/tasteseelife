/**
 * Unit-level coverage for `createIsolatedDatabase` argument validation
 * (TS-009e-followup-2).
 *
 * Mirrors the pattern from `stack.test.ts` — the container / docker /
 * migrate execution paths are exercised by every consumer's
 * `test:integration` job (CI provisions a working Docker engine via
 * the ubuntu-24.04 runner image). Under unit test we only cover the
 * pure-input branches that fail before any `docker exec` /
 * `execFileSync` invocation.
 */
import { describe, expect, it } from 'vitest';

import { createIsolatedDatabase } from './isolated-database';

const VALID_OPTS = {
  postgresAdminUrl: 'postgresql://tastesee:tastesee_test_only@127.0.0.1:54321/tastesee_admin',
  postgresContainerId: 'abc123def456',
  databaseName: 'identity_test_auth',
  serviceRoot: '/tmp/service-foo',
} as const;

describe('createIsolatedDatabase — argument validation', () => {
  it('rejects an empty postgresAdminUrl', async () => {
    await expect(createIsolatedDatabase({ ...VALID_OPTS, postgresAdminUrl: '' })).rejects.toThrow(
      /postgresAdminUrl/,
    );
  });

  it('rejects an empty postgresContainerId', async () => {
    await expect(
      createIsolatedDatabase({ ...VALID_OPTS, postgresContainerId: '' }),
    ).rejects.toThrow(/postgresContainerId/);
  });

  it('rejects an empty databaseName', async () => {
    await expect(createIsolatedDatabase({ ...VALID_OPTS, databaseName: '' })).rejects.toThrow(
      /databaseName/,
    );
  });

  it('rejects an empty serviceRoot', async () => {
    await expect(createIsolatedDatabase({ ...VALID_OPTS, serviceRoot: '' })).rejects.toThrow(
      /serviceRoot/,
    );
  });

  it('rejects a databaseName with shell-injection characters', async () => {
    await expect(
      createIsolatedDatabase({ ...VALID_OPTS, databaseName: 'foo"; DROP TABLE users; --' }),
    ).rejects.toThrow(/databaseName/);
  });

  it('rejects a databaseName starting with a digit', async () => {
    await expect(createIsolatedDatabase({ ...VALID_OPTS, databaseName: '1_test' })).rejects.toThrow(
      /databaseName/,
    );
  });

  it('rejects a databaseName exceeding 63 chars', async () => {
    await expect(
      createIsolatedDatabase({ ...VALID_OPTS, databaseName: 'a'.repeat(64) }),
    ).rejects.toThrow(/databaseName/);
  });

  it('rejects a postgresAdminUrl with the wrong protocol', async () => {
    await expect(
      createIsolatedDatabase({
        ...VALID_OPTS,
        postgresAdminUrl: 'mysql://user:pw@host/db',
      }),
    ).rejects.toThrow(/postgresAdminUrl/);
  });

  it('rejects a postgresAdminUrl missing the database path', async () => {
    await expect(
      createIsolatedDatabase({
        ...VALID_OPTS,
        postgresAdminUrl: 'postgresql://user:pw@127.0.0.1:5432',
      }),
    ).rejects.toThrow(/admin database/);
  });

  it('rejects a postgresAdminUrl missing the user', async () => {
    await expect(
      createIsolatedDatabase({
        ...VALID_OPTS,
        postgresAdminUrl: 'postgresql://127.0.0.1:5432/admin',
      }),
    ).rejects.toThrow(/user/);
  });

  it('rejects a malformed postgresAdminUrl', async () => {
    await expect(
      createIsolatedDatabase({
        ...VALID_OPTS,
        postgresAdminUrl: 'not a url',
      }),
    ).rejects.toThrow(/postgresAdminUrl/);
  });
});
