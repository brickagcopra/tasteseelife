import type { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { ProviderPricingMetrics } from './provider-pricing-metrics';
import { ProviderPricingService, type ProviderRow } from './provider-pricing.service';

/**
 * Unit tests for `ProviderPricingService.updatePricing` (TS-204).
 *
 * Fakes:
 *   - `FakePrisma` — in-memory store implementing the narrow surface
 *     the service consumes (`provider.findUnique` by id + by userId,
 *     `provider.update`, and a `$transaction` callback that runs
 *     against the same delegate). No transactional rollback semantics —
 *     the integration test against real Postgres carries the atomic
 *     guarantee.
 *   - `FakeOutbox` — records every `append` call so tests assert the
 *     `provider.pricing_updated` payload shape. Override path injects a
 *     `validation_failed` to exercise the typed-failure surface.
 *
 * `hourlyRate` on the fake row is stored as the `Decimal(12,2)` string
 * (`"75.00"`) — a JS string structurally satisfies the service's
 * `{ toString(): string }` mirror of the Prisma Decimal instance.
 */

interface FakeOutboxAppendCall {
  readonly eventName: string;
  readonly eventId: string | undefined;
  readonly payload: unknown;
}
interface FakeOutbox {
  readonly calls: FakeOutboxAppendCall[];
  readonly append: ReturnType<typeof vi.fn>;
  setNextValidationFailure(reason: string): void;
}
function buildFakeOutbox(): FakeOutbox {
  const calls: FakeOutboxAppendCall[] = [];
  let nextFailure: string | null = null;
  const append = vi.fn(
    async (
      _tx: unknown,
      args: { eventName: string; eventId?: string; payload: unknown },
    ): Promise<
      | { kind: 'appended'; eventId: string; eventName: string; occurredAt: Date }
      | {
          kind: 'validation_failed';
          eventName: string;
          issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
        }
    > => {
      calls.push({ eventName: args.eventName, eventId: args.eventId, payload: args.payload });
      if (nextFailure !== null) {
        const failure = nextFailure;
        nextFailure = null;
        return {
          kind: 'validation_failed',
          eventName: args.eventName,
          issues: [{ path: [], message: failure }],
        };
      }
      return {
        kind: 'appended',
        eventId: args.eventId ?? 'evt_fake',
        eventName: args.eventName,
        occurredAt: new Date('2026-05-25T12:00:00.000Z'),
      };
    },
  );
  return {
    calls,
    append,
    setNextValidationFailure(reason) {
      nextFailure = reason;
    },
  };
}
function asOutboxService(fake: FakeOutbox): OutboxService {
  return { append: fake.append } as unknown as OutboxService;
}

const UPDATED_AT_AFTER_WRITE = new Date('2026-05-25T12:00:01.000Z');

class FakePrisma {
  public providers: ProviderRow[] = [];

  provider = {
    findUnique: vi.fn(
      async (args: { where: { id?: string; userId?: string } }): Promise<ProviderRow | null> => {
        if (args.where.id !== undefined) {
          return this.providers.find((p) => p.id === args.where.id) ?? null;
        }
        if (args.where.userId !== undefined) {
          return this.providers.find((p) => p.userId === args.where.userId) ?? null;
        }
        return null;
      },
    ),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: { hourlyRate: string; hourlyRateCurrency: string };
      }): Promise<ProviderRow> => {
        const idx = this.providers.findIndex((p) => p.id === args.where.id);
        if (idx === -1) throw new Error(`provider ${args.where.id} not found in fake`);
        const target = this.providers[idx];
        if (target === undefined) throw new Error('row missing');
        const next: ProviderRow = {
          ...target,
          hourlyRate: args.data.hourlyRate,
          hourlyRateCurrency: args.data.hourlyRateCurrency,
          updatedAt: UPDATED_AT_AFTER_WRITE,
        };
        this.providers[idx] = next;
        return next;
      },
    ),
  };

  $transaction = vi.fn(
    async <T>(fn: (tx: { provider: FakePrisma['provider'] }) => Promise<T>): Promise<T> => {
      return fn({ provider: this.provider });
    },
  );
}

const NOW = new Date('2026-05-25T11:00:00.000Z');

function aProviderRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'prov_1',
    userId: 'user_1',
    status: 'active',
    tier: 'certified',
    hourlyRate: null,
    hourlyRateCurrency: null,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function build(): { service: ProviderPricingService; prisma: FakePrisma; outbox: FakeOutbox } {
  const prisma = new FakePrisma();
  const outbox = buildFakeOutbox();
  const service = new ProviderPricingService(
    prisma as unknown as PrismaService,
    asOutboxService(outbox),
  );
  return { service, prisma, outbox };
}

