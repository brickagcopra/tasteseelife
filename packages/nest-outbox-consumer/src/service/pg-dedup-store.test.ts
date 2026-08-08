import { describe, expect, it, vi } from 'vitest';

import { PgConsumerDedupStore } from './pg-dedup-store';
import type { ConsumerRawExecutor } from './types';

interface RecordedCall {
  segments: readonly string[];
  values: readonly unknown[];
}

function buildFakeTx(rows: ReadonlyArray<Record<string, unknown>> = []): {
  tx: ConsumerRawExecutor;
  executeRawCalls: RecordedCall[];
  queryRawCalls: RecordedCall[];
} {
  const executeRawCalls: RecordedCall[] = [];
  const queryRawCalls: RecordedCall[] = [];
  const tx: ConsumerRawExecutor = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      executeRawCalls.push({ segments: [...strings], values });
      return 1;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queryRawCalls.push({ segments: [...strings], values });
      return rows as never;
    }),
  };
  return { tx, executeRawCalls, queryRawCalls };
}

describe('PgConsumerDedupStore', () => {
  it('rejects an invalid schema name at construction', () => {
    const { tx } = buildFakeTx();
    expect(() => new PgConsumerDedupStore(tx, 'BadSchema')).toThrow(/invalid schemaName/);
    expect(() => new PgConsumerDedupStore(tx, '1leading')).toThrow(/invalid schemaName/);
    expect(() => new PgConsumerDedupStore(tx, 'with space')).toThrow(/invalid schemaName/);
  });

  it('rejects an invalid table name at construction', () => {
    const { tx } = buildFakeTx();
    expect(() => new PgConsumerDedupStore(tx, 'accounting', 'Bad-Table')).toThrow(
      /invalid tableName/,
    );
  });

  it('accepts a valid lowercase schema + default tableName', () => {
    const { tx } = buildFakeTx();
    expect(() => new PgConsumerDedupStore(tx, 'accounting')).not.toThrow();
  });

  it('returns unseen when the query has no row', async () => {
    const { tx } = buildFakeTx([]);
    const store = new PgConsumerDedupStore(tx, 'accounting');
    const s = await store.getState('svc', 'evt_1');
    expect(s.kind).toBe('unseen');
  });

  it('maps a processed row to ConsumerDedupState.processed', async () => {
    const { tx } = buildFakeTx([{ state: 'processed', attempts: 1 }]);
    const store = new PgConsumerDedupStore(tx, 'accounting');
    const s = await store.getState('svc', 'evt_1');
    expect(s.kind).toBe('processed');
  });

  it('maps an in_flight row preserving attempts', async () => {
    const { tx } = buildFakeTx([{ state: 'in_flight', attempts: 4 }]);
    const store = new PgConsumerDedupStore(tx, 'accounting');
    const s = await store.getState('svc', 'evt_1');
    expect(s).toEqual({ kind: 'in_flight', attempts: 4 });
  });

  it('maps a dead_lettered row', async () => {
    const { tx } = buildFakeTx([{ state: 'dead_lettered', attempts: 11 }]);
    const store = new PgConsumerDedupStore(tx, 'accounting');
    const s = await store.getState('svc', 'evt_1');
    expect(s.kind).toBe('dead_lettered');
  });

  it('treats malformed rows as unseen so the SDK retries', async () => {
    const { tx } = buildFakeTx([{ state: 'not-a-state', attempts: 'NaN' }]);
    const store = new PgConsumerDedupStore(tx, 'accounting');
    const s = await store.getState('svc', 'evt_1');
    expect(s.kind).toBe('unseen');
  });

  it('recordAttempt issues an upsert against the fully-qualified table', async () => {
    const { tx, executeRawCalls } = buildFakeTx();
    const store = new PgConsumerDedupStore(tx, 'accounting');
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    expect(executeRawCalls).toHaveLength(1);
    const sql = executeRawCalls[0]?.segments.join('$N');
    expect(sql).toMatch(/"accounting"\."outbox_consumer_dedup"/);
    expect(sql).toMatch(/INSERT INTO/);
    expect(sql).toMatch(/ON CONFLICT \(consumer_group, event_id\) DO UPDATE/);
    expect(executeRawCalls[0]?.values).toEqual(['svc-x', 'evt_1', 'subscription.activated']);
  });

  it('recordSuccess UPDATEs state=processed', async () => {
    const { tx, executeRawCalls } = buildFakeTx();
    const store = new PgConsumerDedupStore(tx, 'accounting');
    await store.recordSuccess('svc-x', 'evt_1');
    const sql = executeRawCalls[0]?.segments.join('$N');
    expect(sql).toMatch(/UPDATE "accounting"\."outbox_consumer_dedup"/);
    expect(sql).toMatch(/state = 'processed'/);
    expect(executeRawCalls[0]?.values).toEqual(['svc-x', 'evt_1']);
  });

  it('recordFailure truncates long error messages to 2000 chars', async () => {
    const { tx, executeRawCalls } = buildFakeTx();
    const store = new PgConsumerDedupStore(tx, 'accounting');
    const longError = 'x'.repeat(5000);
    await store.recordFailure('svc-x', 'evt_1', longError);
    const passedError = executeRawCalls[0]?.values[2];
    expect(typeof passedError).toBe('string');
    expect((passedError as string).length).toBe(2000);
  });

  it('recordDeadLetter upserts with state=dead_lettered', async () => {
    const { tx, executeRawCalls } = buildFakeTx();
    const store = new PgConsumerDedupStore(tx, 'accounting');
    await store.recordDeadLetter('svc-x', 'evt_1', 'exceeded max');
    const sql = executeRawCalls[0]?.segments.join('$N');
    expect(sql).toMatch(/INSERT INTO "accounting"\."outbox_consumer_dedup"/);
    expect(sql).toMatch(/state = 'dead_lettered'/);
    expect(executeRawCalls[0]?.values).toEqual(['svc-x', 'evt_1', 'exceeded max']);
  });

  it('honours a custom tableName', async () => {
    const { tx, executeRawCalls } = buildFakeTx();
    const store = new PgConsumerDedupStore(tx, 'accounting', 'custom_dedup_table');
    await store.recordSuccess('svc-x', 'evt_1');
    const sql = executeRawCalls[0]?.segments.join('$N');
    expect(sql).toMatch(/"accounting"\."custom_dedup_table"/);
  });
});
