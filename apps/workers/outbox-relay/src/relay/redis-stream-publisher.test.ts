import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { RedisStreamPublisher } from './redis-stream-publisher';
import type { OutboxRow } from './types';

function makeFakeRedis() {
  const xadd = vi.fn().mockResolvedValue('1700000000000-0');
  const fake = { xadd } as unknown as Redis;
  return { redis: fake, xadd };
}

const ROW: OutboxRow = {
  schema: 'subscription',
  table: 'outbox_events',
  eventId: 'evt_abc',
  eventName: 'subscription.activated',
  payload: { foo: 'bar' },
  occurredAt: new Date('2026-05-13T12:00:00.000Z'),
  producerService: 'service-subscription',
  attempts: 0,
  createdAt: new Date('2026-05-13T12:00:00.000Z'),
};

describe('RedisStreamPublisher', () => {
  it('publishes to per-event-name stream with MAXLEN ~ bound', async () => {
    const { redis, xadd } = makeFakeRedis();
    const publisher = new RedisStreamPublisher(redis, 'events', 100_000);

    await publisher.publish(ROW);

    expect(xadd).toHaveBeenCalledTimes(1);
    const args = xadd.mock.calls[0] as readonly unknown[];
    expect(args[0]).toBe('events:subscription.activated');
    expect(args[1]).toBe('MAXLEN');
    expect(args[2]).toBe('~');
    expect(args[3]).toBe('100000');
    expect(args[4]).toBe('*');
  });

  it('serialises the payload as JSON', async () => {
    const { redis, xadd } = makeFakeRedis();
    const publisher = new RedisStreamPublisher(redis, 'events', 1000);

    await publisher.publish(ROW);

    const args = xadd.mock.calls[0] as readonly unknown[];
    const payloadIdx = args.indexOf('payload');
    expect(payloadIdx).toBeGreaterThan(0);
    const serialised = args[payloadIdx + 1] as string;
    expect(JSON.parse(serialised)).toEqual({ foo: 'bar' });
  });

  it('does not re-serialise a payload that is already a string', async () => {
    const { redis, xadd } = makeFakeRedis();
    const publisher = new RedisStreamPublisher(redis, 'events', 1000);

    await publisher.publish({ ...ROW, payload: '{"foo":"bar"}' });

    const args = xadd.mock.calls[0] as readonly unknown[];
    const payloadIdx = args.indexOf('payload');
    const serialised = args[payloadIdx + 1] as string;
    expect(serialised).toBe('{"foo":"bar"}');
  });

  it('honours stream-name-prefix override', async () => {
    const { redis, xadd } = makeFakeRedis();
    const publisher = new RedisStreamPublisher(redis, 'taste_events', 100);

    await publisher.publish(ROW);

    expect(xadd.mock.calls[0]?.[0]).toBe('taste_events:subscription.activated');
  });

  it('writes occurred_at as ISO8601', async () => {
    const { redis, xadd } = makeFakeRedis();
    const publisher = new RedisStreamPublisher(redis, 'events', 1000);

    await publisher.publish(ROW);

    const args = xadd.mock.calls[0] as readonly unknown[];
    const idx = args.indexOf('occurred_at');
    expect(args[idx + 1]).toBe('2026-05-13T12:00:00.000Z');
  });

  it('includes event_id, event_name, producer_service, schema in the entry', async () => {
    const { redis, xadd } = makeFakeRedis();
    const publisher = new RedisStreamPublisher(redis, 'events', 1000);

    await publisher.publish(ROW);

    const args = xadd.mock.calls[0] as readonly unknown[];
    expect(args[args.indexOf('event_id') + 1]).toBe('evt_abc');
    expect(args[args.indexOf('event_name') + 1]).toBe('subscription.activated');
    expect(args[args.indexOf('producer_service') + 1]).toBe('service-subscription');
    expect(args[args.indexOf('schema') + 1]).toBe('subscription');
  });

  it('surfaces the underlying Redis error to the caller', async () => {
    const xadd = vi.fn().mockRejectedValue(new Error('READONLY: redis is read-only'));
    const redis = { xadd } as unknown as Redis;
    const publisher = new RedisStreamPublisher(redis, 'events', 1000);

    await expect(publisher.publish(ROW)).rejects.toThrow(/READONLY/);
  });
});
