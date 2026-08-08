/**
 * Unit-level coverage for the argument-validation paths of
 * `startIntegrationTestStack` and its building-block helpers.
 *
 * The container-start and migrate-deploy paths are exercised by every
 * consumer's `test:integration` job (CI provisions a working Docker
 * engine via the ubuntu-24.04 runner image); under unit test we can
 * only validate the pure-input branches that fail before any
 * Testcontainers call is made.
 */
import { describe, expect, it } from 'vitest';

import { applyPrismaMigrations } from './prisma-migrate';
import { startIntegrationTestStack } from './stack';
import { startPostgresContainer } from './postgres';

describe('startIntegrationTestStack — argument validation', () => {
  it('rejects an empty serviceRoot', async () => {
    await expect(
      startIntegrationTestStack({ serviceRoot: '', database: 'foo_test' }),
    ).rejects.toThrow(/serviceRoot/);
  });

  it('rejects an empty database', async () => {
    await expect(
      startIntegrationTestStack({ serviceRoot: '/tmp/anything', database: '' }),
    ).rejects.toThrow(/database/);
  });
});

describe('startPostgresContainer — argument validation', () => {
  it('rejects an empty database', async () => {
    await expect(startPostgresContainer({ database: '' })).rejects.toThrow(/database/);
  });
});

describe('applyPrismaMigrations — argument validation', () => {
  it('rejects an empty serviceRoot', () => {
    expect(() =>
      applyPrismaMigrations({ serviceRoot: '', databaseUrl: 'postgresql://anything' }),
    ).toThrow(/serviceRoot/);
  });

  it('rejects an empty databaseUrl', () => {
    expect(() => applyPrismaMigrations({ serviceRoot: '/tmp/anything', databaseUrl: '' })).toThrow(
      /databaseUrl/,
    );
  });
});
