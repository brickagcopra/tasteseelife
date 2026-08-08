import {
  TRUST_SAFETY_BOOKING_HOLD_RELEASED,
  TRUST_SAFETY_BOOKING_HOLD_REQUESTED,
} from '@taste-and-see/contracts';
import { OutboxConsumerService, PgConsumerDedupStore } from '@taste-and-see/nest-outbox-consumer';
import { type TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import { ENV_TOKEN } from '../../config/config.module';
import { loadEnv, type Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import type { BookingHoldReleasedHandler } from './handlers/booking-hold-released.handler';
import type { BookingHoldRequestedHandler } from './handlers/booking-hold-requested.handler';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './outbox-consumers.module';

function buildEnv(): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/booking_test',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    REDIS_URL: 'redis://localhost:6379',
    BOOKING_TIER_DISPATCH_API_KEY: 'y'.repeat(32),
    BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY: 'z'.repeat(32),
  } as unknown as NodeJS.ProcessEnv);
}

/**
 * The Redis client is constructed with `lazyConnect: true`, so nothing dials
 * out during these tests — but the instances still hold handles, so each test
 * disconnects what it built.
 */
const opened: Redis[] = [];

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.disconnect();
  }
});

/**
 * The factory's declared return type is the SDK's structural
 * `ConsumerRedisClient`, so the concrete ioredis surface these assertions
 * inspect (`status`, `options`) needs a widening cast — the narrowing is
 * the point of `asConsumerRedisClient` in the factory itself.
 */
function buildRedisClient(): Redis {
  return outboxConsumerRedisFactory.useFactory(buildEnv()) as unknown as Redis;
}

// ── The two dependency factories (ADR-0005 / TS-506) ────────────────────
//
// These four assertions used to resolve the SDK's tokens out of a
// `Test.createTestingModule` graph containing `OutboxConsumersModule` — and
// they passed, for years, while `service-booking` could not start at all.
// That is the whole shape of TS-506: the tokens were declared in this
// module, `OutboxConsumerService` was declared in the SDK's, and only a
// hand-built test graph ever put a consumer of them in the same scope as
// the providers.
//
// The specs are now plain exported values handed to `forRoot`, so calling
// `useFactory` is both simpler and closer to what Nest does. Whether the SDK
// can see them is settled by construction in `consumer.module.ts`, and
// covered end-to-end by `app.module.boot.test.ts`.

describe('outbox consumer dependency factories (TS-304 / TS-506)', () => {
  it('builds a Redis client', () => {
    const redis = buildRedisClient();
    opened.push(redis);

    expect(redis).toBeInstanceOf(Redis);
  });

  it('builds the Redis client lazily — construction dials nothing', () => {
    const redis = buildRedisClient();
    opened.push(redis);

    // `lazyConnect` leaves the client parked in 'wait' until the SDK's first
    // XREADGROUP. If this ever reads 'connecting'/'ready', the option was
    // dropped and every unit test in the service starts touching a socket.
    expect(redis.status).toBe('wait');
  });

  it('disables auto-pipelining — blocking XREADGROUP must not trap adjacent commands', () => {
    const redis = buildRedisClient();
    opened.push(redis);

    expect(redis.options.enableAutoPipelining).toBe(false);
    expect(redis.options.maxRetriesPerRequest).toBe(3);
  });

  it('injects from the tokens the composition root exports', () => {
    expect(outboxConsumerRedisFactory.inject).toStrictEqual([ENV_TOKEN]);
    expect(outboxConsumerDedupStoreFactory.inject).toStrictEqual([PrismaService]);
  });

  it('builds a dedup store scoped to the booking schema', () => {
    const prisma = { $queryRaw: () => undefined, $executeRaw: () => undefined };
    const store = outboxConsumerDedupStoreFactory.useFactory(prisma as unknown as PrismaService);

    expect(store).toBeInstanceOf(PgConsumerDedupStore);
  });
});

// ── The registration half: onModuleInit ─────────────────────────────────

/** Captures handler registrations so the wiring can be asserted. */
class FakeConsumerService {
  readonly registered = new Map<string, (args: unknown) => Promise<void>>();

