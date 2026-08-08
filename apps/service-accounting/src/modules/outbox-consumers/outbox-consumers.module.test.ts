import { Logger } from '@nestjs/common';
import {
  BOOKING_COMPLETED,
  SUBSCRIPTION_ACTIVATED,
  SUBSCRIPTION_DUNNING_EXHAUSTED,
  SUBSCRIPTION_PAUSED,
  SUBSCRIPTION_RESUMED,
} from '@taste-and-see/contracts';
import type { ConsumerHandler, OutboxConsumerService } from '@taste-and-see/nest-outbox-consumer';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import { OutboxConsumersModule } from './outbox-consumers.module';
import type { BookingCompletedHandler } from './handlers/booking-completed.handler';
import type { SubscriptionActivatedHandler } from './handlers/subscription-activated.handler';
import type { SubscriptionPausedHandler } from './handlers/subscription-paused.handler';
import type { SubscriptionResumedHandler } from './handlers/subscription-resumed.handler';

/**
 * Unit tests for `OutboxConsumersModule.onModuleInit`.
 *
 * The module wires four recognizer handlers into
 * `OutboxConsumerService.registerHandler` so the relay's poll loop
 * dispatches the consumer-side recognizers:
 *   - `SubscriptionActivatedHandler` for `subscription.activated`
 *     (TS-142-followup-2-followup-2).
 *   - `BookingCompletedHandler` for `booking.completed`
 *     (TS-083-followup-3 / TS-142-followup-3).
 *   - `SubscriptionPausedHandler` / `SubscriptionResumedHandler` for
 *     `subscription.paused` / `subscription.resumed`
 *     (TS-042-followup-3b2).
 *
 * One test asserts an ABSENCE: no handler is registered for
 * `subscription.dunning_exhausted`. That is the TS-042-followup-3b3
 * decision (an `unpaid` subscription keeps accruing — the platform has
 * invoiced and may still collect; if the debt goes bad it is a write-off
 * under TS-084, not a retroactive un-recognition), and a test is the
 * only place a decision-shaped absence survives a future reader who
 * would otherwise fill the gap.
 *
 * Under TS-020-followup-2b-platform-rollout each handler is wrapped in
 * `runWithoutTenantContext(..., '<per-event-reason>', ...)` because the
 * SDK invokes it from a background poll loop, not from an HTTP request,
 * so no `request.requestContext` exists for the
 * `TenantContextInterceptor` to seed a scoped frame from. Without the
 * wrap, every Prisma operation downstream of the handler would
 * hard-fail with `MissingRequestContextError` under `enforcement:
 * 'enforce'`.
 *
 * The tests capture the registered closures via a mock
 * `OutboxConsumerService` and invoke them with a fabricated relay
 * envelope to pin each wrap's reason string at the inner-handler
 * callsite.
 */
type AnyHandler = ConsumerHandler<typeof SUBSCRIPTION_ACTIVATED>;

function makeConsumerMock(): {
  service: OutboxConsumerService;
  captures: { eventName: string; handler: AnyHandler }[];
} {
  const captures: { eventName: string; handler: AnyHandler }[] = [];
  const service = {
    registerHandler: vi.fn((eventName: string, handler: unknown) => {
      captures.push({ eventName, handler: handler as AnyHandler });
    }),
  } as unknown as OutboxConsumerService;
  return { service, captures };
}

function makeSubscriptionHandlerStub(impl: () => Promise<void>): SubscriptionActivatedHandler {
  return { handle: vi.fn(impl) } as unknown as SubscriptionActivatedHandler;
}

function makeBookingHandlerStub(impl: () => Promise<void>): BookingCompletedHandler {
  return { handle: vi.fn(impl) } as unknown as BookingCompletedHandler;
}

function makePausedHandlerStub(impl: () => Promise<void>): SubscriptionPausedHandler {
  return { handle: vi.fn(impl) } as unknown as SubscriptionPausedHandler;
}

function makeResumedHandlerStub(impl: () => Promise<void>): SubscriptionResumedHandler {
  return { handle: vi.fn(impl) } as unknown as SubscriptionResumedHandler;
}

function makeEnvelope(): Parameters<AnyHandler>[0] {
  // Minimal stand-in for the SDK envelope shape — the wrap doesn't
  // inspect the payload, it just forwards the args to the inner
  // handler. We type-coerce so the unit test doesn't drag the full
  // contracts envelope shape into the assertion surface.
  return {
    envelope: {
      eventId: 'evt_abc',
      eventName: SUBSCRIPTION_ACTIVATED,
      occurredAt: new Date('2026-05-13T00:00:00.000Z'),
      producerService: 'service-subscription',
      producerSchema: 'subscription',
    },
    payload: {} as never,
  } as unknown as Parameters<AnyHandler>[0];
}

function makeModule(
  service: OutboxConsumerService,
  store: TenantContextStore,
  opts: {
    subscription?: SubscriptionActivatedHandler;
    booking?: BookingCompletedHandler;
    paused?: SubscriptionPausedHandler;
    resumed?: SubscriptionResumedHandler;
  } = {},
): OutboxConsumersModule {
  const subscription = opts.subscription ?? makeSubscriptionHandlerStub(async () => undefined);
  const booking = opts.booking ?? makeBookingHandlerStub(async () => undefined);
  const paused = opts.paused ?? makePausedHandlerStub(async () => undefined);
  const resumed = opts.resumed ?? makeResumedHandlerStub(async () => undefined);
  return new OutboxConsumersModule(service, subscription, booking, paused, resumed, store);
}

