import { describe, expect, it, vi } from 'vitest';

import type { JanitorMetrics } from './janitor-metrics';
import { JanitorWorkerService } from './janitor-worker.service';
import type { PruneRepository, PruneResult } from './prune.repository';
import type { PruneTarget } from './prune-targets';

function target(key: string, enabled: boolean): PruneTarget {
  return {
    key,
    schema: 'identity',
    table: key,
    expiresAtColumn: 'expires_at',
    retentionDays: 30,
    enabled,
  };
}

/** Build a fake repository whose `prune` is driven per-key. */
function fakeRepo(impl: (target: PruneTarget) => Promise<PruneResult>): {
  repo: PruneRepository;
  prune: ReturnType<typeof vi.fn>;
} {
  const prune = vi.fn(impl);
  return { repo: { prune } as unknown as PruneRepository, prune };
}

/** Build a spyable {@link JanitorMetrics} with the three record methods stubbed. */
function fakeMetrics(): {
  metrics: JanitorMetrics;
  recordRowsDeleted: ReturnType<typeof vi.fn>;
  recordSweepError: ReturnType<typeof vi.fn>;
  recordSweepDuration: ReturnType<typeof vi.fn>;
} {
  const recordRowsDeleted = vi.fn();
  const recordSweepError = vi.fn();
  const recordSweepDuration = vi.fn();
  return {
    metrics: {
      recordRowsDeleted,
      recordSweepError,
      recordSweepDuration,
    } as unknown as JanitorMetrics,
    recordRowsDeleted,
    recordSweepError,
    recordSweepDuration,
  };
}

describe('JanitorWorkerService.sweepOnce', () => {
  it('prunes every enabled target and aggregates the results', async () => {
    const { repo, prune } = fakeRepo((t) =>
      Promise.resolve({ key: t.key, deleted: 4, batches: 1, cappedOut: false }),
    );
    const worker = new JanitorWorkerService(repo, [
      target('refresh_tokens', true),
      target('mfa_challenges', true),
    ]);

    const results = await worker.sweepOnce();

    expect(prune).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { key: 'refresh_tokens', deleted: 4, batches: 1, cappedOut: false, skipped: false },
      { key: 'mfa_challenges', deleted: 4, batches: 1, cappedOut: false, skipped: false },
    ]);
  });

  it('skips a disabled target without calling the repository', async () => {
    const { repo, prune } = fakeRepo((t) =>
      Promise.resolve({ key: t.key, deleted: 1, batches: 1, cappedOut: false }),
    );
    const worker = new JanitorWorkerService(repo, [
      target('refresh_tokens', false),
      target('mfa_challenges', true),
    ]);

    const results = await worker.sweepOnce();

    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(expect.objectContaining({ key: 'mfa_challenges' }));
    expect(results[0]).toEqual({
      key: 'refresh_tokens',
      deleted: 0,
      batches: 0,
      cappedOut: false,
      skipped: true,
    });
    expect(results[1]).toMatchObject({ key: 'mfa_challenges', deleted: 1, skipped: false });
  });

  it('isolates a failing target so the others still prune', async () => {
    const { repo } = fakeRepo((t) => {
      if (t.key === 'refresh_tokens') {
        return Promise.reject(new Error('connection terminated unexpectedly'));
      }
      return Promise.resolve({ key: t.key, deleted: 7, batches: 2, cappedOut: false });
    });
    const worker = new JanitorWorkerService(repo, [
      target('refresh_tokens', true),
      target('mfa_challenges', true),
    ]);

    const results = await worker.sweepOnce();

    expect(results[0]).toEqual({
      key: 'refresh_tokens',
      deleted: 0,
      batches: 0,
      cappedOut: false,
      skipped: false,
      error: 'connection terminated unexpectedly',
    });
    expect(results[1]).toMatchObject({ key: 'mfa_challenges', deleted: 7, skipped: false });
  });

  it('never rejects even when a target throws a non-Error value', async () => {
    const { repo } = fakeRepo(() => Promise.reject('boom'));
    const worker = new JanitorWorkerService(repo, [target('refresh_tokens', true)]);

    const results = await worker.sweepOnce();

    expect(results[0]).toMatchObject({ key: 'refresh_tokens', error: 'boom' });
  });
});

describe('JanitorWorkerService.sweepOnce metrics (TS-022-followup-3a)', () => {
  it('records rows-deleted per enabled target and the sweep duration', async () => {
    const { repo } = fakeRepo((t) =>
      Promise.resolve({
        key: t.key,
        deleted: t.key === 'refresh_tokens' ? 9 : 2,
        batches: 1,
        cappedOut: false,
      }),
    );
    const { metrics, recordRowsDeleted, recordSweepError, recordSweepDuration } = fakeMetrics();
    const worker = new JanitorWorkerService(
      repo,
      [target('refresh_tokens', true), target('mfa_challenges', true)],
      metrics,
    );

    await worker.sweepOnce();

    expect(recordRowsDeleted).toHaveBeenCalledTimes(2);
    expect(recordRowsDeleted).toHaveBeenCalledWith('refresh_tokens', 9);
    expect(recordRowsDeleted).toHaveBeenCalledWith('mfa_challenges', 2);
    expect(recordSweepError).not.toHaveBeenCalled();
    expect(recordSweepDuration).toHaveBeenCalledTimes(1);
    expect(recordSweepDuration.mock.calls[0]?.[0]).toBeTypeOf('number');
  });

  it('does not record rows-deleted for a skipped (disabled) target', async () => {
    const { repo } = fakeRepo((t) =>
      Promise.resolve({ key: t.key, deleted: 4, batches: 1, cappedOut: false }),
    );
    const { metrics, recordRowsDeleted, recordSweepDuration } = fakeMetrics();
    const worker = new JanitorWorkerService(
      repo,
      [target('refresh_tokens', false), target('mfa_challenges', true)],
      metrics,
    );

    await worker.sweepOnce();

    expect(recordRowsDeleted).toHaveBeenCalledTimes(1);
    expect(recordRowsDeleted).toHaveBeenCalledWith('mfa_challenges', 4);
    // Duration is always recorded, even when a target is skipped.
    expect(recordSweepDuration).toHaveBeenCalledTimes(1);
  });

  it('records the error counter for a failing target and still records duration', async () => {
    const { repo } = fakeRepo((t) => {
      if (t.key === 'refresh_tokens') {
        return Promise.reject(new Error('connection terminated unexpectedly'));
      }
      return Promise.resolve({ key: t.key, deleted: 7, batches: 1, cappedOut: false });
    });
    const { metrics, recordRowsDeleted, recordSweepError, recordSweepDuration } = fakeMetrics();
    const worker = new JanitorWorkerService(
      repo,
      [target('refresh_tokens', true), target('mfa_challenges', true)],
      metrics,
    );

    await worker.sweepOnce();

    expect(recordSweepError).toHaveBeenCalledTimes(1);
    expect(recordSweepError).toHaveBeenCalledWith('refresh_tokens');
    // The failing target records no rows-deleted; the healthy one does.
    expect(recordRowsDeleted).toHaveBeenCalledTimes(1);
    expect(recordRowsDeleted).toHaveBeenCalledWith('mfa_challenges', 7);
    expect(recordSweepDuration).toHaveBeenCalledTimes(1);
  });
});
