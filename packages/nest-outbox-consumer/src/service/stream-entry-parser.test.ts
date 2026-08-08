import { describe, expect, it } from 'vitest';

import { parseStreamEntry } from './stream-entry-parser';

function fields(record: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(record)) {
    out.push(k, v);
  }
  return out;
}

const VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD = {
  eventId: 'sub_abc.activated',
  occurredAt: '2026-05-13T12:00:00.000Z',
  subscriptionId: 'sub_abc',
  customerId: 'hh_123',
  customerGroup: 'family' as const,
  planId: 'plan_companion',
  planCode: 'family.tier2',
  periodStart: '2026-05-13T12:00:00.000Z',
  periodEnd: '2026-06-13T12:00:00.000Z',
  amountMinor: 19_900,
  currency: 'USD',
};

describe('parseStreamEntry', () => {
  it('parses a well-formed subscription.activated entry into a typed envelope', () => {
    const r = parseStreamEntry(
      '1715900000000-0',
      fields({
        event_id: 'sub_abc.activated',
        event_name: 'subscription.activated',
        payload: JSON.stringify(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD),
        occurred_at: '2026-05-13T12:00:00.000Z',
        producer_service: 'service-subscription',
        schema: 'subscription',
      }),
    );
    if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.reason}`);
    expect(r.entry.eventName).toBe('subscription.activated');
    expect(r.entry.eventId).toBe('sub_abc.activated');
    expect(r.entry.producerService).toBe('service-subscription');
    expect(r.entry.producerSchema).toBe('subscription');
    expect(r.entry.occurredAt.toISOString()).toBe('2026-05-13T12:00:00.000Z');
  });

  it('rejects an entry with a missing event_id field', () => {
    const r = parseStreamEntry(
      '1715900000000-0',
      fields({
        event_name: 'subscription.activated',
        payload: JSON.stringify(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD),
        occurred_at: '2026-05-13T12:00:00.000Z',
      }),
    );
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.reason).toMatch(/event_id/);
    }
  });

  it('rejects an entry with a missing event_name field', () => {
    const r = parseStreamEntry(
      '1715900000000-0',
      fields({
        event_id: 'sub_abc.activated',
        payload: JSON.stringify(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD),
        occurred_at: '2026-05-13T12:00:00.000Z',
      }),
    );
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') {
      expect(r.reason).toMatch(/event_name/);
    }
  });

  it('rejects an entry with an unknown event_name', () => {
    const r = parseStreamEntry(
      '1715900000000-0',
      fields({
        event_id: 'evt_1',
        event_name: 'subscription.invented',
        payload: '{}',
        occurred_at: '2026-05-13T12:00:00.000Z',
      }),
    );
    if (r.kind !== 'invalid') throw new Error('expected invalid');
    expect(r.eventName).toBe('subscription.invented');
    expect(r.reason).toMatch(/unknown event_name/);
  });

  it('rejects an entry with malformed JSON payload', () => {
    const r = parseStreamEntry(
      '1715900000000-0',
      fields({
        event_id: 'evt_1',
        event_name: 'subscription.activated',
        payload: 'not-json',
        occurred_at: '2026-05-13T12:00:00.000Z',
      }),
    );
    if (r.kind !== 'invalid') throw new Error('expected invalid');
    expect(r.reason).toMatch(/payload JSON parse failed/);
  });

  it('rejects an entry where the payload fails registry schema validation', () => {
    const r = parseStreamEntry(
      '1715900000000-0',
      fields({
        event_id: 'evt_1',
        event_name: 'subscription.activated',
        payload: JSON.stringify({
          // missing required fields like subscriptionId, customerId, ...
          eventId: 'evt_1',
          occurredAt: '2026-05-13T12:00:00.000Z',
        }),
        occurred_at: '2026-05-13T12:00:00.000Z',
      }),
    );
    if (r.kind !== 'invalid') throw new Error('expected invalid');
    expect(r.reason).toMatch(/payload schema validation failed/);
  });

  it('rejects an entry with a missing occurred_at field', () => {
    const r = parseStreamEntry(
      '1715900000000-0',
      fields({
        event_id: 'sub_abc.activated',
        event_name: 'subscription.activated',
        payload: JSON.stringify(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD),
      }),
    );
    if (r.kind !== 'invalid') throw new Error('expected invalid');
    expect(r.reason).toMatch(/occurred_at/);
  });

  it('rejects an entry with an unparseable occurred_at', () => {
    const r = parseStreamEntry(
      '1715900000000-0',
      fields({
        event_id: 'sub_abc.activated',
        event_name: 'subscription.activated',
        payload: JSON.stringify(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD),
        occurred_at: 'not-a-timestamp',
      }),
    );
    if (r.kind !== 'invalid') throw new Error('expected invalid');
    expect(r.reason).toMatch(/occurred_at not parseable/);
  });

  it('defaults producerService and schema to <unknown> when absent', () => {
    const r = parseStreamEntry(
      '1715900000000-0',
      fields({
        event_id: 'sub_abc.activated',
        event_name: 'subscription.activated',
        payload: JSON.stringify(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD),
        occurred_at: '2026-05-13T12:00:00.000Z',
      }),
    );
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.entry.producerService).toBe('<unknown>');
    expect(r.entry.producerSchema).toBe('<unknown>');
  });

  it('tolerates field reordering in the wire shape', () => {
    const reordered = fields({
      schema: 'subscription',
      producer_service: 'service-subscription',
      occurred_at: '2026-05-13T12:00:00.000Z',
      payload: JSON.stringify(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD),
      event_name: 'subscription.activated',
      event_id: 'sub_abc.activated',
    });
    const r = parseStreamEntry('1715900000000-0', reordered);
    expect(r.kind).toBe('ok');
  });
});
