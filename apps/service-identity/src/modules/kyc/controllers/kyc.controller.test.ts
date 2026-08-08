import 'reflect-metadata';

import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import { KYC_DISPATCH_HEADER_NAME } from '../kyc.constants';
import type { KycService } from '../services/kyc.service';
import { err, ok } from '../services/result';
import type { KycServiceFailure } from '../services/kyc.service';

import { KycController } from './kyc.controller';

/**
 * Controller-level tests for `KycController`.
 *
 * Three surfaces:
 *
 *   1. `@Idempotent()` metadata wiring — pins the cache contract per
 *      TS-044-followup-2 / TS-026 (the public session-create endpoint
 *      must be idempotent; the GET / internal-dispatch endpoints must
 *      NOT be).
 *
 *   2. Behavioural coverage for the internal-dispatch endpoint — the
 *      shared-secret check has to fail closed on every malformed
 *      header, and the outcome strings must match the contract.
 *
 *   3. `runWithoutTenantContext` wrap (TS-020-followup-2b) on the
 *      internal-dispatch endpoint — the surface bypasses the
 *      AccessTokenGuard + TenantContextInterceptor pair, so the
 *      handler must declare an explicit `exempt` frame before any
 *      Prisma operation downstream of `applyWebhookEvent` fires.
 *
 * Service-layer tests in `services/kyc.service.test.ts` carry the
 * domain coverage; these tests pin the HTTP boundary.
 */

const KEY = 'k'.repeat(48);
const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

function makeEnv(): Env {
  return {
    KYC_PAYLOAD_ENC_KEY: randomBytes(32).toString('base64'),
    KYC_PAYLOAD_ENC_KEY_VERSION: 1,
    STRIPE_IDENTITY_RETURN_URL: 'https://app.tasteandsee.com/onboarding/identity/complete',
    KYC_WEBHOOK_INTERNAL_API_KEY: KEY,
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_PRIVACY_EXPORT_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'd'.repeat(48),
    IDENTITY_PRIVACY_EXPORT_API_KEY: 'e'.repeat(48),
  } as unknown as Env;
}

type StartReturn = Awaited<ReturnType<KycService['startSession']>>;
type ApplyReturn = Awaited<ReturnType<KycService['applyWebhookEvent']>>;
type LatestReturn = Awaited<ReturnType<KycService['getLatestForUser']>>;

interface FakeKycServiceInputs {
  startResponse?: StartReturn;
  applyResponse?: ApplyReturn;
  latestResponse?: LatestReturn;
}

function makeFakeService(inputs: FakeKycServiceInputs = {}): KycService {
  const defaultRecord = {
    id: 'kyc_1',
    userId: 'user_1',
    provider: 'stripe_identity',
    status: 'requires_input',
    externalId: 'vs_abc',
    payloadCiphertext: null,
    payloadIv: null,
    payloadAuthTag: null,
    payloadKeyVersion: null,
    lastEventId: null,
    verifiedAt: null,
    createdAt: new Date('2026-05-11T12:00:00.000Z'),
    updatedAt: new Date('2026-05-11T12:00:00.000Z'),
  };

  const startResponse: StartReturn =
    inputs.startResponse ??
    (ok({
      record: defaultRecord,
      clientSecret: 'cs_abc',
      hostedUrl: 'https://verify.stripe.com/v1/abc',
    }) as StartReturn);

  const applyResponse: ApplyReturn = inputs.applyResponse ?? (ok(defaultRecord) as ApplyReturn);

  const latestResponse: LatestReturn = inputs.latestResponse ?? null;

  return {
    startSession: async () => startResponse,
    applyWebhookEvent: async () => applyResponse,
    getLatestForUser: async () => latestResponse,
  } as unknown as KycService;
}

function reqWithUser(userId = 'user_1'): RequestWithContext {
  return {
    requestContext: { userId, roles: [], tenantScope: { type: 'global' } },
    header: (_: string) => undefined,
  } as unknown as RequestWithContext;
}

/**
 * Construct a fresh `TenantContextStore` for the controller. Tests that
 * do not exercise the exempt-wrap behaviour still need a real store
 * (the controller injects it; `runWithoutTenantContext` calls
 * `store.run` internally), so a no-op shared store would mask a
 * regression where the wrap silently degrades. Each test owns its own
 * store so frames from one test cannot leak into another.
 */
function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

