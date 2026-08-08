import { describe, expect, it, vi } from 'vitest';

import type { OutboxSource } from '../config/env';
import type { OutboxClaimRepository } from './outbox-claim.repository';
import { RelayMetrics } from './relay-metrics';
import { RelayWorkerService } from './relay-worker.service';
import type { OutboxRow } from './types';
import type { BusPublisher } from './redis-stream-publisher';

const SOURCE: OutboxSource = { schema: 'subscription', table: 'outbox_events' };

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    schema: 'subscription',
    table: 'outbox_events',
    eventId: 'evt_abc',
    eventName: 'subscription.activated',
    payload: { foo: 'bar' },
    occurredAt: new Date('2026-05-13T12:00:00.000Z'),
    producerService: 'service-subscription',
    attempts: 0,
    createdAt: new Date('2026-05-13T12:00:00.000Z'),
    ...overrides,
  };
}

function makeRepo(rows: readonly OutboxRow[] = []): {
  repo: OutboxClaimRepository;
  claimBatch: ReturnType<typeof vi.fn>;
  markDispatched: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
} {
  const claimBatch = vi.fn().mockResolvedValue(rows);
  const markDispatched = vi.fn().mockResolvedValue(undefined);
  const recordFailure = vi.fn().mockResolvedValue(undefined);
  return {
    repo: { claimBatch, markDispatched, recordFailure },
    claimBatch,
    markDispatched,
    recordFailure,
  };
}

function makePublisher(impl: (row: OutboxRow) => Promise<void> = async () => {}): {
  publisher: BusPublisher;
  publish: ReturnType<typeof vi.fn>;
} {
  const publish = vi.fn(impl);
  return { publisher: { publish }, publish };
}

/**
 * A spy {@link RelayMetrics} — every method is a `vi.fn()` so a test can
 * assert which instruments fired with which labels. Cast through
 * `RelayMetrics` because the spy is structurally compatible (the real
 * class has no other public surface).
 */
function makeMetrics(): RelayMetrics & Record<keyof RelayMetrics, ReturnType<typeof vi.fn>> {
  return {
    recordPoll: vi.fn(),
    recordDispatched: vi.fn(),
    recordFailed: vi.fn(),
    recordDeadLettered: vi.fn(),
    recordLagSeconds: vi.fn(),
    recordPollDuration: vi.fn(),
    recordPublishDuration: vi.fn(),
  } as unknown as RelayMetrics & Record<keyof RelayMetrics, ReturnType<typeof vi.fn>>;
}

