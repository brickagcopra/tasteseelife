import { SUBSCRIPTION_ACTIVATED, SUBSCRIPTION_CANCELED } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import { validateOptions } from '../config';

import { OutboxConsumerService } from './consumer.service';
import { MemoryConsumerDedupStore } from './memory-dedup-store';
import type { ConsumerRedisClient } from './redis-stream-consumer';

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

const VALID_SUBSCRIPTION_CANCELED_PAYLOAD = {
  eventId: 'sub_abc.canceled.1',
  occurredAt: '2026-05-13T13:00:00.000Z',
  subscriptionId: 'sub_abc',
  customerId: 'hh_123',
  reason: 'customer_request' as const,
  effectiveAt: '2026-05-13T13:00:00.000Z',
};

interface FakeRedis extends ConsumerRedisClient {
  groupCreates: Array<Array<string | number>>;
  acks: Array<{ stream: string; group: string; ids: string[] }>;
  nextRead: unknown;
  nextReclaim: unknown;
}

function buildFakeRedis(): FakeRedis {
  const groupCreates: Array<Array<string | number>> = [];
  const acks: Array<{ stream: string; group: string; ids: string[] }> = [];
  const fake = {
    groupCreates,
    acks,
    nextRead: [] as unknown,
    nextReclaim: ['0-0', [], []] as unknown,
    call: vi.fn(async (...args: Array<string | number>) => {
      if (args[0] === 'XGROUP') groupCreates.push(args);
      return undefined;
    }),
    xreadgroup: vi.fn(async function (this: FakeRedis) {
      return this.nextRead;
    }),
    xack: vi.fn(async (stream: string, group: string, ...ids: string[]) => {
      acks.push({ stream, group, ids });
      return 1;
    }),
    xautoclaim: vi.fn(async function (this: FakeRedis) {
      return this.nextReclaim;
    }),
    xpending: vi.fn(async () => []),
  };
  // Bind the methods that read from `this`:
  fake.xreadgroup = vi.fn(async () => fake.nextRead);
  fake.xautoclaim = vi.fn(async () => fake.nextReclaim);
  return fake as unknown as FakeRedis;
}

function buildService(opts?: { consumerGroup?: string; maxAttempts?: number }): {
  service: OutboxConsumerService;
  redis: FakeRedis;
  dedup: MemoryConsumerDedupStore;
} {
  const redis = buildFakeRedis();
  const dedup = new MemoryConsumerDedupStore();
  const validated = validateOptions({
    consumerGroup: opts?.consumerGroup ?? 'service-accounting',
    maxAttempts: opts?.maxAttempts ?? 3,
    pollBlockMs: 0,
    pollIntervalMs: 0,
  });
  const service = new OutboxConsumerService(validated, redis, dedup);
  return { service, redis, dedup };
}

function entryFor(payload: unknown, eventName: string, eventId: string): unknown {
  return [
    'event_id',
    eventId,
    'event_name',
    eventName,
    'payload',
    JSON.stringify(payload),
    'occurred_at',
    '2026-05-13T12:00:00.000Z',
    'producer_service',
    'service-subscription',
    'schema',
    'subscription',
  ];
}

describe('OutboxConsumerService — registration + bootstrap', () => {
  it('records registered event names without bootstrapping', () => {
    const { service } = buildService();
    service.registerHandler(SUBSCRIPTION_ACTIVATED, async () => undefined);
    expect(service.registeredEventNames()).toEqual([SUBSCRIPTION_ACTIVATED]);
  });

  it('creates a Redis consumer group per subscribed stream on bootstrap', async () => {
    const { service, redis } = buildService();
    service.registerHandler(SUBSCRIPTION_ACTIVATED, async () => undefined);
    service.registerHandler(SUBSCRIPTION_CANCELED, async () => undefined);
    await service.bootstrap();
    // 2 streams subscribed → 2 XGROUP CREATE calls
    expect(redis.groupCreates).toHaveLength(2);
    expect(redis.groupCreates[0]).toContain('XGROUP');
    expect(redis.groupCreates[0]).toContain('CREATE');
    expect(redis.groupCreates[0]).toContain('events:subscription.activated');
    expect(redis.groupCreates[1]).toContain('events:subscription.canceled');
  });

  it('is idempotent on a second bootstrap call', async () => {
    const { service, redis } = buildService();
    service.registerHandler(SUBSCRIPTION_ACTIVATED, async () => undefined);
    await service.bootstrap();
    await service.bootstrap();
    expect(redis.groupCreates).toHaveLength(1);
  });

  it('rejects pollOnce() before bootstrap', async () => {
    const { service } = buildService();
    service.registerHandler(SUBSCRIPTION_ACTIVATED, async () => undefined);
    await expect(service.pollOnce()).rejects.toThrow(/called before bootstrap/);
  });

  it('warns and overwrites on duplicate registerHandler', async () => {
    const { service } = buildService();
    const h1 = vi.fn(async () => undefined);
    const h2 = vi.fn(async () => undefined);
    service.registerHandler(SUBSCRIPTION_ACTIVATED, h1);
    service.registerHandler(SUBSCRIPTION_ACTIVATED, h2);
    expect(service.registeredEventNames()).toEqual([SUBSCRIPTION_ACTIVATED]);
  });

  it('registerHandlers accepts a bulk array', () => {
    const { service } = buildService();
    service.registerHandlers([
      { eventName: SUBSCRIPTION_ACTIVATED, handler: async () => undefined },
      { eventName: SUBSCRIPTION_CANCELED, handler: async () => undefined },
    ]);
    expect(service.registeredEventNames().length).toBe(2);
  });
});

