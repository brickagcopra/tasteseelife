import { BOOKING_CREATED, SEARCH_PERFORMED, SEARCH_RESULT_CLICKED } from '@taste-and-see/contracts';
import type { ConsumerHandler, OutboxConsumerService } from '@taste-and-see/nest-outbox-consumer';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { BookingCreatedHandler } from './handlers/booking-created.handler';
import type { SearchPerformedHandler } from './handlers/search-performed.handler';
import type { SearchResultClickedHandler } from './handlers/search-result-clicked.handler';
import { OutboxConsumersModule } from './outbox-consumers.module';

/**
 * Unit tests for `OutboxConsumersModule.onModuleInit` (TS-217-prep-3a).
 *
 * The module wires two raw-event handlers into
 * `OutboxConsumerService.registerHandler` so the relay's poll loop dispatches
 * them:
 *   - `SearchPerformedHandler` for `search.performed` (TS-217-prep-1).
 *   - `BookingCreatedHandler` for `booking.created`.
 *
 * Each handler is wrapped in `runWithoutTenantContext(..., '<reason>', ...)`
 * because the SDK invokes it from a background poll loop, not from an HTTP
 * request, so no `request.requestContext` exists for the
 * `TenantContextInterceptor` to seed a scoped frame from. Without the wrap,
 * every Prisma operation downstream would hard-fail with
 * `MissingRequestContextError` under `enforcement: 'enforce'`. The tests
 * capture the registered closures via a mock `OutboxConsumerService` and
 * invoke them with a fabricated relay envelope to pin each wrap's reason string
 * at the inner-handler callsite. Mirrors service-accounting's
 * `outbox-consumers.module.test.ts`.
 */
type AnyHandler = ConsumerHandler<typeof SEARCH_PERFORMED>;

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

function makeSearchHandlerStub(impl: () => Promise<void>): SearchPerformedHandler {
  return { handle: vi.fn(impl) } as unknown as SearchPerformedHandler;
}

function makeClickHandlerStub(impl: () => Promise<void>): SearchResultClickedHandler {
  return { handle: vi.fn(impl) } as unknown as SearchResultClickedHandler;
}

function makeBookingHandlerStub(impl: () => Promise<void>): BookingCreatedHandler {
  return { handle: vi.fn(impl) } as unknown as BookingCreatedHandler;
}

function makeEnvelope(): Parameters<AnyHandler>[0] {
  // Minimal stand-in for the SDK envelope shape — the wrap doesn't inspect
  // the payload, it just forwards the args to the inner handler.
  return {
    envelope: {
      eventId: 'evt_abc',
      eventName: SEARCH_PERFORMED,
      occurredAt: new Date('2026-06-09T12:00:00.000Z'),
      producerService: 'service-search',
      producerSchema: 'search',
    },
    payload: {} as never,
  } as unknown as Parameters<AnyHandler>[0];
}

function makeModule(
  service: OutboxConsumerService,
  store: TenantContextStore,
  opts: {
    search?: SearchPerformedHandler;
    click?: SearchResultClickedHandler;
    booking?: BookingCreatedHandler;
  } = {},
): OutboxConsumersModule {
  const search = opts.search ?? makeSearchHandlerStub(async () => undefined);
  const click = opts.click ?? makeClickHandlerStub(async () => undefined);
  const booking = opts.booking ?? makeBookingHandlerStub(async () => undefined);
  return new OutboxConsumersModule(service, search, click, booking, store);
}

describe('OutboxConsumersModule.onModuleInit', () => {
  it('registers handlers for search.performed, search.result_clicked and booking.created', () => {
    const store = new TenantContextStore();
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store);

    module.onModuleInit();

    expect(captures).toHaveLength(3);
    expect(captures.map((c) => c.eventName)).toEqual([
      SEARCH_PERFORMED,
      SEARCH_RESULT_CLICKED,
      BOOKING_CREATED,
    ]);
    for (const capture of captures) {
      expect(capture.handler).toBeTypeOf('function');
    }
  });

  it('invokes the search.result_clicked handler inside an exempt frame with the matching reason', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const click = makeClickHandlerStub(async () => {
      captured = store.current();
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { click });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === SEARCH_RESULT_CLICKED)?.handler;
    expect(wrapped).toBeTypeOf('function');
    await wrapped!(makeEnvelope());

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'outbox-consumer-search-result-clicked',
    });
    expect(click.handle).toHaveBeenCalledTimes(1);
  });

  it('invokes the search.performed handler inside an exempt frame with the matching reason', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const search = makeSearchHandlerStub(async () => {
      captured = store.current();
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { search });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === SEARCH_PERFORMED)?.handler;
    expect(wrapped).toBeTypeOf('function');
    await wrapped!(makeEnvelope());

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'outbox-consumer-search-performed',
    });
    expect(search.handle).toHaveBeenCalledTimes(1);
  });

  it('invokes the booking.created handler inside an exempt frame with the matching reason', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const booking = makeBookingHandlerStub(async () => {
      captured = store.current();
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { booking });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === BOOKING_CREATED)?.handler;
    expect(wrapped).toBeTypeOf('function');
    await wrapped!(makeEnvelope());

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'outbox-consumer-booking-created',
    });
    expect(booking.handle).toHaveBeenCalledTimes(1);
  });

  it('forwards args to each inner handler unchanged', async () => {
    const store = new TenantContextStore();
    const search = makeSearchHandlerStub(async () => undefined);
    const booking = makeBookingHandlerStub(async () => undefined);
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { search, booking });
    module.onModuleInit();

    const searchEnvelope = makeEnvelope();
    const bookingEnvelope = makeEnvelope();
    await captures.find((c) => c.eventName === SEARCH_PERFORMED)!.handler(searchEnvelope);
    await captures.find((c) => c.eventName === BOOKING_CREATED)!.handler(bookingEnvelope);

    expect(search.handle).toHaveBeenCalledWith(searchEnvelope);
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
    const search = makeSearchHandlerStub(async () => {
      throw new Error('persist-failure');
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { search });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === SEARCH_PERFORMED)!.handler;
    await expect(wrapped(makeEnvelope())).rejects.toThrow('persist-failure');
  });

  it('captures the frame on the handler error path (wrap survives error)', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const booking = makeBookingHandlerStub(async () => {
      captured = store.current();
      throw new Error('persist-failure');
    });
    const { service, captures } = makeConsumerMock();
    const module = makeModule(service, store, { booking });
    module.onModuleInit();

    const wrapped = captures.find((c) => c.eventName === BOOKING_CREATED)!.handler;
    await expect(wrapped(makeEnvelope())).rejects.toThrow('persist-failure');
    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'outbox-consumer-booking-created',
    });
  });
});