describe('RelayWorkerService.pollOnce', () => {
  it('claims, publishes, and marks dispatched a single row', async () => {
    const row = makeRow();
    const { repo, claimBatch, markDispatched } = makeRepo([row]);
    const { publisher, publish } = makePublisher();
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 100,
      maxAttempts: 10,
    });

    const results = await worker.pollOnce();

    expect(claimBatch).toHaveBeenCalledWith(SOURCE, 100, 10);
    expect(publish).toHaveBeenCalledWith(row);
    expect(markDispatched).toHaveBeenCalledWith(SOURCE, 'evt_abc');
    expect(results).toEqual([
      {
        source: 'subscription.outbox_events',
        claimed: 1,
        dispatched: 1,
        failed: 0,
        deadLettered: 0,
      },
    ]);
  });

  it('returns claimed=0 when there is nothing to dispatch', async () => {
    const { repo } = makeRepo([]);
    const { publisher, publish } = makePublisher();
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 100,
      maxAttempts: 10,
    });

    const results = await worker.pollOnce();

    expect(publish).not.toHaveBeenCalled();
    expect(results[0]).toEqual({
      source: 'subscription.outbox_events',
      claimed: 0,
      dispatched: 0,
      failed: 0,
      deadLettered: 0,
    });
  });

  it('records failure when publish throws — does NOT mark dispatched', async () => {
    const row = makeRow({ attempts: 0 });
    const { repo, markDispatched, recordFailure } = makeRepo([row]);
    const { publisher } = makePublisher(async () => {
      throw new Error('Redis unavailable');
    });
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 100,
      maxAttempts: 10,
    });

    const results = await worker.pollOnce();

    expect(markDispatched).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledWith(SOURCE, 'evt_abc', 'Redis unavailable');
    expect(results[0]).toMatchObject({
      claimed: 1,
      dispatched: 0,
      failed: 1,
      deadLettered: 0,
    });
  });

  it('dead-letters a row whose attempts hit the cap on this cycle', async () => {
    // attempts = 9, cap = 10 — this cycle's failure brings attempts
    // to 10 which equals the cap. The row gets reported as
    // dead-lettered.
    const row = makeRow({ attempts: 9 });
    const { repo } = makeRepo([row]);
    const { publisher } = makePublisher(async () => {
      throw new Error('Redis still unavailable');
    });
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 100,
      maxAttempts: 10,
    });

    const results = await worker.pollOnce();

    expect(results[0]).toMatchObject({ failed: 1, deadLettered: 1 });
  });

  it('continues to the next row when one publish fails', async () => {
    const r1 = makeRow({ eventId: 'evt_1' });
    const r2 = makeRow({ eventId: 'evt_2' });
    const r3 = makeRow({ eventId: 'evt_3' });
    const { repo, markDispatched, recordFailure } = makeRepo([r1, r2, r3]);
    const { publisher, publish } = makePublisher(async (row) => {
      if (row.eventId === 'evt_2') {
        throw new Error('row 2 boom');
      }
    });
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 100,
      maxAttempts: 10,
    });

    const results = await worker.pollOnce();

    expect(publish).toHaveBeenCalledTimes(3);
    expect(markDispatched).toHaveBeenCalledTimes(2);
    expect(markDispatched).toHaveBeenCalledWith(SOURCE, 'evt_1');
    expect(markDispatched).toHaveBeenCalledWith(SOURCE, 'evt_3');
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith(SOURCE, 'evt_2', 'row 2 boom');
    expect(results[0]).toMatchObject({ claimed: 3, dispatched: 2, failed: 1 });
  });

  it('skips a source when claimBatch throws', async () => {
    const { repo, markDispatched } = makeRepo();
    repo.claimBatch = vi.fn().mockRejectedValue(new Error('Postgres down'));
    const { publisher, publish } = makePublisher();
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 100,
      maxAttempts: 10,
    });

    const results = await worker.pollOnce();

    expect(publish).not.toHaveBeenCalled();
    expect(markDispatched).not.toHaveBeenCalled();
    expect(results[0]).toEqual({
      source: 'subscription.outbox_events',
      claimed: 0,
      dispatched: 0,
      failed: 0,
      deadLettered: 0,
    });
  });

  it('logs but does not crash when markDispatched fails after publish', async () => {
    const row = makeRow();
    const { repo, recordFailure } = makeRepo([row]);
    repo.markDispatched = vi.fn().mockRejectedValue(new Error('Postgres hiccup'));
    const { publisher, publish } = makePublisher();
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 100,
      maxAttempts: 10,
    });

    const results = await worker.pollOnce();

    // publish ran, mark failed, recordFailure NOT called (the
    // publish itself succeeded).
    expect(publish).toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
    // The cycle still returns. dispatched stays at 0 because mark
    // failed (the at-least-once delivery shape — next cycle
    // re-claims, re-publishes, consumer dedups).
    expect(results[0]?.dispatched).toBe(0);
  });

  it('logs and continues when recordFailure itself fails', async () => {
    const row = makeRow();
    const { repo } = makeRepo([row]);
    repo.recordFailure = vi.fn().mockRejectedValue(new Error('Postgres hiccup'));
    const { publisher } = makePublisher(async () => {
      throw new Error('boom');
    });
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 100,
      maxAttempts: 10,
    });

    // Must not throw — the cycle stays alive even when both publish
    // and recordFailure fail.
    const results = await worker.pollOnce();

    expect(results[0]).toMatchObject({ failed: 1 });
  });

  it('iterates every configured source in order', async () => {
    const SOURCE_A: OutboxSource = { schema: 'subscription', table: 'outbox_events' };
    const SOURCE_B: OutboxSource = { schema: 'booking', table: 'outbox_events' };
    const calls: string[] = [];

    const { repo } = makeRepo([]);
    const original = repo.claimBatch;
    repo.claimBatch = vi.fn(async (source: OutboxSource, limit: number, max: number) => {
      calls.push(`${source.schema}.${source.table}`);
      return original(source, limit, max);
    });
    const { publisher } = makePublisher();
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE_A, SOURCE_B],
      batchSize: 100,
      maxAttempts: 10,
    });

    const results = await worker.pollOnce();

    expect(calls).toEqual(['subscription.outbox_events', 'booking.outbox_events']);
    expect(results).toHaveLength(2);
  });

  it('forwards batchSize + maxAttempts from config to the repository', async () => {
    const { repo, claimBatch } = makeRepo([]);
    const { publisher } = makePublisher();
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 50,
      maxAttempts: 5,
    });

    await worker.pollOnce();

    expect(claimBatch).toHaveBeenCalledWith(SOURCE, 50, 5);
  });

  it('does NOT dead-letter when failed-attempt is below the cap', async () => {
    const row = makeRow({ attempts: 3 });
    const { repo } = makeRepo([row]);
    const { publisher } = makePublisher(async () => {
      throw new Error('retry next cycle');
    });
    const worker = new RelayWorkerService(repo, publisher, {
      sources: [SOURCE],
      batchSize: 100,
      maxAttempts: 10,
    });

    const results = await worker.pollOnce();

    expect(results[0]).toMatchObject({ failed: 1, deadLettered: 0 });
  });
});

