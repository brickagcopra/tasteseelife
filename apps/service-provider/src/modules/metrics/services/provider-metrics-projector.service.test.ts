import type { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { BookingFactContribution } from '../booking-fact-projection';
import { ProviderMetricsProjectorService } from './provider-metrics-projector.service';

/**
 * TS-053-followup-4a — the emission rule.
 *
 * The SQL itself needs a live Postgres (TS-305d-followup-2, Docker
 * wedge), so what is covered here is the decision layered on top of it:
 * WHICH events announce themselves, what id they announce under, and
 * what happens when the announcement is refused. Each of those can be
 * wrong in a way that is silent in production — an over-emitting
 * projector re-indexes the roster for nothing, an under-emitting one
 * leaves the search index quietly stale, and a swallowed refusal leaves
 * the two permanently disagreeing.
 */

interface Recorded {
  readonly appends: Array<Record<string, unknown>>;
  readonly rollupReads: number;
}

function harness(options: { appendKind?: 'appended' | 'invalid'; completed?: number } = {}): {
  service: ProviderMetricsProjectorService;
  recorded: Recorded;
} {
  const appends: Array<Record<string, unknown>> = [];
  const state = { rollupReads: 0 };

  const tx = {
    $executeRaw: vi.fn(async () => 1),
    providerMetrics: {
      findUnique: vi.fn(async () => {
        state.rollupReads += 1;
        return { bookingsCompleted: options.completed ?? 4 };
      }),
    },
  };

  const prisma = {
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as PrismaService;

  const outbox = {
    append: vi.fn(async (_executor: unknown, event: Record<string, unknown>) => {
      appends.push(event);
      return options.appendKind === 'invalid'
        ? { kind: 'invalid', eventName: event['eventName'], issues: [] }
        : { kind: 'appended', eventName: event['eventName'] };
    }),
  } as unknown as OutboxService;

  return {
    service: new ProviderMetricsProjectorService(prisma, outbox),
    recorded: {
      appends,
      get rollupReads() {
        return state.rollupReads;
      },
    } as Recorded,
  };
}

function contribution(overrides: Partial<BookingFactContribution> = {}): BookingFactContribution {
  return {
    bookingId: 'bkg_1',
    providerId: 'prov_1',
    ...overrides,
  };
}

describe('ProviderMetricsProjectorService.apply — the emission rule', () => {
  it('emits on a COMPLETION', async () => {
    const { service, recorded } = harness({ completed: 7 });

    await service.apply(
      contribution({ outcome: 'completed', outcomeAt: new Date('2026-08-01T10:00:00.000Z') }),
    );

    expect(recorded.appends).toHaveLength(1);
    expect(recorded.appends[0]?.['eventName']).toBe('provider.metrics_updated');
  });

  it.each([
    ['an offer', {}],
    ['an acceptance', { responseKind: 'accepted' as const, respondedAt: new Date() }],
    ['a decline', { outcome: 'declined' as const, outcomeAt: new Date() }],
    ['a cancellation', { outcome: 'canceled' as const, outcomeAt: new Date() }],
  ])(
    'does NOT emit on %s — none of them can move the completed count, and re-indexing the roster for an integer that did not change is the cost of getting this wrong',
    async (_label, overrides) => {
      const { service, recorded } = harness();

      await service.apply(contribution(overrides as Partial<BookingFactContribution>));

      expect(recorded.appends).toHaveLength(0);
    },
  );

  it('uses a DETERMINISTIC event id keyed to the provider and the booking, so a redelivered completion is swallowed by the outbox rather than re-indexing', async () => {
    const { service, recorded } = harness();
    const input = contribution({ outcome: 'completed', outcomeAt: new Date() });

    await service.apply(input);
    await service.apply(input);

    expect(recorded.appends).toHaveLength(2);
    expect(recorded.appends[0]?.['eventId']).toBe('provider-metrics:prov_1:bkg_1');
    expect(recorded.appends[1]?.['eventId']).toBe(recorded.appends[0]?.['eventId']);
  });

  it('announces the count it just recomputed, not one it was handed', async () => {
    const { service, recorded } = harness({ completed: 41 });

    await service.apply(contribution({ outcome: 'completed', outcomeAt: new Date() }));

    const payload = recorded.appends[0]?.['payload'] as Record<string, unknown>;
    expect(payload['completedBookingCount']).toBe(41);
    expect(payload['providerId']).toBe('prov_1');
  });

  it('carries no household id, senior id, money or free text — and the booking id appears ONLY inside the deterministic event id, which is what makes it deterministic', async () => {
    const { service, recorded } = harness();

    await service.apply(
      contribution({
        outcome: 'completed',
        outcomeAt: new Date(),
        cancellationReason: 'family_request',
        serviceKind: 'chef_visit',
      }),
    );

    const payload = recorded.appends[0]?.['payload'] as Record<string, unknown>;

    // The payload's own fields are an identity and a number, and nothing
    // else — a search re-projection needs no more, and this event rides
    // a stream several services read.
    expect(Object.keys(payload).sort()).toEqual([
      'completedBookingCount',
      'eventId',
      'occurredAt',
      'providerId',
    ]);

    // The booking id is inside `eventId` by construction. That is the
    // price of a deterministic id and it is worth paying: an opaque
    // booking id says nothing about whose visit it was, whereas a
    // random id would make a redelivered completion re-index the
    // provider every time.
    expect(payload['eventId']).toBe('provider-metrics:prov_1:bkg_1');

    // What must never ride along: anything about the household, the
    // senior, the money, or why something was cancelled.
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('family_request');
    expect(serialised).not.toContain('chef_visit');
  });

  it('THROWS when the outbox refuses the event, rolling the fact write back — a projection that advanced while its announcement failed is the divergence this event exists to prevent', async () => {
    const { service } = harness({ appendKind: 'invalid' });

    await expect(
      service.apply(contribution({ outcome: 'completed', outcomeAt: new Date() })),
    ).rejects.toThrow(/registry validation/);
  });

  it('recomputes the rollup on EVERY event, including the four that do not emit', async () => {
    const { service, recorded } = harness();

    await service.apply(contribution());
    await service.apply(contribution({ outcome: 'canceled', outcomeAt: new Date() }));

    expect(recorded.rollupReads).toBe(2);
    expect(recorded.appends).toHaveLength(0);
  });
});
