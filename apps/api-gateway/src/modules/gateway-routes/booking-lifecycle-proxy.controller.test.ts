import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { BookingLifecycleProxyController } from './booking-lifecycle-proxy.controller';

/**
 * Unit coverage for the booking-lifecycle proxies (TS-505d-prep-followup-2).
 *
 * **Why this file exists.** Every other proxy in `gateway-routes` ships with a
 * `*.controller.test.ts`; this one shipped with E2E coverage only, because it
 * was written to unblock TS-505d and a green money path was the evidence that
 * mattered. The E2E drives the happy path against a real fleet — which means
 * the branches it *cannot* reach are exactly the ones that matter when
 * something is wrong: a downstream that returns a body off-contract, a
 * downstream that times out, and a gateway with no `BOOKING_SERVICE_BASE_URL`.
 *
 * **The two properties worth stating out loud**, both called out in the
 * controller's own docblock and neither observable from E2E:
 *
 *   1. `Idempotency-Key` is forwarded on **all three writes**. These are the
 *      calls a provider's phone makes from a doorstep on a bad connection, and
 *      each downstream route wears `@Idempotent()`. Dropping the header leaves
 *      the downstream's replay cache with nothing to key on — a retried
 *      check-out would post a second completion and a second journal. A
 *      silently disabled safety feature looks identical to a working one, so
 *      it is asserted per-route rather than once.
 *   2. A downstream **client error passes through verbatim**. service-booking
 *      owns the row-level decision (403), the state machine (409) and existence
 *      (404); re-labelling any of them here would make the gateway a second
 *      place those rules are written down.
 */

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

function controllerReturning(result: DownstreamResult): {
  controller: BookingLifecycleProxyController;
  stub: StubDownstreamClient;
} {
  const stub = new StubDownstreamClient(result);
  return {
    controller: new BookingLifecycleProxyController(stub as unknown as DownstreamHttpClient),
    stub,
  };
}

function ok(body: unknown, status = 200): DownstreamResult {
  return { kind: 'ok', status, body, setCookies: [] } as DownstreamResult;
}

/** Authenticated provider, with a trace id and an idempotency key on the wire. */
const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_provider_1',
    mfaVerified: false,
    roles: [],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001', 'idempotency-key': 'idem_key_abc' },
} as unknown as RequestWithContext;

