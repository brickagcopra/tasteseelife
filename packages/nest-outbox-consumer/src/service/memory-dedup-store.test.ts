import { describe, expect, it } from 'vitest';

import { MemoryConsumerDedupStore } from './memory-dedup-store';

describe('MemoryConsumerDedupStore', () => {
  it('returns unseen for an absent (group, eventId) pair', async () => {
    const store = new MemoryConsumerDedupStore();
    const s = await store.getState('svc-x', 'evt_1');
    expect(s.kind).toBe('unseen');
  });

  it('records a first-seen attempt as in_flight with attempts=1', async () => {
    const store = new MemoryConsumerDedupStore();
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    const s = await store.getState('svc-x', 'evt_1');
    expect(s).toEqual({ kind: 'in_flight', attempts: 1 });
  });

  it('bumps attempts on a redelivery', async () => {
    const store = new MemoryConsumerDedupStore();
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    const s = await store.getState('svc-x', 'evt_1');
    expect(s).toEqual({ kind: 'in_flight', attempts: 3 });
  });

  it('records success and short-circuits subsequent attempts', async () => {
    const store = new MemoryConsumerDedupStore();
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    await store.recordSuccess('svc-x', 'evt_1');
    expect((await store.getState('svc-x', 'evt_1')).kind).toBe('processed');
    // recordAttempt is a no-op when state is processed
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    expect((await store.getState('svc-x', 'evt_1')).kind).toBe('processed');
  });

  it('records a failure without changing state from in_flight', async () => {
    const store = new MemoryConsumerDedupStore();
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    await store.recordFailure('svc-x', 'evt_1', 'transient db error');
    const s = await store.getState('svc-x', 'evt_1');
    expect(s).toEqual({ kind: 'in_flight', attempts: 1 });
    const snap = store.snapshot();
    expect(snap[0]?.lastError).toBe('transient db error');
  });

  it('records a dead-letter from in_flight', async () => {
    const store = new MemoryConsumerDedupStore();
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    await store.recordDeadLetter('svc-x', 'evt_1', 'exceeded max');
    expect((await store.getState('svc-x', 'evt_1')).kind).toBe('dead_lettered');
  });

  it('records a dead-letter for a never-seen event (e.g. malformed entry)', async () => {
    const store = new MemoryConsumerDedupStore();
    await store.recordDeadLetter('svc-x', 'evt_garbage', 'parse failed');
    expect((await store.getState('svc-x', 'evt_garbage')).kind).toBe('dead_lettered');
  });

  it('isolates dedup state per consumer group', async () => {
    const store = new MemoryConsumerDedupStore();
    await store.recordAttempt('svc-a', 'evt_1', 'subscription.activated');
    await store.recordSuccess('svc-a', 'evt_1');
    const aState = await store.getState('svc-a', 'evt_1');
    const bState = await store.getState('svc-b', 'evt_1');
    expect(aState.kind).toBe('processed');
    expect(bState.kind).toBe('unseen');
  });

  it('exposes a reset helper for tests', async () => {
    const store = new MemoryConsumerDedupStore();
    await store.recordAttempt('svc-x', 'evt_1', 'subscription.activated');
    store.reset();
    expect((await store.getState('svc-x', 'evt_1')).kind).toBe('unseen');
  });

  it('tolerates recordSuccess / recordFailure for an unseen event without throwing', async () => {
    const store = new MemoryConsumerDedupStore();
    await store.recordSuccess('svc-x', 'evt_missing');
    await store.recordFailure('svc-x', 'evt_missing', 'late failure');
    // Nothing inserted defensively — but no throw.
    expect((await store.getState('svc-x', 'evt_missing')).kind).toBe('unseen');
  });
});
