import { describe, expect, it } from 'vitest';

import { validateOptions } from '../config';
import { OutboxService } from './outbox.service';
import type { OutboxRawExecutor } from './types';

/**
 * Fake `$executeRaw` capturing the (strings, ...values) Prisma
 * tagged-template surface. Records each invocation so tests can
 * assert SQL identifiers + parameter shapes deterministically.
 */
function makeFakeTx() {
  const calls: Array<{ segments: readonly string[]; values: readonly unknown[] }> = [];
  const tx: OutboxRawExecutor = {
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
      calls.push({ segments: [...strings], values });
      return 1;
    },
  };
  return { tx, calls };
}

const makeService = (overrides: Partial<Parameters<typeof validateOptions>[0]> = {}) => {
  const fixedDate = new Date('2026-05-13T12:00:00.000Z');
  const validated = validateOptions({
    serviceName: 'service-subscription',
    schemaName: 'subscription',
    idGenerator: () => 'evt_fixed_id',
    clock: () => fixedDate,
    ...overrides,
  });
  return { service: new OutboxService(validated), validated, fixedDate };
};

const VALID_PAYLOAD = {
  eventId: 'unused_envelope_id',
  occurredAt: '2026-05-13T12:00:00.000Z',
  subscriptionId: 'sub_abc',
  customerId: 'cus_abc',
  customerGroup: 'family' as const,
  planId: 'plan_abc',
  planCode: 'family.tier2',
  periodStart: '2026-05-13T00:00:00.000Z',
  periodEnd: '2026-06-13T00:00:00.000Z',
  amountMinor: 19_900,
  currency: 'USD',
};

