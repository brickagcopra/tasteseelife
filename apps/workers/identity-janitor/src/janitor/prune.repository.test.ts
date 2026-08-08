import { describe, expect, it } from 'vitest';

import { buildDeleteSql, PruneRepository, type PruneExecutor } from './prune.repository';
import type { PruneTarget } from './prune-targets';

const refreshTokens: PruneTarget = {
  key: 'refresh_tokens',
  schema: 'identity',
  table: 'refresh_tokens',
  expiresAtColumn: 'expires_at',
  retentionDays: 30,
  enabled: true,
};

/** Fake executor that replays a queued list of per-batch delete counts. */
class FakeExecutor implements PruneExecutor {
  readonly calls: { sql: string; params: readonly unknown[] }[] = [];
  constructor(private readonly counts: number[]) {}

  deleteBatch(sql: string, params: readonly unknown[]): Promise<number> {
    this.calls.push({ sql, params });
    return Promise.resolve(this.counts.shift() ?? 0);
  }
}

describe('buildDeleteSql', () => {
  it('qualifies the schema + table and compares the expires column to a make_interval threshold', () => {
    const sql = buildDeleteSql(refreshTokens);

    expect(sql).toContain('DELETE FROM "identity"."refresh_tokens"');
    expect(sql).toContain('"expires_at" < now() - make_interval(days => $1::int)');
    expect(sql).toContain('ORDER BY "expires_at" ASC');
    expect(sql).toContain('LIMIT $2');
  });

  it('rejects an unsafe identifier in a target (defence-in-depth)', () => {
    expect(() =>
      buildDeleteSql({ ...refreshTokens, table: 'refresh_tokens; DROP TABLE users' }),
    ).toThrow(/not a safe SQL identifier/);
  });
});

describe('PruneRepository.prune', () => {
  it('stops after a single batch when the backlog drains below the batch size', async () => {
    const executor = new FakeExecutor([3]);
    const repo = new PruneRepository(executor, 5, 100);

    const result = await repo.prune(refreshTokens);

    expect(result).toEqual({ key: 'refresh_tokens', deleted: 3, batches: 1, cappedOut: false });
    expect(executor.calls).toHaveLength(1);
  });

  it('passes [retentionDays, batchSize] as the bound params', async () => {
    const executor = new FakeExecutor([0]);
    const repo = new PruneRepository(executor, 5_000, 100);

    await repo.prune({ ...refreshTokens, retentionDays: 14 });

    expect(executor.calls[0]?.params).toEqual([14, 5_000]);
  });

  it('loops across full batches until a short batch signals the backlog is drained', async () => {
    // batchSize 5: two full batches then a short one ends the loop.
    const executor = new FakeExecutor([5, 5, 2]);
    const repo = new PruneRepository(executor, 5, 100);

    const result = await repo.prune(refreshTokens);

    expect(result).toEqual({ key: 'refresh_tokens', deleted: 12, batches: 3, cappedOut: false });
    expect(executor.calls).toHaveLength(3);
  });

  it('caps out at maxBatchesPerSweep and defers the remainder', async () => {
    // Every batch is full, so only the cap stops the loop.
    const executor = new FakeExecutor([5, 5, 5, 5]);
    const repo = new PruneRepository(executor, 5, 2);

    const result = await repo.prune(refreshTokens);

    expect(result).toEqual({ key: 'refresh_tokens', deleted: 10, batches: 2, cappedOut: true });
    expect(executor.calls).toHaveLength(2);
  });

  it('treats an immediately-empty table as a zero-row single batch', async () => {
    const executor = new FakeExecutor([0]);
    const repo = new PruneRepository(executor, 5, 100);

    const result = await repo.prune(refreshTokens);

    expect(result).toEqual({ key: 'refresh_tokens', deleted: 0, batches: 1, cappedOut: false });
  });
});