  registerHandler = (event: string, handler: (args: unknown) => Promise<void>): void => {
    this.registered.set(event, handler);
  };
}

/** Records the exempt frames the registrations wrap their dispatch in. */
class FakeTenantContextStore {
  readonly frames: Array<{ kind?: string; reason?: string }> = [];
  private current: unknown = undefined;

  run = <T>(frame: unknown, fn: () => T): T => {
    const previous = this.current;
    this.current = frame;
    this.frames.push(frame as { kind?: string; reason?: string });
    try {
      return fn();
    } finally {
      this.current = previous;
    }
  };

  getStore = (): unknown => this.current;
}

/** Records dispatches without touching Prisma. */
class FakeHandler {
  readonly calls: unknown[] = [];
  handle = async (args: unknown): Promise<void> => {
    this.calls.push(args);
  };
}

function buildModuleDirect(): {
  module: OutboxConsumersModule;
  consumer: FakeConsumerService;
  tenantStore: FakeTenantContextStore;
  requested: FakeHandler;
  released: FakeHandler;
} {
  const consumer = new FakeConsumerService();
  const tenantStore = new FakeTenantContextStore();
  const requested = new FakeHandler();
  const released = new FakeHandler();
  const module = new OutboxConsumersModule(
    consumer as unknown as OutboxConsumerService,
    requested as unknown as BookingHoldRequestedHandler,
    released as unknown as BookingHoldReleasedHandler,
    tenantStore as unknown as TenantContextStore,
  );
  return { module, consumer, tenantStore, requested, released };
}

describe('OutboxConsumersModule.onModuleInit (TS-304)', () => {
  it('registers both halves of the trust & safety hold pair', () => {
    const { module, consumer } = buildModuleDirect();

    module.onModuleInit();

    expect([...consumer.registered.keys()].sort()).toEqual(
      [TRUST_SAFETY_BOOKING_HOLD_RELEASED, TRUST_SAFETY_BOOKING_HOLD_REQUESTED].sort(),
    );
  });

  it('dispatches the requested event to its handler', async () => {
    const { module, consumer, requested } = buildModuleDirect();
    module.onModuleInit();

    const args = { envelope: { eventId: 'evt_1' }, payload: { incidentId: 'inc_1' } };
    await consumer.registered.get(TRUST_SAFETY_BOOKING_HOLD_REQUESTED)?.(args);

    expect(requested.calls).toEqual([args]);
  });

  it('dispatches the released event to its handler', async () => {
    const { module, consumer, released } = buildModuleDirect();
    module.onModuleInit();

    const args = { envelope: { eventId: 'evt_2' }, payload: { incidentId: 'inc_1' } };
    await consumer.registered.get(TRUST_SAFETY_BOOKING_HOLD_RELEASED)?.(args);

    expect(released.calls).toEqual([args]);
  });

  it('wraps EVERY dispatch in an exempt tenant frame with a distinct reason', async () => {
    // Load-bearing. `AppModule` runs `enforcement: 'enforce'` and the consumer
    // poll loop carries no request context, so an unwrapped handler fails at
    // RUNTIME with `MissingRequestContextError` — never in CI. The wrap is
    // asserted here instead, and the reasons must differ so a stuck handler
    // is identifiable from a log line alone.
    const { module, consumer, tenantStore } = buildModuleDirect();
    module.onModuleInit();

    await consumer.registered.get(TRUST_SAFETY_BOOKING_HOLD_REQUESTED)?.({});
    await consumer.registered.get(TRUST_SAFETY_BOOKING_HOLD_RELEASED)?.({});

    expect(tenantStore.frames).toEqual([
      { kind: 'exempt', reason: 'outbox-consumer-trust-safety-booking-hold-requested' },
      { kind: 'exempt', reason: 'outbox-consumer-trust-safety-booking-hold-released' },
    ]);
  });

  it('leaves no tenant frame behind after a dispatch returns', async () => {
    const { module, consumer, tenantStore } = buildModuleDirect();
    module.onModuleInit();

    await consumer.registered.get(TRUST_SAFETY_BOOKING_HOLD_REQUESTED)?.({});

    expect(tenantStore.getStore()).toBeUndefined();
  });
});