describe('OutboxConsumerService — pollOnce happy path', () => {
  it('dispatches a single well-formed entry to the matching handler', async () => {
    const { service, redis, dedup } = buildService();
    const handlerCalls: Array<{
      envelope: { eventId: string; eventName: string };
      payload: { subscriptionId: string };
    }> = [];
    const handler = vi.fn(
      async (args: {
        envelope: { eventId: string; eventName: string };
        payload: { subscriptionId: string };
      }) => {
        handlerCalls.push(args);
      },
    );
    service.registerHandler(SUBSCRIPTION_ACTIVATED, handler as never);
    await service.bootstrap();

    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_1'),
          ],
        ],
      ],
    ];

    const summary = await service.pollOnce();

    expect(summary.entriesRead).toBe(1);
    expect(summary.handlersInvoked).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.deadLettered).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    const callArg = handlerCalls[0];
    expect(callArg?.envelope.eventId).toBe('evt_1');
    expect(callArg?.envelope.eventName).toBe('subscription.activated');
    expect(callArg?.payload.subscriptionId).toBe('sub_abc');
    // Dedup recorded as processed; entry XACKed
    expect((await dedup.getState('service-accounting', 'evt_1')).kind).toBe('processed');
    expect(redis.acks).toHaveLength(1);
    expect(redis.acks[0]).toEqual({
      stream: 'events:subscription.activated',
      group: 'service-accounting',
      ids: ['1-0'],
    });
  });

  it('returns empty summary when no handlers are registered', async () => {
    const { service } = buildService();
    await service.bootstrap();
    const summary = await service.pollOnce();
    expect(summary).toEqual({
      entriesRead: 0,
      handlersInvoked: 0,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
      skippedAlreadyProcessed: 0,
    });
  });

  it('dispatches to the correct handler when multiple streams are subscribed', async () => {
    const { service, redis } = buildService();
    const activated = vi.fn(async () => undefined);
    const canceled = vi.fn(async () => undefined);
    service.registerHandler(SUBSCRIPTION_ACTIVATED, activated);
    service.registerHandler(SUBSCRIPTION_CANCELED, canceled);
    await service.bootstrap();

    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_a'),
          ],
        ],
      ],
      [
        'events:subscription.canceled',
        [['2-0', entryFor(VALID_SUBSCRIPTION_CANCELED_PAYLOAD, 'subscription.canceled', 'evt_c')]],
      ],
    ];

    const summary = await service.pollOnce();
    expect(summary.handlersInvoked).toBe(2);
    expect(activated).toHaveBeenCalledTimes(1);
    expect(canceled).toHaveBeenCalledTimes(1);
  });

  it('short-circuits an already-processed entry (XACK without handler invocation)', async () => {
    const { service, redis, dedup } = buildService();
    const handler = vi.fn(async () => undefined);
    service.registerHandler(SUBSCRIPTION_ACTIVATED, handler);
    await service.bootstrap();

    // Pre-mark as processed
    await dedup.recordAttempt('service-accounting', 'evt_already', 'subscription.activated');
    await dedup.recordSuccess('service-accounting', 'evt_already');

    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_already'),
          ],
        ],
      ],
    ];

    const summary = await service.pollOnce();
    expect(summary.skippedAlreadyProcessed).toBe(1);
    expect(summary.handlersInvoked).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    expect(redis.acks).toHaveLength(1); // still XACKed
  });
});

