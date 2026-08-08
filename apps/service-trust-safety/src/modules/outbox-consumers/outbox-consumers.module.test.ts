import { PgConsumerDedupStore } from '@taste-and-see/nest-outbox-consumer';
import { type TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import {
  BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL,
  BOOKING_ANOMALY_MASS_CANCELLATION,
  PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING,
} from '@taste-and-see/contracts';
import type { OutboxConsumerService } from '@taste-and-see/nest-outbox-consumer';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import { ENV_TOKEN } from '../../config/config.module';
import { loadEnv, type Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import type { BackgroundCheckAdverseFindingHandler } from './handlers/background-check-adverse-finding.handler';
import type { ImpossibleTravelHandler } from './handlers/impossible-travel.handler';
import type { MassCancellationHandler } from './handlers/mass-cancellation.handler';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './outbox-consumers.module';

function buildEnv(): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/trust_safety_test',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    REDIS_URL: 'redis://localhost:6379',
  } as unknown as NodeJS.ProcessEnv);
}

/**
 * The Redis client is constructed with `lazyConnect: true`, so nothing
 * dials out during these tests — but the instances still hold handles, so
 * each test disconnects what it built.
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

/**
 * The two factory specs are exercised DIRECTLY (ADR-0005 / TS-506).
 *
 * These four assertions used to resolve the SDK's tokens out of a
 * `Test.createTestingModule` graph containing `OutboxConsumersModule` —
 * and they passed, for years, while the real application could not start.
 * That is the whole shape of TS-506: the tokens were declared in this
 * module, `OutboxConsumerService` was declared in the SDK's, and only a
 * hand-built test graph ever put a consumer of them in the same scope as
 * the providers.
 *
 * Now the specs are plain exported values handed to `forRoot`, so calling
 * `useFactory` is both simpler and closer to what Nest does. Whether the
 * SDK can actually see them is no longer this suite's question — it is
 * settled by construction in `consumer.module.ts`, and covered
 * end-to-end by `app.module.boot.test.ts`.
 */
describe('outbox consumer dependency factories', () => {
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
    // The `inject` arrays are what let the SDK module reach back into this
    // service's graph. Wrong tokens here is the same class of failure
    // TS-506 was, just one level further in.
    expect(outboxConsumerRedisFactory.inject).toStrictEqual([ENV_TOKEN]);
    expect(outboxConsumerDedupStoreFactory.inject).toStrictEqual([PrismaService]);
  });

  it('builds a dedup store scoped to the trust_safety schema', () => {
    const prisma = { $queryRaw: () => undefined, $executeRaw: () => undefined };
    const store = outboxConsumerDedupStoreFactory.useFactory(prisma as unknown as PrismaService);

    expect(store).toBeInstanceOf(PgConsumerDedupStore);
  });
});

// ── The registration half: onModuleInit (TS-307a) ───────────────────────

/** Captures handler registrations so the wiring can be asserted. */
class FakeConsumerService {
  readonly registered = new Map<string, (args: unknown) => Promise<void>>();

  registerHandler = (event: string, handler: (args: unknown) => Promise<void>): void => {
    this.registered.set(event, handler);
  };
}

/** Records the exempt frames the registration wraps its dispatch in. */
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
  handler: FakeHandler;
  travelHandler: FakeHandler;
  massCancellationHandler: FakeHandler;
} {
  const consumer = new FakeConsumerService();
  const tenantStore = new FakeTenantContextStore();
  const handler = new FakeHandler();
  const travelHandler = new FakeHandler();
  const massCancellationHandler = new FakeHandler();
  const module = new OutboxConsumersModule(
    consumer as unknown as OutboxConsumerService,
    handler as unknown as BackgroundCheckAdverseFindingHandler,
    travelHandler as unknown as ImpossibleTravelHandler,
    massCancellationHandler as unknown as MassCancellationHandler,
    tenantStore as unknown as TenantContextStore,
  );
  return { module, consumer, tenantStore, handler, travelHandler, massCancellationHandler };
}

describe('OutboxConsumersModule.onModuleInit (TS-307a)', () => {
  it("registers the service's first handler", () => {
    const { module, consumer } = buildModuleDirect();
    module.onModuleInit();

    expect([...consumer.registered.keys()]).toEqual([
      PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING,
      BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL,
      BOOKING_ANOMALY_MASS_CANCELLATION,
    ]);
  });

  it('dispatches the adverse-finding event to its handler', async () => {
    const { module, consumer, handler } = buildModuleDirect();
    module.onModuleInit();

    const dispatch = consumer.registered.get(PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING);
    await dispatch?.({ envelope: { eventId: 'evt_1' }, payload: {} });

    expect(handler.calls).toHaveLength(1);
  });

  it('wraps the dispatch in an EXEMPT tenant frame', async () => {
    // Not optional: this service runs `unscopedModels: []` under enforce
    // mode, and the SDK calls handlers from its poll loop with no request
    // context. Without the wrap, `createIncident`'s first Prisma call dies
    // with MissingRequestContextError in production and nowhere else.
    const { module, consumer, tenantStore } = buildModuleDirect();
    module.onModuleInit();

    await consumer.registered.get(PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING)?.({});

    expect(tenantStore.frames).toHaveLength(1);
    expect(tenantStore.frames[0]?.reason).toBe(
      'outbox-consumer-provider-background-check-adverse-finding',
    );
  });

  it('leaves no tenant frame behind after a dispatch returns', async () => {
    const { module, consumer, tenantStore } = buildModuleDirect();
    module.onModuleInit();

    await consumer.registered.get(PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING)?.({});

    expect(tenantStore.getStore()).toBeUndefined();
  });

  it('registers the TS-308a impossible-travel handler too', async () => {
    const { module, consumer, travelHandler } = buildModuleDirect();
    module.onModuleInit();

    const dispatch = consumer.registered.get(BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL);
    await dispatch?.({ envelope: { eventId: 'evt_2' }, payload: {} });

    expect(travelHandler.calls).toHaveLength(1);
  });

  it('wraps the impossible-travel dispatch in its own EXEMPT tenant frame', async () => {
    const { module, consumer, tenantStore } = buildModuleDirect();
    module.onModuleInit();

    await consumer.registered.get(BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL)?.({});

    expect(tenantStore.frames[0]?.reason).toBe('outbox-consumer-booking-anomaly-impossible-travel');
  });

  it('registers the TS-308c mass-cancellation handler and dispatches to it', async () => {
    const { module, consumer, massCancellationHandler } = buildModuleDirect();
    module.onModuleInit();

    const dispatch = consumer.registered.get(BOOKING_ANOMALY_MASS_CANCELLATION);
    await dispatch?.({ envelope: { eventId: 'mass-cancellation:provider:prv_1:2026-07-26' } });

    expect(massCancellationHandler.calls).toHaveLength(1);
  });

  it('wraps the mass-cancellation dispatch in its own EXEMPT tenant frame', async () => {
    // The SDK calls handlers from its poll loop, so there is no request
    // context, and the first Prisma model call inside `createIncident`
    // would die with MissingRequestContextError under enforce mode.
    const { module, consumer, tenantStore } = buildModuleDirect();
    module.onModuleInit();

    await consumer.registered.get(BOOKING_ANOMALY_MASS_CANCELLATION)?.({});

    expect(tenantStore.frames[0]?.reason).toBe('outbox-consumer-booking-anomaly-mass-cancellation');
  });
});