/** Same actor, but the caller sent no `Idempotency-Key`. */
const REQUEST_WITHOUT_IDEMPOTENCY_KEY: RequestWithContext = {
  requestContext: REQUEST_WITH_CTX.requestContext,
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const ANONYMOUS_REQUEST = { headers: {} } as unknown as RequestWithContext;

const VALID_BOOKING_RESPONSE = {
  id: 'bkg_1',
  householdId: 'hh_abc',
  seniorId: 'snr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining' as const,
  status: 'confirmed' as const,
  scheduledStart: '2026-06-10T17:00:00.000Z',
  scheduledEnd: '2026-06-10T19:00:00.000Z',
  currency: 'USD',
  basePriceMinor: 15_000,
  commissionRateBps: 2_000,
  commissionAmountMinor: 3_000,
  finalPriceMinor: 15_000,
  bookingNotes: null,
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  cancellationReasonText: null,
  acceptWindowExpiresAt: '2026-05-13T12:30:00.000Z',
  declinedAt: null,
  declineKind: null,
  declineReason: null,
  declineReasonText: null,
  declinedByUserId: null,
  onHold: false,
  createdAt: '2026-05-13T12:00:00.000Z',
  updatedAt: '2026-05-13T12:00:00.000Z',
};

const VALID_CHECK_IN_ROW = {
  id: 'chk_1',
  bookingId: 'bkg_1',
  kind: 'check_in' as const,
  latitude: 40.7128,
  longitude: -74.006,
  locationAccuracyMeters: 12.5,
  occurredAt: '2026-06-10T17:02:00.000Z',
  recordedByUserId: 'usr_provider_1',
  createdAt: '2026-06-10T17:02:00.000Z',
  updatedAt: '2026-06-10T17:02:00.000Z',
};

const VALID_CHECK_IN_RESPONSE = {
  checkIn: VALID_CHECK_IN_ROW,
  booking: VALID_BOOKING_RESPONSE,
};

const VALID_CHECK_IN_BODY = {
  kind: 'check_in' as const,
  latitude: 40.7128,
  longitude: -74.006,
  locationAccuracyMeters: 12.5,
};

const VALID_DECLINE_BODY = { declineReason: 'schedule_conflict' as const };

describe('BookingLifecycleProxyController.accept', () => {
  it('forwards to the accept route and returns the validated booking', async () => {
    const { controller, stub } = controllerReturning(ok(VALID_BOOKING_RESPONSE));

    const response = await controller.accept('bkg_1', {}, REQUEST_WITH_CTX);

    expect(response).toEqual(VALID_BOOKING_RESPONSE);
    expect(stub.lastOptions?.service).toBe('booking');
    expect(stub.lastOptions?.path).toBe('/api/v1/bookings/bkg_1/accept');
    expect(stub.lastOptions?.method).toBe('POST');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_provider_1');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('accepts a missing body — the accept payload is legitimately empty', async () => {
    // `AcceptBookingRequestSchema` is `z.object({}).strict()`, and the
    // controller coerces `undefined` to `{}`. A provider tapping "Accept"
    // sends no body at all; rejecting that would fail the route's only use.
    const { controller } = controllerReturning(ok(VALID_BOOKING_RESPONSE));
    await expect(controller.accept('bkg_1', undefined, REQUEST_WITH_CTX)).resolves.toEqual(
      VALID_BOOKING_RESPONSE,
    );
  });

  it('rejects an extra field with 400 (strict)', async () => {
    const { controller } = controllerReturning(ok(VALID_BOOKING_RESPONSE));
    await expect(
      controller.accept('bkg_1', { providerId: 'prv_smuggled' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('percent-encodes the id into the downstream path', async () => {
    // The id lands in a URL path segment. Without encoding, an id containing
    // `/` or `?` would let the caller choose which downstream route runs.
    const { controller, stub } = controllerReturning(ok(VALID_BOOKING_RESPONSE));
    await controller.accept('bkg 1/../admin', {}, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/bookings/bkg%201%2F..%2Fadmin/accept');
  });

  it('throws Unauthorized when there is no requestContext', async () => {
    const { controller } = controllerReturning(ok(VALID_BOOKING_RESPONSE));
    await expect(controller.accept('bkg_1', {}, ANONYMOUS_REQUEST)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('BookingLifecycleProxyController.decline', () => {
  it('forwards the validated decline body', async () => {
    const { controller, stub } = controllerReturning(ok(VALID_BOOKING_RESPONSE));

    await controller.decline('bkg_1', VALID_DECLINE_BODY, REQUEST_WITH_CTX);

    expect(stub.lastOptions?.path).toBe('/api/v1/bookings/bkg_1/decline');
    expect(stub.lastOptions?.body).toEqual(VALID_DECLINE_BODY);
  });

  it('rejects a decline with no categorical reason', async () => {
    const { controller } = controllerReturning(ok(VALID_BOOKING_RESPONSE));
    await expect(controller.decline('bkg_1', {}, REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rejects a decline reason outside the enum', async () => {
    const { controller } = controllerReturning(ok(VALID_BOOKING_RESPONSE));
    await expect(
      controller.decline('bkg_1', { declineReason: 'did_not_feel_like_it' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });
});

describe('BookingLifecycleProxyController.recordCheckIn', () => {
  it('forwards the validated check-in body', async () => {
    const { controller, stub } = controllerReturning(ok(VALID_CHECK_IN_RESPONSE, 201));

    const response = await controller.recordCheckIn('bkg_1', VALID_CHECK_IN_BODY, REQUEST_WITH_CTX);

    expect(response).toEqual(VALID_CHECK_IN_RESPONSE);
    expect(stub.lastOptions?.path).toBe('/api/v1/bookings/bkg_1/check-ins');
    expect(stub.lastOptions?.method).toBe('POST');
  });

  it('rejects a check-in with no coordinates', async () => {
    // Geo is required by product position (Phase 1): every check-in row must
    // carry verifiable location, and the fallback is the ops override surface,
    // not a "location unavailable" branch.
    const { controller } = controllerReturning(ok(VALID_CHECK_IN_RESPONSE, 201));
    await expect(
      controller.recordCheckIn('bkg_1', { kind: 'check_in' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects an out-of-range latitude', async () => {
    const { controller } = controllerReturning(ok(VALID_CHECK_IN_RESPONSE, 201));
    await expect(
      controller.recordCheckIn('bkg_1', { ...VALID_CHECK_IN_BODY, latitude: 91 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('does NOT let the caller stamp who recorded the check-in', async () => {
    // `recordedByUserId` and `occurredAt` are server-stamped from the verified
    // context and a trusted clock (CLAUDE.md §3.2). They are not on the wire,
    // and `.strict()` is what keeps them off it.
    const { controller } = controllerReturning(ok(VALID_CHECK_IN_RESPONSE, 201));
    await expect(
      controller.recordCheckIn(
        'bkg_1',
        { ...VALID_CHECK_IN_BODY, recordedByUserId: 'usr_someone_else' },
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });
});

describe('BookingLifecycleProxyController.listCheckIns', () => {
  const validList = { items: [VALID_CHECK_IN_ROW] };

  it('forwards a GET and returns the validated list', async () => {
    const { controller, stub } = controllerReturning(ok(validList));

    const response = await controller.listCheckIns('bkg_1', REQUEST_WITH_CTX);

    expect(response.items).toHaveLength(1);
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.path).toBe('/api/v1/bookings/bkg_1/check-ins');
  });

  it('sends no Idempotency-Key on the read', async () => {
    // The read is a GET; `DownstreamCallOptions` is a discriminated union on
    // `method` and only the write branch carries the key
    // (TS-505d-prep-followup-1). Asserting it here keeps the read from
    // acquiring one by copy-paste.
    const { controller, stub } = controllerReturning(ok(validList));
    await controller.listCheckIns('bkg_1', REQUEST_WITH_CTX);
    expect(stub.lastOptions).not.toHaveProperty('idempotencyKey');
  });

  it('throws Unauthorized when there is no requestContext', async () => {
    const { controller } = controllerReturning(ok(validList));
    await expect(controller.listCheckIns('bkg_1', ANONYMOUS_REQUEST)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('BookingLifecycleProxyController — Idempotency-Key forwarding', () => {
  // Per-route rather than once: the controller funnels all three writes through
  // one private helper today, but a future route added directly would be
  // invisible to a single shared assertion. These are the calls that must not
  // double-post.
  const writes: readonly {
    name: string;
    invoke: (c: BookingLifecycleProxyController, request: RequestWithContext) => Promise<unknown>;
    result: DownstreamResult;
  }[] = [
    {
      name: 'accept',
      invoke: (c, r) => c.accept('bkg_1', {}, r),
      result: ok(VALID_BOOKING_RESPONSE),
    },
    {
      name: 'decline',
      invoke: (c, r) => c.decline('bkg_1', VALID_DECLINE_BODY, r),
      result: ok(VALID_BOOKING_RESPONSE),
    },
    {
      name: 'recordCheckIn',
      invoke: (c, r) => c.recordCheckIn('bkg_1', VALID_CHECK_IN_BODY, r),
      result: ok(VALID_CHECK_IN_RESPONSE, 201),
    },
  ];

  for (const write of writes) {
    it(`forwards the caller's Idempotency-Key on ${write.name}`, async () => {
      const { controller, stub } = controllerReturning(write.result);
      await write.invoke(controller, REQUEST_WITH_CTX);
      expect(stub.lastOptions?.idempotencyKey).toBe('idem_key_abc');
    });

    it(`forwards undefined on ${write.name} when the caller sent no key`, async () => {
      // `undefined`, never a synthesised value: inventing a key here would make
      // every retry look like a distinct request to the downstream cache, which
      // is worse than no key at all because it reads as protected.
      const { controller, stub } = controllerReturning(write.result);
      await write.invoke(controller, REQUEST_WITHOUT_IDEMPOTENCY_KEY);
      expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
    });
  }
});

describe('BookingLifecycleProxyController — downstream failure mapping', () => {
  // The branches E2E cannot reach. Driven through `accept`, which shares
  // `mapResult` with every other route on the controller.
  const invoke = (c: BookingLifecycleProxyController): Promise<unknown> =>
    c.accept('bkg_1', {}, REQUEST_WITH_CTX);

  it('passes a 409 through verbatim, body and status', async () => {
    const body = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Booking is no longer in pending.',
    };
    const { controller } = controllerReturning({
      kind: 'client_error',
      status: 409,
      body,
      setCookies: [],
    } as DownstreamResult);

    await expect(invoke(controller)).rejects.toMatchObject({
      status: 409,
      response: body,
    });
  });

  it('passes a 403 through verbatim — the row-level decision is downstream', async () => {
    const { controller } = controllerReturning({
      kind: 'client_error',
      status: 403,
      body: { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Not the provider.' },
      setCookies: [],
    } as DownstreamResult);

    await expect(invoke(controller)).rejects.toMatchObject({ status: 403 });
  });

  it('substitutes a Problem Details body when the downstream client error had none', async () => {
    const { controller } = controllerReturning({
      kind: 'client_error',
      status: 400,
      body: 'plain text, not an object',
      setCookies: [],
    } as DownstreamResult);

    await expect(invoke(controller)).rejects.toMatchObject({
      status: 400,
      response: { title: 'Bad Request', detail: 'Downstream client error.' },
    });
  });

  it('maps an off-contract 200 body to 502', async () => {
    const { controller } = controllerReturning(ok({ id: 'bkg_1', status: 'confirmed' }));
    await expect(invoke(controller)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a downstream 5xx to 502', async () => {
    const { controller } = controllerReturning({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    } as DownstreamResult);
    await expect(invoke(controller)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a timeout to 504', async () => {
    const { controller } = controllerReturning({ kind: 'timeout' } as DownstreamResult);
    await expect(invoke(controller)).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps a network error to 502', async () => {
    const { controller } = controllerReturning({ kind: 'network_error' } as DownstreamResult);
    await expect(invoke(controller)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps an unconfigured BOOKING_SERVICE_BASE_URL to 503, naming the variable', async () => {
    // The operator-facing half: a 503 that does not say which variable is
    // missing sends someone reading gateway source to find out.
    const { controller } = controllerReturning({
      kind: 'not_configured',
      service: 'booking',
    } as DownstreamResult);

    await expect(invoke(controller)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(invoke(controller)).rejects.toMatchObject({
      response: { detail: expect.stringContaining('BOOKING_SERVICE_BASE_URL') },
    });
  });

  it('carries the trace id onto every mapped failure', async () => {
    const { controller } = controllerReturning({ kind: 'timeout' } as DownstreamResult);
    await expect(invoke(controller)).rejects.toMatchObject({
      response: { traceId: 'tr_test_001' },
    });
  });

  it('omits traceId rather than emitting undefined when the caller sent none', async () => {
    const { controller } = controllerReturning({ kind: 'timeout' } as DownstreamResult);
    const request = {
      requestContext: REQUEST_WITH_CTX.requestContext,
      headers: {},
    } as unknown as RequestWithContext;

    await expect(controller.accept('bkg_1', {}, request)).rejects.toSatisfy(
      (error: unknown) =>
        !Object.prototype.hasOwnProperty.call(
          (error as { response: Record<string, unknown> }).response,
          'traceId',
        ),
    );
  });
});