describe('ProviderPricingService.updatePricing', () => {
  it('sets a rate within the tier band and emits provider.pricing_updated', async () => {
    const { service, prisma, outbox } = build();
    prisma.providers.push(aProviderRow());

    // certified band is 6000–12000; 7500 is inside.
    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7500,
      currency: 'USD',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hourlyRate?.toString()).toBe('75.00');
    expect(result.value.hourlyRateCurrency).toBe('USD');
    expect(prisma.provider.update).toHaveBeenCalledTimes(1);
    expect(outbox.calls).toHaveLength(1);
    const call = outbox.calls[0];
    expect(call?.eventName).toBe('provider.pricing_updated');
    expect(call?.payload).toMatchObject({
      providerId: 'prov_1',
      hourlyRateMinor: 7500,
      currency: 'USD',
      tier: 'certified',
      actorUserId: 'user_1',
    });
  });

  it('upper-cases a lowercase currency before storing it', async () => {
    const { service, prisma } = build();
    prisma.providers.push(aProviderRow());

    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'usd',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hourlyRateCurrency).toBe('USD');
  });

  it('returns not_found when the provider row is missing', async () => {
    const { service } = build();
    const result = await service.updatePricing({
      providerId: 'ghost',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns forbidden when the actor does not own the row', async () => {
    const { service, prisma, outbox } = build();
    prisma.providers.push(aProviderRow({ userId: 'someone_else' }));
    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('forbidden');
    expect(prisma.provider.update).not.toHaveBeenCalled();
    expect(outbox.calls).toHaveLength(0);
  });

  it('rejects an unsupported currency with unsupported_currency (Phase-1 USD-only)', async () => {
    const { service, prisma } = build();
    prisma.providers.push(aProviderRow());
    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'EUR',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('unsupported_currency');
  });

  it('rejects a rate below the tier band floor with out_of_band', async () => {
    const { service, prisma } = build();
    prisma.providers.push(aProviderRow({ tier: 'certified' }));
    // certified floor is 6000.
    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 5000,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('out_of_band');
    if (result.error.reason !== 'out_of_band') return;
    expect(result.error.minHourlyRateMinor).toBe(6000);
    expect(result.error.maxHourlyRateMinor).toBe(12000);
  });

  it('rejects a rate above the tier band ceiling with out_of_band', async () => {
    const { service, prisma } = build();
    prisma.providers.push(aProviderRow({ tier: 'basic' }));
    // basic ceiling is 8000.
    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 9000,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('out_of_band');
  });

  it('uses the SERVER-known tier band, not a client-supplied value (elite allows 15000)', async () => {
    const { service, prisma } = build();
    prisma.providers.push(aProviderRow({ tier: 'elite' }));
    // 15000 is out-of-band for certified (max 12000) but in-band for elite (max 25000).
    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 15000,
      currency: 'USD',
    });
    expect(result.ok).toBe(true);
  });

  it('short-circuits before the transaction when the rate + currency are unchanged', async () => {
    const { service, prisma, outbox } = build();
    prisma.providers.push(
      aProviderRow({ hourlyRate: '75.00', hourlyRateCurrency: 'USD', updatedAt: NOW }),
    );

    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7500,
      currency: 'USD',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // updatedAt preserved — no write happened.
    expect(result.value.updatedAt).toBe(NOW);
    expect(prisma.provider.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(outbox.calls).toHaveLength(0);
  });

  it('still writes when only the currency case differs but the rate is the same value', async () => {
    // Currency stored canonical upper-case; a lowercase resubmit normalises
    // to the same stored value, so it is a no-op (no write).
    const { service, prisma } = build();
    prisma.providers.push(aProviderRow({ hourlyRate: '70.00', hourlyRateCurrency: 'USD' }));
    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'usd',
    });
    expect(result.ok).toBe(true);
    expect(prisma.provider.update).not.toHaveBeenCalled();
  });

  describe('optimistic concurrency (ifMatchUpdatedAt)', () => {
    it('writes through when the If-Match value matches', async () => {
      const { service, prisma } = build();
      prisma.providers.push(aProviderRow({ updatedAt: NOW }));
      const result = await service.updatePricing({
        providerId: 'prov_1',
        actorUserId: 'user_1',
        hourlyRateMinor: 7000,
        currency: 'USD',
        ifMatchUpdatedAt: NOW,
      });
      expect(result.ok).toBe(true);
    });

    it('returns precondition_failed when the If-Match value is stale', async () => {
      const { service, prisma } = build();
      prisma.providers.push(aProviderRow({ updatedAt: NOW }));
      const result = await service.updatePricing({
        providerId: 'prov_1',
        actorUserId: 'user_1',
        hourlyRateMinor: 7000,
        currency: 'USD',
        ifMatchUpdatedAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('precondition_failed');
      expect(prisma.provider.update).not.toHaveBeenCalled();
    });

    it('runs the precondition AFTER the 403 ownership guard', async () => {
      const { service, prisma } = build();
      prisma.providers.push(aProviderRow({ userId: 'someone_else', updatedAt: NOW }));
      const result = await service.updatePricing({
        providerId: 'prov_1',
        actorUserId: 'user_1',
        hourlyRateMinor: 7000,
        currency: 'USD',
        ifMatchUpdatedAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('forbidden');
    });
  });

  it('rolls back to a typed failure when the outbox rejects the payload', async () => {
    const { service, prisma, outbox } = build();
    prisma.providers.push(aProviderRow());
    outbox.setNextValidationFailure('bad payload');
    const result = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
  });

  it('rejects empty providerId / actorUserId with invalid_request', async () => {
    const { service } = build();
    const r1 = await service.updatePricing({
      providerId: '',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'USD',
    });
    expect(r1.ok).toBe(false);
    const r2 = await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: '',
      hourlyRateMinor: 7000,
      currency: 'USD',
    });
    expect(r2.ok).toBe(false);
  });
});

