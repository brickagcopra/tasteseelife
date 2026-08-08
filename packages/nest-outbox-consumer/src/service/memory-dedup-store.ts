import { Injectable } from '@nestjs/common';

import type { ConsumerDedupState, ConsumerDedupStore } from './types';

interface MemoryEntry {
  state: 'in_flight' | 'processed' | 'dead_lettered';
  attempts: number;
  eventName: string;
  firstSeenAt: Date;
  lastAttemptAt: Date;
  lastError: string | null;
  processedAt: Date | null;
  deadLetteredAt: Date | null;
}

/**
 * In-memory `ConsumerDedupStore` implementation. Used by the package's
 * own unit tests AND available for downstream consumers' tests so they
 * can exercise handler logic without standing up Postgres.
 *
 * Not for production — process restart loses all dedup state, so a
 * redelivery after restart would re-invoke the handler. Production
 * wires the Postgres-backed implementation (see `pg-dedup-store.ts`).
 */
@Injectable()
export class MemoryConsumerDedupStore implements ConsumerDedupStore {
  private readonly store = new Map<string, MemoryEntry>();

  /** Per-test reset helper. Not part of the interface. */
  reset(): void {
    this.store.clear();
  }

  /** Snapshot for assertions. */
  snapshot(): ReadonlyArray<{
    consumerGroup: string;
    eventId: string;
    state: string;
    attempts: number;
    lastError: string | null;
  }> {
    const out: Array<{
      consumerGroup: string;
      eventId: string;
      state: string;
      attempts: number;
      lastError: string | null;
    }> = [];
    for (const [key, entry] of this.store.entries()) {
      const [consumerGroup, eventId] = splitKey(key);
      out.push({
        consumerGroup,
        eventId,
        state: entry.state,
        attempts: entry.attempts,
        lastError: entry.lastError,
      });
    }
    return out;
  }

  async getState(consumerGroup: string, eventId: string): Promise<ConsumerDedupState> {
    const entry = this.store.get(makeKey(consumerGroup, eventId));
    if (entry === undefined) return { kind: 'unseen' };
    if (entry.state === 'in_flight') {
      return { kind: 'in_flight', attempts: entry.attempts };
    }
    return { kind: entry.state };
  }

  async recordAttempt(consumerGroup: string, eventId: string, eventName: string): Promise<void> {
    const key = makeKey(consumerGroup, eventId);
    const existing = this.store.get(key);
    const now = new Date();
    if (existing === undefined) {
      this.store.set(key, {
        state: 'in_flight',
        attempts: 1,
        eventName,
        firstSeenAt: now,
        lastAttemptAt: now,
        lastError: null,
        processedAt: null,
        deadLetteredAt: null,
      });
      return;
    }
    // Already-processed or dead-lettered entries don't bump attempts.
    // The caller should not have invoked recordAttempt for those, but
    // we tolerate the call defensively.
    if (existing.state !== 'in_flight') return;
    existing.attempts += 1;
    existing.lastAttemptAt = now;
  }

  async recordSuccess(consumerGroup: string, eventId: string): Promise<void> {
    const key = makeKey(consumerGroup, eventId);
    const existing = this.store.get(key);
    if (existing === undefined) return; // unexpected; tolerate
    existing.state = 'processed';
    existing.processedAt = new Date();
    existing.lastError = null;
  }

  async recordFailure(consumerGroup: string, eventId: string, error: string): Promise<void> {
    const key = makeKey(consumerGroup, eventId);
    const existing = this.store.get(key);
    if (existing === undefined) return;
    existing.lastError = error;
    existing.lastAttemptAt = new Date();
  }

  async recordDeadLetter(consumerGroup: string, eventId: string, error: string): Promise<void> {
    const key = makeKey(consumerGroup, eventId);
    const existing = this.store.get(key);
    const now = new Date();
    if (existing === undefined) {
      this.store.set(key, {
        state: 'dead_lettered',
        attempts: 1,
        eventName: '<unknown>',
        firstSeenAt: now,
        lastAttemptAt: now,
        lastError: error,
        processedAt: null,
        deadLetteredAt: now,
      });
      return;
    }
    existing.state = 'dead_lettered';
    existing.deadLetteredAt = now;
    existing.lastError = error;
  }
}

function makeKey(consumerGroup: string, eventId: string): string {
  // No-collision joiner: the `\0` character cannot appear in either a
  // valid consumerGroup (identifier regex rejects it) or an event_id
  // (event_id is a printable string).
  return `${consumerGroup}\0${eventId}`;
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf('\0');
  if (idx === -1) {
    return [key, ''];
  }
  return [key.slice(0, idx), key.slice(idx + 1)];
}