describe('OutboxConsumerService — handler failure + retry / dead-letter', () => {
  it('records failure when handler throws AND does NOT XACK (leaves entry in PEL)', async () => {
    const { service, redis, dedup } = buildService();
    const handler = vi.fn(async () => {
      throw new Error('transient db error');
    });
    service.registerHandler(SUBSCRIPTION_ACTIVATED, handler);
    await service.bootstrap();

    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_fail'),
          ],
        ],
      ],
    ];
    const summary = await service.pollOnce();
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(redis.acks).toHaveLength(0);
    const snap = dedup.snapshot();
    expect(snap[0]?.state).toBe('in_flight');
    expect(snap[0]?.attempts).toBe(1);
    expect(snap[0]?.lastError).toMatch(/transient db error/);
  });

  it('dead-letters after maxAttempts is reached (and XACKs the entry)', async () => {
    const { service, redis, dedup } = buildService({ maxAttempts: 2 });
    const handler = vi.fn(async () => {
      throw new Error('still broken');
    });
    service.registerHandler(SUBSCRIPTION_ACTIVATED, handler);
    await service.bootstrap();

    // First attempt
    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_dl'),
          ],
        ],
      ],
    ];
    await service.pollOnce();
    expect((await dedup.getState('service-accounting', 'evt_dl')).kind).toBe('in_flight');

    // Second attempt — at maxAttempts=2, nextAttempts=3 > 2, dead-letter
    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_dl'),
          ],
        ],
      ],
    ];
    const summary2 = await service.pollOnce();
    expect(summary2.failed).toBe(1);

    // Third attempt — dead-letter
    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_dl'),
          ],
        ],
      ],
    ];
    const summary3 = await service.pollOnce();
    expect(summary3.deadLettered).toBe(1);
    expect((await dedup.getState('service-accounting', 'evt_dl')).kind).toBe('dead_lettered');
    // XACKed exactly once total (the dead-letter call)
    expect(redis.acks).toHaveLength(1);
  });

  it('dead-letters a malformed entry without ever invoking a handler', async () => {
    const { service, redis, dedup } = buildService();
    const handler = vi.fn(async () => undefined);
    service.registerHandler(SUBSCRIPTION_ACTIVATED, handler);
    await service.bootstrap();

    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            [
              'event_id',
              'evt_bad',
              'event_name',
              'subscription.activated',
              'payload',
              'not-json',
              'occurred_at',
              '2026-05-13T12:00:00.000Z',
            ],
          ],
        ],
      ],
    ];
    const summary = await service.pollOnce();
    expect(summary.deadLettered).toBe(1);
    expect(summary.handlersInvoked).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    expect(redis.acks).toHaveLength(1);
    expect((await dedup.getState('service-accounting', 'evt_bad')).kind).toBe('dead_lettered');
  });

  it('skips an entry with no registered handler (XACK to drop, no handler invocation)', async () => {
    const { service, redis } = buildService();
    // Register only the activated handler; the canceled entry below has
    // no handler so the SDK XACKs to drop it.
    service.registerHandler(SUBSCRIPTION_ACTIVATED, async () => undefined);
    await service.bootstrap();

    // bootstrap subscribed only the activated stream — but we can still
    // simulate an entry arriving on a stream the service group is on.
    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_CANCELED_PAYLOAD, 'subscription.canceled', 'evt_orphan'),
          ],
        ],
      ],
    ];

    const summary = await service.pollOnce();
    expect(summary.handlersInvoked).toBe(0);
    expect(redis.acks).toHaveLength(1);
  });
});

describe('OutboxConsumerService — defensive paths', () => {
  it('continues the cycle when xreadgroup throws', async () => {
    const { service, redis } = buildService();
    service.registerHandler(SUBSCRIPTION_ACTIVATED, async () => undefined);
    await service.bootstrap();
    redis.xreadgroup = vi.fn(async () => {
      throw new Error('redis ECONNRESET');
    });
    const summary = await service.pollOnce();
    expect(summary.entriesRead).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('continues the cycle when xautoclaim throws', async () => {
    const { service, redis } = buildService();
    service.registerHandler(SUBSCRIPTION_ACTIVATED, async () => undefined);
    await service.bootstrap();
    redis.xautoclaim = vi.fn(async () => {
      throw new Error('redis ECONNRESET');
    });
    const summary = await service.pollOnce();
    expect(summary.entriesRead).toBe(0);
  });

  it('counts multiple handler outcomes across one cycle', async () => {
    const { service, redis } = buildService();
    let i = 0;
    service.registerHandler(SUBSCRIPTION_ACTIVATED, async () => {
      i += 1;
      if (i === 2) throw new Error('flaky');
    });
    await service.bootstrap();

    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_a'),
          ],
          [
            '2-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_b'),
          ],
          [
            '3-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_c'),
          ],
        ],
      ],
    ];
    const summary = await service.pollOnce();
    expect(summary.entriesRead).toBe(3);
    expect(summary.handlersInvoked).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it('records the attempt before invoking the handler', async () => {
    const { service, redis, dedup } = buildService();
    const seen: Array<{ kind: string; attempts?: number }> = [];
    service.registerHandler(SUBSCRIPTION_ACTIVATED, async () => {
      seen.push(await dedup.getState('service-accounting', 'evt_x'));
    });
    await service.bootstrap();
    redis.nextRead = [
      [
        'events:subscription.activated',
        [
          [
            '1-0',
            entryFor(VALID_SUBSCRIPTION_ACTIVATED_PAYLOAD, 'subscription.activated', 'evt_x'),
          ],
        ],
      ],
    ];
    await service.pollOnce();
    // During the handler call the state is `in_flight` with attempts=1
    expect(seen[0]).toEqual({ kind: 'in_flight', attempts: 1 });
  });
});