describe('RelayWorkerService metrics (TS-142-followup-4)', () => {
  it('records an ok poll + dispatched + lag + durations on the happy path', async () => {
    const row = makeRow();
    const { repo } = makeRepo([row]);
    const { publisher } = makePublisher();
    const metrics = makeMetrics();
    const worker = new RelayWorkerService(
      repo,
      publisher,
      { sources: [SOURCE], batchSize: 100, maxAttempts: 10 },
      metrics,
    );

    await worker.pollOnce();

    expect(metrics.recordPoll).toHaveBeenCalledWith('subscription.outbox_events', 'ok');
    expect(metrics.recordDispatched).toHaveBeenCalledWith(
      'subscription.outbox_events',
      'subscription.activated',
    );
    expect(metrics.recordLagSeconds).toHaveBeenCalledTimes(1);
    expect(metrics.recordLagSeconds.mock.calls[0]?.[0]).toBe('subscription.outbox_events');
    expect(metrics.recordPollDuration).toHaveBeenCalledTimes(1);
    expect(metrics.recordPublishDuration).toHaveBeenCalledTimes(1);
    expect(metrics.recordFailed).not.toHaveBeenCalled();
    expect(metrics.recordDeadLettered).not.toHaveBeenCalled();
  });

  it('records an ok poll + no dispatch metrics when there is nothing to claim', async () => {
    const { repo } = makeRepo([]);
    const { publisher } = makePublisher();
    const metrics = makeMetrics();
    const worker = new RelayWorkerService(
      repo,
      publisher,
      { sources: [SOURCE], batchSize: 100, maxAttempts: 10 },
      metrics,
    );

    await worker.pollOnce();

    expect(metrics.recordPoll).toHaveBeenCalledWith('subscription.outbox_events', 'ok');
    expect(metrics.recordDispatched).not.toHaveBeenCalled();
    expect(metrics.recordLagSeconds).not.toHaveBeenCalled();
    // Duration is still recorded — a cycle ran, even an empty one.
    expect(metrics.recordPollDuration).toHaveBeenCalledTimes(1);
  });

  it('records a claim_failed poll when claimBatch throws', async () => {
    const { repo } = makeRepo();
    repo.claimBatch = vi.fn().mockRejectedValue(new Error('Postgres down'));
    const { publisher } = makePublisher();
    const metrics = makeMetrics();
    const worker = new RelayWorkerService(
      repo,
      publisher,
      { sources: [SOURCE], batchSize: 100, maxAttempts: 10 },
      metrics,
    );

    await worker.pollOnce();

    expect(metrics.recordPoll).toHaveBeenCalledWith('subscription.outbox_events', 'claim_failed');
    expect(metrics.recordDispatched).not.toHaveBeenCalled();
    expect(metrics.recordPollDuration).toHaveBeenCalledTimes(1);
  });

  it('records a failure with a bounded reason when publish throws (below cap → no dead-letter)', async () => {
    const row = makeRow({ attempts: 2 });
    const { repo } = makeRepo([row]);
    const { publisher } = makePublisher(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    });
    const metrics = makeMetrics();
    const worker = new RelayWorkerService(
      repo,
      publisher,
      { sources: [SOURCE], batchSize: 100, maxAttempts: 10 },
      metrics,
    );

    await worker.pollOnce();

    expect(metrics.recordFailed).toHaveBeenCalledWith(
      'subscription.outbox_events',
      'subscription.activated',
      'bus_unavailable',
    );
    expect(metrics.recordDeadLettered).not.toHaveBeenCalled();
    expect(metrics.recordDispatched).not.toHaveBeenCalled();
    // Publish was attempted, so its duration is recorded even on failure.
    expect(metrics.recordPublishDuration).toHaveBeenCalledTimes(1);
  });

  it('records a dead-letter when the failing attempt hits the cap', async () => {
    const row = makeRow({ attempts: 9 });
    const { repo } = makeRepo([row]);
    const { publisher } = makePublisher(async () => {
      throw new Error('something entirely unexpected');
    });
    const metrics = makeMetrics();
    const worker = new RelayWorkerService(
      repo,
      publisher,
      { sources: [SOURCE], batchSize: 100, maxAttempts: 10 },
      metrics,
    );

    await worker.pollOnce();

    expect(metrics.recordFailed).toHaveBeenCalledWith(
      'subscription.outbox_events',
      'subscription.activated',
      'unknown',
    );
    expect(metrics.recordDeadLettered).toHaveBeenCalledWith(
      'subscription.outbox_events',
      'subscription.activated',
    );
  });

  it('records lag per claimed row across a multi-row batch', async () => {
    const rows = [
      makeRow({ eventId: 'evt_1' }),
      makeRow({ eventId: 'evt_2' }),
      makeRow({ eventId: 'evt_3' }),
    ];
    const { repo } = makeRepo(rows);
    const { publisher } = makePublisher();
    const metrics = makeMetrics();
    const worker = new RelayWorkerService(
      repo,
      publisher,
      { sources: [SOURCE], batchSize: 100, maxAttempts: 10 },
      metrics,
    );

    await worker.pollOnce();

    expect(metrics.recordLagSeconds).toHaveBeenCalledTimes(3);
    expect(metrics.recordDispatched).toHaveBeenCalledTimes(3);
    // Lag is never negative (clock-skew clamp).
    for (const call of metrics.recordLagSeconds.mock.calls) {
      expect(call[1]).toBeGreaterThanOrEqual(0);
    }
  });
});