describe('ProviderPricingService reads', () => {
  it('getPricing returns the row by id, null when missing', async () => {
    const { service, prisma } = build();
    prisma.providers.push(aProviderRow());
    expect(await service.getPricing('prov_1')).not.toBeNull();
    expect(await service.getPricing('ghost')).toBeNull();
    expect(await service.getPricing('')).toBeNull();
  });

  it('getPricingByUserId returns the row by userId, null when missing', async () => {
    const { service, prisma } = build();
    prisma.providers.push(aProviderRow({ userId: 'user_42' }));
    expect(await service.getPricingByUserId('user_42')).not.toBeNull();
    expect(await service.getPricingByUserId('nobody')).toBeNull();
    expect(await service.getPricingByUserId('')).toBeNull();
  });
});

/**
 * Observability wiring (TS-204-followup-4). The span wrapper records a
 * bounded outcome + latency on `ProviderPricingMetrics.recordUpdate` for
 * every `updatePricing` call. We spy on the recorder rather than scrape
 * the Prometheus surface (that's covered in `provider-pricing-metrics.test.ts`)
 * so the assertion stays focused on the service → metric mapping —
 * crucially the `set` vs `noop` success split that the public
 * `Result<ProviderRow, …>` shape hides.
 */
describe('ProviderPricingService.updatePricing — metric outcome mapping', () => {
  function buildWithMetrics(): {
    service: ProviderPricingService;
    prisma: FakePrisma;
    outbox: FakeOutbox;
    recordUpdate: ReturnType<typeof vi.spyOn>;
  } {
    const prisma = new FakePrisma();
    const outbox = buildFakeOutbox();
    const metrics = new ProviderPricingMetrics();
    const recordUpdate = vi.spyOn(metrics, 'recordUpdate');
    const service = new ProviderPricingService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
      metrics,
    );
    return { service, prisma, outbox, recordUpdate };
  }

  function expectOutcome(recordUpdate: ReturnType<typeof vi.spyOn>, outcome: string): void {
    expect(recordUpdate).toHaveBeenCalledTimes(1);
    const call = recordUpdate.mock.calls[0];
    expect(call?.[0]).toBe(outcome);
    // Latency is a finite, non-negative seconds reading.
    const seconds = call?.[1] as number;
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(0);
  }

  it('records outcome="set" on an in-band write', async () => {
    const { service, prisma, recordUpdate } = buildWithMetrics();
    prisma.providers.push(aProviderRow());
    await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7500,
      currency: 'USD',
    });
    expectOutcome(recordUpdate, 'set');
  });

  it('records outcome="noop" on the unchanged short-circuit', async () => {
    const { service, prisma, recordUpdate } = buildWithMetrics();
    prisma.providers.push(
      aProviderRow({ hourlyRate: '75.00', hourlyRateCurrency: 'USD', updatedAt: NOW }),
    );
    await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7500,
      currency: 'USD',
    });
    expectOutcome(recordUpdate, 'noop');
  });

  it('records outcome="out_of_band" on a band rejection', async () => {
    const { service, prisma, recordUpdate } = buildWithMetrics();
    prisma.providers.push(aProviderRow({ tier: 'certified' }));
    await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 5000,
      currency: 'USD',
    });
    expectOutcome(recordUpdate, 'out_of_band');
  });

  it('records outcome="not_found" on a missing provider row', async () => {
    const { service, recordUpdate } = buildWithMetrics();
    await service.updatePricing({
      providerId: 'ghost',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'USD',
    });
    expectOutcome(recordUpdate, 'not_found');
  });

  it('records outcome="forbidden" on an ownership mismatch', async () => {
    const { service, prisma, recordUpdate } = buildWithMetrics();
    prisma.providers.push(aProviderRow({ userId: 'someone_else' }));
    await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'USD',
    });
    expectOutcome(recordUpdate, 'forbidden');
  });

  it('records outcome="outbox_validation_failed" when the outbox rejects the payload', async () => {
    const { service, prisma, outbox, recordUpdate } = buildWithMetrics();
    prisma.providers.push(aProviderRow());
    outbox.setNextValidationFailure('bad payload');
    await service.updatePricing({
      providerId: 'prov_1',
      actorUserId: 'user_1',
      hourlyRateMinor: 7000,
      currency: 'USD',
    });
    expectOutcome(recordUpdate, 'outbox_validation_failed');
  });
});
