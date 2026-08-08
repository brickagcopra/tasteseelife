import { SEARCH_RESULT_CLICKED, SearchResultClickedSchema } from '@taste-and-see/contracts';
import type { AppendArgs, AppendResult, OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { SearchClickEmitter } from './search-click.emitter';

/**
 * Captures every `append` call so the emitter's behaviour can be asserted
 * without a real Postgres / outbox SDK. Mirrors `search-analytics.emitter.test`.
 */
class FakeOutbox {
  readonly calls: Array<AppendArgs<typeof SEARCH_RESULT_CLICKED>> = [];
  result: AppendResult = {
    kind: 'appended',
    eventId: 'unused',
    eventName: SEARCH_RESULT_CLICKED,
    occurredAt: new Date(),
  };
  throwOnAppend: Error | null = null;

  append(_tx: unknown, args: AppendArgs<typeof SEARCH_RESULT_CLICKED>): Promise<AppendResult> {
    if (this.throwOnAppend !== null) {
      return Promise.reject(this.throwOnAppend);
    }
    this.calls.push(args);
    return Promise.resolve(this.result);
  }
}

function makeEmitter(outbox: FakeOutbox): SearchClickEmitter {
  return new SearchClickEmitter(outbox as unknown as OutboxService, {} as unknown as PrismaService);
}

describe('SearchClickEmitter.emitSearchResultClicked', () => {
  it('appends search.result_clicked with a self-consistent envelope + returns true', async () => {
    const outbox = new FakeOutbox();
    const emitter = makeEmitter(outbox);

    const accepted = await emitter.emitSearchResultClicked({
      searchId: 'srch_pierogi_1',
      actorUserId: 'user_abc',
      providerId: 'prv_42',
      position: 3,
    });

    expect(accepted).toBe(true);
    expect(outbox.calls).toHaveLength(1);
    const call = outbox.calls[0];
    expect(call?.eventName).toBe(SEARCH_RESULT_CLICKED);
    // The click gets its OWN event id (one row per click), distinct from the
    // searchId correlation token it carries; the column event_id matches the
    // payload envelope id.
    expect(typeof call?.eventId).toBe('string');
    expect(call?.eventId?.length).toBeGreaterThan(0);
    expect(call?.eventId).toBe(call?.payload.eventId);
    expect(call?.eventId).not.toBe('srch_pierogi_1');
    expect(call?.occurredAt?.toISOString()).toBe(call?.payload.occurredAt);
    expect(call?.payload.searchId).toBe('srch_pierogi_1');
    expect(call?.payload.actorUserId).toBe('user_abc');
    expect(call?.payload.providerId).toBe('prv_42');
    expect(call?.payload.position).toBe(3);
    expect(SearchResultClickedSchema.safeParse(call?.payload).success).toBe(true);
  });

  it('returns false + swallows a thrown append (best-effort — never breaks a click)', async () => {
    const outbox = new FakeOutbox();
    outbox.throwOnAppend = new Error('postgres unreachable');
    const emitter = makeEmitter(outbox);

    await expect(
      emitter.emitSearchResultClicked({
        searchId: 'srch_throw',
        actorUserId: 'user_abc',
        providerId: 'prv_1',
        position: 0,
      }),
    ).resolves.toBe(false);
  });

  it('returns false on a validation_failed result without throwing', async () => {
    const outbox = new FakeOutbox();
    outbox.result = {
      kind: 'validation_failed',
      eventName: SEARCH_RESULT_CLICKED,
      issues: [{ path: ['position'], message: 'too large' }],
    };
    const emitter = makeEmitter(outbox);

    await expect(
      emitter.emitSearchResultClicked({
        searchId: 'srch_validation',
        actorUserId: 'user_abc',
        providerId: 'prv_1',
        position: 0,
      }),
    ).resolves.toBe(false);
  });
});