describe('OutboxService.append', () => {
  it('appends a row when payload validates against the event schema', async () => {
    const { service, fixedDate } = makeService();
    const { tx, calls } = makeFakeTx();

    const result = await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
    });

    expect(result.kind).toBe('appended');
    if (result.kind !== 'appended') return;
    expect(result.eventId).toBe('evt_fixed_id');
    expect(result.eventName).toBe('subscription.activated');
    expect(result.occurredAt).toBe(fixedDate);
    expect(calls).toHaveLength(1);
  });

  it('returns validation_failed when the payload shape is malformed', async () => {
    const { service } = makeService();
    const { tx, calls } = makeFakeTx();

    const result = await service.append(tx, {
      eventName: 'subscription.activated',
      // missing every field
      payload: { eventId: 'x', occurredAt: 'not-a-date' } as never,
    });

    expect(result.kind).toBe('validation_failed');
    if (result.kind !== 'validation_failed') return;
    expect(result.eventName).toBe('subscription.activated');
    expect(result.issues.length).toBeGreaterThan(0);
    // No row written when validation fails.
    expect(calls).toHaveLength(0);
  });

  it('passes parameterized values in the documented order', async () => {
    const { service, fixedDate } = makeService();
    const { tx, calls } = makeFakeTx();

    await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
    });

    expect(calls[0]?.values).toEqual([
      'evt_fixed_id',
      'subscription.activated',
      JSON.stringify(VALID_PAYLOAD),
      fixedDate,
      'service-subscription',
    ]);
  });

  it('honours an explicit eventId argument', async () => {
    const { service } = makeService();
    const { tx, calls } = makeFakeTx();

    const result = await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
      eventId: 'evt_caller_specified',
    });

    expect(result.kind).toBe('appended');
    if (result.kind !== 'appended') return;
    expect(result.eventId).toBe('evt_caller_specified');
    expect(calls[0]?.values[0]).toBe('evt_caller_specified');
  });

  it('honours an explicit occurredAt argument', async () => {
    const { service, fixedDate } = makeService();
    const { tx, calls } = makeFakeTx();
    const explicit = new Date('2026-04-01T00:00:00.000Z');

    const result = await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
      occurredAt: explicit,
    });

    expect(result.kind).toBe('appended');
    if (result.kind !== 'appended') return;
    expect(result.occurredAt).toBe(explicit);
    expect(result.occurredAt).not.toBe(fixedDate);
    expect(calls[0]?.values[3]).toBe(explicit);
  });

  it('serialises payload as JSON via JSON.stringify (relay reads jsonb)', async () => {
    const { service } = makeService();
    const { tx, calls } = makeFakeTx();

    await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
    });

    const serialised = calls[0]?.values[2] as string;
    expect(typeof serialised).toBe('string');
    expect(JSON.parse(serialised)).toMatchObject({
      subscriptionId: 'sub_abc',
      planCode: 'family.tier2',
    });
  });

  it('interpolates the schema + table name into the SQL identifier', async () => {
    const { service } = makeService();
    const { tx, calls } = makeFakeTx();

    await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
    });

    const joinedSql = (calls[0]?.segments ?? []).join('$N');
    expect(joinedSql).toContain('"subscription"."outbox_events"');
    expect(joinedSql).toMatch(/INSERT INTO/);
    expect(joinedSql).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/);
  });

  it('respects custom tableName from module config', async () => {
    const { service } = makeService({ tableName: 'outbox_events_v2' });
    const { tx, calls } = makeFakeTx();

    await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
    });

    const joinedSql = (calls[0]?.segments ?? []).join('$N');
    expect(joinedSql).toContain('"subscription"."outbox_events_v2"');
  });

  it('rejects an unknown event name at runtime even if TS would catch it', async () => {
    const { service } = makeService();
    const { tx, calls } = makeFakeTx();

    const result = await service.append(tx, {
      // Cast to bypass the TS guard so the runtime path runs.
      eventName: 'subscription.never_published' as never,
      payload: { foo: 'bar' } as never,
    });

    expect(result.kind).toBe('validation_failed');
    if (result.kind !== 'validation_failed') return;
    expect(result.issues[0]?.message).toContain(
      "unknown event name 'subscription.never_published'",
    );
    expect(calls).toHaveLength(0);
  });

  it('lists known event names via knownEventNames()', () => {
    const { service } = makeService();
    const names = service.knownEventNames();
    expect(names).toContain('subscription.activated');
    expect(names).toContain('subscription.canceled');
    expect(names).toContain('subscription.payment_failed');
  });

  it('strips fields outside the schema via Zod .strict() before serialising', async () => {
    const { service } = makeService();
    const { tx, calls } = makeFakeTx();

    const payloadWithExtra = {
      ...VALID_PAYLOAD,
      injectedFromAttacker: 'definitely-not-allowed',
    };

    const result = await service.append(tx, {
      eventName: 'subscription.activated',
      payload: payloadWithExtra as never,
    });

    // .strict() rejects unknown keys — defensive against malformed
    // producer input.
    expect(result.kind).toBe('validation_failed');
    if (result.kind !== 'validation_failed') return;
    expect(calls).toHaveLength(0);
  });

  it('uses the configured idGenerator when no eventId is provided', async () => {
    let n = 0;
    const { service } = makeService({ idGenerator: () => `gen_${++n}` });
    const { tx, calls } = makeFakeTx();

    const a = await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
    });
    const b = await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
    });

    if (a.kind !== 'appended' || b.kind !== 'appended') {
      expect.fail('both appends must succeed');
      return;
    }
    expect(a.eventId).toBe('gen_1');
    expect(b.eventId).toBe('gen_2');
    expect(calls[0]?.values[0]).toBe('gen_1');
    expect(calls[1]?.values[0]).toBe('gen_2');
  });

  it('uses the configured clock when no occurredAt is provided', async () => {
    const fixed = new Date('2026-05-13T15:00:00.000Z');
    const { service } = makeService({ clock: () => fixed });
    const { tx, calls } = makeFakeTx();

    await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
    });
    expect(calls[0]?.values[3]).toBe(fixed);
  });

  it('records producer_service from module config', async () => {
    const { service } = makeService({ serviceName: 'service-booking' });
    const { tx, calls } = makeFakeTx();

    await service.append(tx, {
      eventName: 'subscription.activated',
      payload: VALID_PAYLOAD,
    });
    expect(calls[0]?.values[4]).toBe('service-booking');
  });
});