describe('OutboxConsumersModule.onModuleInit', () => {
  it('registers handlers for every event service-accounting consumes', () => {
    const store = new TenantContextStore();
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store);

    module.onModuleInit();

    expect(captures).toHaveLength(4);
    expect(captures.map((c) => c.eventName)).toEqual([
      SUBSCRIPTION_ACTIVATED,
      BOOKING_COMPLETED,
      SUBSCRIPTION_PAUSED,
      SUBSCRIPTION_RESUMED,
    ]);
    for (const capture of captures) {
      expect(capture.handler).toBeTypeOf('function');
    }
  });

  it('registers NO handler for subscription.dunning_exhausted (TS-042-followup-3b3: unpaid keeps accruing)', () => {
    const store = new TenantContextStore();
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store);

    module.onModuleInit();

    // The absence IS the decision. An exhausted dunning ladder moves the
    // subscription `past_due` -> `unpaid`; the platform has already
    // invoiced and may still collect, so recognition continues and no
    // journal is posted for this event. Reversing that is a write-off
    // (TS-084), not an un-recognition, and it does not begin here.
    expect(captures.map((c) => c.eventName)).not.toContain(SUBSCRIPTION_DUNNING_EXHAUSTED);
  });

  it('invokes the subscription.paused handler inside an exempt frame with the matching reason', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const paused = makePausedHandlerStub(async () => {
      captured = store.current();
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { paused });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === SUBSCRIPTION_PAUSED)?.handler;
    expect(wrapped).toBeTypeOf('function');
    await wrapped!(makeEnvelope());

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'outbox-consumer-subscription-paused',
    });
    expect(paused.handle).toHaveBeenCalledTimes(1);
  });

  it('invokes the subscription.resumed handler inside an exempt frame with the matching reason', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const resumed = makeResumedHandlerStub(async () => {
      captured = store.current();
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { resumed });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === SUBSCRIPTION_RESUMED)?.handler;
    expect(wrapped).toBeTypeOf('function');
    await wrapped!(makeEnvelope());

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'outbox-consumer-subscription-resumed',
    });
    expect(resumed.handle).toHaveBeenCalledTimes(1);
  });

  it('invokes the subscription.activated handler inside an exempt frame with the matching reason', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const subscription = makeSubscriptionHandlerStub(async () => {
      captured = store.current();
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { subscription });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === SUBSCRIPTION_ACTIVATED)?.handler;
    expect(wrapped).toBeTypeOf('function');
    await wrapped!(makeEnvelope());

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'outbox-consumer-subscription-activated',
    });
    expect(subscription.handle).toHaveBeenCalledTimes(1);
  });

  it('invokes the booking.completed handler inside an exempt frame with the matching reason', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const booking = makeBookingHandlerStub(async () => {
      captured = store.current();
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { booking });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === BOOKING_COMPLETED)?.handler;
    expect(wrapped).toBeTypeOf('function');
    await wrapped!(makeEnvelope());

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'outbox-consumer-booking-completed',
    });
    expect(booking.handle).toHaveBeenCalledTimes(1);
  });

  it('forwards args to each inner handler unchanged', async () => {
    const store = new TenantContextStore();
    const subscription = makeSubscriptionHandlerStub(async () => undefined);
    const booking = makeBookingHandlerStub(async () => undefined);
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { subscription, booking });
    module.onModuleInit();

    const subEnvelope = makeEnvelope();
    const bookingEnvelope = makeEnvelope();
    await captures.find((c) => c.eventName === SUBSCRIPTION_ACTIVATED)!.handler(subEnvelope);
    await captures.find((c) => c.eventName === BOOKING_COMPLETED)!.handler(bookingEnvelope);

    expect(subscription.handle).toHaveBeenCalledWith(subEnvelope);
    expect(booking.handle).toHaveBeenCalledWith(bookingEnvelope);
  });

  it('does not leak the exempt frame outside the wrapped handlers', async () => {
    const store = new TenantContextStore();
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store);
    module.onModuleInit();

    expect(store.current()).toBeNull();
    for (const capture of captures) {
      await capture.handler(makeEnvelope());
      expect(store.current()).toBeNull();
    }
  });

  it('rethrows errors from an inner handler without swallowing them', async () => {
    const store = new TenantContextStore();
    const booking = makeBookingHandlerStub(async () => {
      throw new Error('recognizer-failure');
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { booking });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === BOOKING_COMPLETED)!.handler;
    await expect(wrapped(makeEnvelope())).rejects.toThrow('recognizer-failure');
  });

  it('captures the frame on the handler error path (wrap survives error)', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const booking = makeBookingHandlerStub(async () => {
      captured = store.current();
      throw new Error('recognizer-failure');
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { booking });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === BOOKING_COMPLETED)!.handler;
    await expect(wrapped(makeEnvelope())).rejects.toThrow('recognizer-failure');
    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'outbox-consumer-booking-completed',
    });
  });
});

// The `Logger` import above keeps the suite's import-graph identical
// to the module's, surfacing any future tree-shake regression in the
// production code.
void Logger;