describe('KycController idempotency wiring (TS-026)', () => {
  it('marks POST /api/v1/identity/kyc-sessions as @Idempotent()', () => {
    const handler = KycController.prototype.createSession as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT mark GET /api/v1/identity/kyc-sessions/me as @Idempotent()', () => {
    // GET is naturally idempotent; tagging it would burn a Redis
    // round-trip on every read.
    const handler = KycController.prototype.getMyStatus as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('does NOT mark POST /api/v1/internal/kyc/webhook-events as @Idempotent()', () => {
    // Internal-dispatch idempotency lives one layer deeper —
    // `applyWebhookEvent` short-circuits on `lastEventId` equality.
    // Wearing `@Idempotent()` here would double-cost a Redis hit for
    // no behavioural gain (and could mask a missed event).
    const handler = KycController.prototype.receiveWebhookEvent as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });
});

describe('KycController.createSession', () => {
  it('returns the contract-shaped CreateKycSessionResponse on success', async () => {
    const controller = new KycController(makeFakeService(), makeEnv(), makeStore());
    const response = await controller.createSession(reqWithUser());
    expect(response.clientSecret).toBe('cs_abc');
    expect(response.hostedUrl).toBe('https://verify.stripe.com/v1/abc');
    expect(response.record.id).toBe('kyc_1');
    expect(response.record.status).toBe('requires_input');
    expect(response.record.externalId).toBe('vs_abc');
  });

  it('throws 401 when the request carries no requestContext', async () => {
    const controller = new KycController(makeFakeService(), makeEnv(), makeStore());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(controller.createSession(req)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps stripe_unavailable to a 500', async () => {
    const controller = new KycController(
      makeFakeService({
        startResponse: err({
          reason: 'stripe_unavailable',
          cause: new Error('boom'),
        }) as StartReturn,
      }),
      makeEnv(),
      makeStore(),
    );
    await expect(controller.createSession(reqWithUser())).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('maps invalid_request to a 400', async () => {
    const controller = new KycController(
      makeFakeService({
        startResponse: err({ reason: 'invalid_request', message: 'bad' }) as StartReturn,
      }),
      makeEnv(),
      makeStore(),
    );
    await expect(controller.createSession(reqWithUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('KycController.getMyStatus', () => {
  it('returns { record: null } when the user has no KYC records', async () => {
    const controller = new KycController(makeFakeService(), makeEnv(), makeStore());
    const response = await controller.getMyStatus(reqWithUser());
    expect(response).toEqual({ record: null });
  });

  it('returns the DTO projection when a record exists', async () => {
    const controller = new KycController(
      makeFakeService({
        latestResponse: {
          id: 'kyc_99',
          userId: 'user_1',
          provider: 'stripe_identity',
          status: 'verified',
          externalId: 'vs_99',
          payloadCiphertext: null,
          payloadIv: null,
          payloadAuthTag: null,
          payloadKeyVersion: null,
          lastEventId: 'evt_99',
          verifiedAt: new Date('2026-05-11T13:00:00.000Z'),
          createdAt: new Date('2026-05-11T12:00:00.000Z'),
          updatedAt: new Date('2026-05-11T13:00:00.000Z'),
        } as LatestReturn,
      }),
      makeEnv(),
      makeStore(),
    );
    const response = await controller.getMyStatus(reqWithUser());
    expect(response.record?.id).toBe('kyc_99');
    expect(response.record?.status).toBe('verified');
    expect(response.record?.verifiedAt).toBe('2026-05-11T13:00:00.000Z');
  });
});

describe('KycController.receiveWebhookEvent', () => {
  function bodyFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      eventId: 'evt_abc',
      eventType: 'identity.verification_session.verified',
      eventCreatedSeconds: 1_700_000_000,
      session: {
        id: 'vs_abc',
        status: 'verified',
        clientSecret: null,
        hostedUrl: null,
        verifiedAtSeconds: 1_700_000_000,
      },
      rawPayload: '{"id":"vs_abc","status":"verified"}',
      ...overrides,
    };
  }

  function reqWithHeader(headerValue: string | undefined): RequestWithContext {
    return {
      header: (name: string) => (name === KYC_DISPATCH_HEADER_NAME ? headerValue : undefined),
    } as unknown as RequestWithContext;
  }

  it('rejects missing shared-secret header with 401', async () => {
    const controller = new KycController(makeFakeService(), makeEnv(), makeStore());
    await expect(
      controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects wrong shared-secret header with 401', async () => {
    const controller = new KycController(makeFakeService(), makeEnv(), makeStore());
    await expect(
      controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader('wrong-key')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns outcome `applied` + record when the service accepted the event', async () => {
    const controller = new KycController(makeFakeService(), makeEnv(), makeStore());
    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));
    expect(response.outcome).toBe('applied');
    expect(response.record?.id).toBe('kyc_1');
  });

  it('returns outcome `replayed` + null record on event_replay', async () => {
    const controller = new KycController(
      makeFakeService({
        applyResponse: err<KycServiceFailure>({
          reason: 'event_replay',
          eventId: 'evt_abc',
        }) as ApplyReturn,
      }),
      makeEnv(),
      makeStore(),
    );
    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));
    expect(response.outcome).toBe('replayed');
    expect(response.record).toBeNull();
  });

  it('returns outcome `session_mismatch` + null record when no local row exists', async () => {
    const controller = new KycController(
      makeFakeService({
        applyResponse: err<KycServiceFailure>({
          reason: 'session_mismatch',
          externalId: 'vs_abc',
        }) as ApplyReturn,
      }),
      makeEnv(),
      makeStore(),
    );
    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));
    expect(response.outcome).toBe('session_mismatch');
    expect(response.record).toBeNull();
  });
});

/**
 * Tenant-scope exempt wrap coverage for `receiveWebhookEvent`
 * (TS-020-followup-2b).
 *
 * The internal-dispatch endpoint is NOT gated by `AccessTokenGuard`
 * (it pins a shared-secret header), so the `TenantContextInterceptor`
 * does not seed a scoped frame for the request. The handler MUST wrap
 * its body in `runWithoutTenantContext(store, 'internal-kyc-webhook-dispatch',
 * ...)` so the Prisma extension's gate sees an explicit `exempt` frame
 * before any read or write fires.
 *
 * Each test constructs a real `TenantContextStore`, captures the frame
 * the store reports at a downstream `KycService` call (or via the
 * `Response.header` callback for the no-secret short-circuit), and
 * asserts:
 *
 *   1. The captured frame equals `{ kind: 'exempt', reason:
 *      'internal-kyc-webhook-dispatch' }` — the precise reason string
 *      ops will see in the audit log.
 *
 *   2. Frames do NOT leak past the handler's async lifetime —
 *      `store.current() === null` both before and after.
 *
 *   3. The wrap covers both success and 401 / replayed / session_mismatch
 *      branches; a regression that pulled a branch out of the wrap would
 *      surface here as `frame === null` for that branch.
 */
describe('KycController tenant-scope exempt wrap (TS-020-followup-2b)', () => {
  function bodyFor(): Record<string, unknown> {
    return {
      eventId: 'evt_wrap',
      eventType: 'identity.verification_session.verified',
      eventCreatedSeconds: 1_700_000_000,
      session: {
        id: 'vs_wrap',
        status: 'verified',
        clientSecret: null,
        hostedUrl: null,
        verifiedAtSeconds: 1_700_000_000,
      },
      rawPayload: '{"id":"vs_wrap","status":"verified"}',
    };
  }

  function reqWithHeader(headerValue: string | undefined): RequestWithContext {
    return {
      header: (name: string) => (name === KYC_DISPATCH_HEADER_NAME ? headerValue : undefined),
    } as unknown as RequestWithContext;
  }

  it('runs the happy path inside an exempt frame with reason "internal-kyc-webhook-dispatch"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const fakeService = {
      // No-op overrides for the other methods so an accidental call
      // surfaces in test logs rather than silently passing.
      startSession: async () => {
        throw new Error('startSession should not be called from receiveWebhookEvent');
      },
      applyWebhookEvent: async () => {
        captured = store.current();
        return ok({
          id: 'kyc_wrap',
          userId: 'user_wrap',
          provider: 'stripe_identity',
          status: 'verified',
          externalId: 'vs_wrap',
          payloadCiphertext: null,
          payloadIv: null,
          payloadAuthTag: null,
          payloadKeyVersion: null,
          lastEventId: 'evt_wrap',
          verifiedAt: new Date('2026-05-11T13:00:00.000Z'),
          createdAt: new Date('2026-05-11T12:00:00.000Z'),
          updatedAt: new Date('2026-05-11T13:00:00.000Z'),
        }) as ApplyReturn;
      },
      getLatestForUser: async () => null,
    } as unknown as KycService;

    const controller = new KycController(fakeService, makeEnv(), store);

    expect(store.current()).toBeNull();
    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-kyc-webhook-dispatch',
    });
    expect(response.outcome).toBe('applied');
  });

  it('runs the missing-secret 401 branch inside the same exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    // The 401 short-circuit returns before any service call, so the
    // captured-frame probe lives on the `request.header` lookup
    // — the timingSafeEqual-shaped helper invokes it INSIDE the wrap.
    const request = {
      header: (name: string) => {
        if (name === KYC_DISPATCH_HEADER_NAME) {
          captured = store.current();
          return undefined;
        }
        return undefined;
      },
    } as unknown as RequestWithContext;

    const controller = new KycController(makeFakeService(), makeEnv(), store);

    expect(store.current()).toBeNull();
    await expect(
      controller.receiveWebhookEvent(bodyFor() as never, request),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-kyc-webhook-dispatch',
    });
  });

  it('runs the event_replay branch inside the exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const fakeService = {
      startSession: async () => {
        throw new Error('startSession should not be called');
      },
      applyWebhookEvent: async () => {
        captured = store.current();
        return err<KycServiceFailure>({
          reason: 'event_replay',
          eventId: 'evt_wrap',
        }) as ApplyReturn;
      },
      getLatestForUser: async () => null,
    } as unknown as KycService;

    const controller = new KycController(fakeService, makeEnv(), store);

    expect(store.current()).toBeNull();
    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-kyc-webhook-dispatch',
    });
    expect(response.outcome).toBe('replayed');
    expect(response.record).toBeNull();
  });

  it('runs the session_mismatch branch inside the exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const fakeService = {
      startSession: async () => {
        throw new Error('startSession should not be called');
      },
      applyWebhookEvent: async () => {
        captured = store.current();
        return err<KycServiceFailure>({
          reason: 'session_mismatch',
          externalId: 'vs_wrap',
        }) as ApplyReturn;
      },
      getLatestForUser: async () => null,
    } as unknown as KycService;

    const controller = new KycController(fakeService, makeEnv(), store);

    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-kyc-webhook-dispatch',
    });
    expect(response.outcome).toBe('session_mismatch');
    expect(response.record).toBeNull();
  });
});
