import 'reflect-metadata';

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import type { Env } from '../../../config/env';
import { BACKGROUND_CHECK_DISPATCH_HEADER_NAME } from '../applications.constants';
import type {
  ApplicationsService,
  ApplicationsServiceFailure,
} from '../services/applications.service';
import type { BackgroundCheckService } from '../services/background-check.service';
import { err, ok } from '../services/result';

import { ApplicationsController } from './applications.controller';

const KEY = 'w'.repeat(48);
const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

function makeEnv(): Env {
  return {
    BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY: KEY,
  } as unknown as Env;
}

/**
 * Construct a fresh `TenantContextStore` for the controller. Tests that
 * pin the exempt-wrap contract pass this through to the constructor and
 * inspect `store.current()` at the collaborator's callsite.
 */
function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

type SubmitReturn = Awaited<ReturnType<ApplicationsService['submitApplication']>>;
type LatestReturn = Awaited<ReturnType<ApplicationsService['getLatestForUser']>>;
type ApplyReturn = Awaited<ReturnType<BackgroundCheckService['applyWebhookEvent']>>;

const ROW = {
  id: 'bg_1',
  providerId: 'prov_1',
  applicationId: 'app_1',
  status: 'pending' as const,
  checkrCandidateId: 'cand_1',
  checkrReportId: 'rep_1',
  lastEventId: null,
  completedAt: null,
  payloadCiphertext: null,
  payloadIv: null,
  payloadAuthTag: null,
  payloadKeyVersion: null,
  createdAt: new Date('2026-05-11T12:00:00.000Z'),
  updatedAt: new Date('2026-05-11T12:00:00.000Z'),
};

const PROV = {
  id: 'prov_1',
  userId: 'user_1',
  status: 'in_review' as const,
  tier: 'basic' as const,
  displayName: 'Chef Sam',
  headline: null,
  bio: null,
  profilePhotoKey: null,
  videoIntroKey: null,
  timeZone: 'America/New_York',
  createdAt: new Date('2026-05-11T12:00:00.000Z'),
  updatedAt: new Date('2026-05-11T12:00:00.000Z'),
  deletedAt: null,
};

const APP = {
  id: 'app_1',
  providerId: 'prov_1',
  status: 'submitted' as const,
  applicantNotes: null,
  reviewerUserId: null,
  reviewNotes: null,
  submittedAt: new Date('2026-05-11T12:00:00.000Z'),
  reviewedAt: null,
  withdrawnAt: null,
  createdAt: new Date('2026-05-11T12:00:00.000Z'),
  updatedAt: new Date('2026-05-11T12:00:00.000Z'),
};

interface FakeServiceInputs {
  submitResponse?: SubmitReturn;
  latestResponse?: LatestReturn;
  applyResponse?: ApplyReturn;
}

function makeFakeApplications(inputs: FakeServiceInputs = {}): ApplicationsService {
  return {
    submitApplication: async () =>
      inputs.submitResponse ??
      (ok({
        provider: PROV,
        application: APP,
        backgroundCheck: ROW,
      }) as SubmitReturn),
    getLatestForUser: async () =>
      inputs.latestResponse ??
      ({
        provider: null,
        application: null,
        backgroundCheck: null,
      } as LatestReturn),
  } as unknown as ApplicationsService;
}

function makeFakeBackgroundCheck(inputs: FakeServiceInputs = {}): BackgroundCheckService {
  return {
    applyWebhookEvent: async () => inputs.applyResponse ?? (ok(ROW) as ApplyReturn),
  } as unknown as BackgroundCheckService;
}

function reqWithUser(userId = 'user_1'): RequestWithContext {
  return {
    requestContext: {
      userId,
      sessionId: 'sid_1',
      mfa: false,
      roles: [],
      tenantScope: { type: 'global' },
    },
    header: (_: string) => undefined,
  } as unknown as RequestWithContext;
}

const VALID_BODY = {
  profile: {
    displayName: 'Chef Sam',
    timeZone: 'America/New_York',
    headline: 'Comfort food specialist',
  },
  applicant: {
    firstName: 'Sam',
    lastName: 'Cook',
    email: 'sam@example.com',
    phone: '+15551234567',
    dob: '1980-05-12',
    zipcode: '10021',
  },
};

describe('ApplicationsController idempotency wiring (TS-051)', () => {
  it('marks POST /api/v1/providers/applications as @Idempotent()', () => {
    const handler = ApplicationsController.prototype.submitApplication as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT mark GET /api/v1/providers/applications/me as @Idempotent()', () => {
    const handler = ApplicationsController.prototype.getMyApplication as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('does NOT mark POST /api/v1/internal/providers/background-check-events as @Idempotent()', () => {
    const handler = ApplicationsController.prototype.receiveWebhookEvent as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });
});

describe('ApplicationsController.submitApplication', () => {
  it('returns the contract-shaped SubmitProviderApplicationResponse on success', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications(),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    const response = await controller.submitApplication(VALID_BODY, reqWithUser());
    expect(response.provider.id).toBe('prov_1');
    expect(response.provider.displayName).toBe('Chef Sam');
    expect(response.application.id).toBe('app_1');
    expect(response.application.status).toBe('submitted');
    expect(response.backgroundCheck.id).toBe('bg_1');
    expect(response.backgroundCheck.status).toBe('pending');
  });

  it('throws 401 when the request carries no requestContext', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications(),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(controller.submitApplication(VALID_BODY, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps invalid_request to a 400', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications({
        submitResponse: err<ApplicationsServiceFailure>({
          reason: 'invalid_request',
          message: 'bad',
        }) as SubmitReturn,
      }),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    await expect(controller.submitApplication(VALID_BODY, reqWithUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('maps already_applied to a 409', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications({
        submitResponse: err<ApplicationsServiceFailure>({
          reason: 'already_applied',
          applicationId: 'app_existing',
        }) as SubmitReturn,
      }),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    await expect(controller.submitApplication(VALID_BODY, reqWithUser())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('maps checkr_unavailable to a 503', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications({
        submitResponse: err<ApplicationsServiceFailure>({
          reason: 'checkr_unavailable',
          cause: new Error('boom'),
        }) as SubmitReturn,
      }),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    await expect(controller.submitApplication(VALID_BODY, reqWithUser())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps checkr_invalid_applicant to a 400', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications({
        submitResponse: err<ApplicationsServiceFailure>({
          reason: 'checkr_invalid_applicant',
          message: 'bad dob',
        }) as SubmitReturn,
      }),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    await expect(controller.submitApplication(VALID_BODY, reqWithUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('ApplicationsController.getMyApplication', () => {
  it('returns { null, null, null } when no provider exists', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications(),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    const response = await controller.getMyApplication(reqWithUser());
    expect(response).toEqual({ provider: null, application: null, backgroundCheck: null });
  });

  it('returns the projected DTOs when records exist', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications({
        latestResponse: {
          provider: PROV,
          application: APP,
          backgroundCheck: ROW,
        } as LatestReturn,
      }),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    const response = await controller.getMyApplication(reqWithUser());
    expect(response.provider?.id).toBe('prov_1');
    expect(response.application?.id).toBe('app_1');
    expect(response.backgroundCheck?.id).toBe('bg_1');
  });
});

describe('ApplicationsController.receiveWebhookEvent', () => {
  function bodyFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      eventId: 'evt_abc',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{"id":"rep_abc","status":"clear"}',
      ...overrides,
    };
  }

  function reqWithHeader(headerValue: string | undefined): RequestWithContext {
    return {
      header: (name: string) =>
        name === BACKGROUND_CHECK_DISPATCH_HEADER_NAME ? headerValue : undefined,
    } as unknown as RequestWithContext;
  }

  it('rejects missing shared-secret header with 401', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications(),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    await expect(
      controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects wrong shared-secret header with 401', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications(),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    await expect(
      controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader('wrong-key')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns outcome `applied` + record when the service accepted the event', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications(),
      makeFakeBackgroundCheck(),
      makeEnv(),
      makeStore(),
    );
    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));
    expect(response.outcome).toBe('applied');
    expect(response.record?.id).toBe('bg_1');
  });

  it('returns outcome `replayed` + null record on event_replay', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications(),
      makeFakeBackgroundCheck({
        applyResponse: err({ reason: 'event_replay', eventId: 'evt_abc' }) as ApplyReturn,
      }),
      makeEnv(),
      makeStore(),
    );
    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));
    expect(response.outcome).toBe('replayed');
    expect(response.record).toBeNull();
  });

  it('returns outcome `report_mismatch` + null record when no local row exists', async () => {
    const controller = new ApplicationsController(
      makeFakeApplications(),
      makeFakeBackgroundCheck({
        applyResponse: err({ reason: 'report_mismatch', reportId: 'rep_abc' }) as ApplyReturn,
      }),
      makeEnv(),
      makeStore(),
    );
    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));
    expect(response.outcome).toBe('report_mismatch');
    expect(response.record).toBeNull();
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `ApplicationsController.receiveWebhookEvent` is the only Prisma-
 * touching pre-auth surface in this controller. The endpoint pins a
 * shared-secret header instead of `AccessTokenGuard`, so the
 * `TenantContextInterceptor` cannot seed a scoped frame from a
 * `request.requestContext` that does not exist. Without an explicit
 * exempt wrap, every Prisma operation downstream of this handler would
 * hard-fail with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`.
 *
 * These tests pin the wrap contract by passing a real
 * `TenantContextStore` and a fake collaborator that captures
 * `store.current()` at call time. The captured frame must be
 * `{ kind: 'exempt', reason: 'internal-checkr-webhook-dispatch' }` —
 * the precise reason string the audit log will surface, so a future log
 * scan can trace every "no-context" Prisma access back to its
 * dispatch source. Mirrors the canonical shape in
 * `KycController.receiveWebhookEvent` under TS-020-followup-2b.
 */
describe('ApplicationsController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  function bodyFor(): Record<string, unknown> {
    return {
      eventId: 'evt_wrap',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_wrap', candidateId: 'cand_wrap', status: 'clear' },
      rawPayload: '{"id":"rep_wrap","status":"clear"}',
    };
  }

  function reqWithHeader(headerValue: string | undefined): RequestWithContext {
    return {
      header: (name: string) =>
        name === BACKGROUND_CHECK_DISPATCH_HEADER_NAME ? headerValue : undefined,
    } as unknown as RequestWithContext;
  }

  it('runs the happy path inside an exempt frame with reason "internal-checkr-webhook-dispatch"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const fakeBackgroundCheck = {
      applyWebhookEvent: async () => {
        captured = store.current();
        return ok(ROW) as ApplyReturn;
      },
    } as unknown as BackgroundCheckService;

    const controller = new ApplicationsController(
      makeFakeApplications(),
      fakeBackgroundCheck,
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-checkr-webhook-dispatch',
    });
    expect(response.outcome).toBe('applied');
  });

  it('runs the missing-secret 401 branch inside the same exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    // The 401 short-circuit returns before any service call, so the
    // captured-frame probe lives on the `request.header` lookup — the
    // header read happens INSIDE the wrap.
    const request = {
      header: (name: string) => {
        if (name === BACKGROUND_CHECK_DISPATCH_HEADER_NAME) {
          captured = store.current();
          return undefined;
        }
        return undefined;
      },
    } as unknown as RequestWithContext;

    const controller = new ApplicationsController(
      makeFakeApplications(),
      makeFakeBackgroundCheck(),
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    await expect(
      controller.receiveWebhookEvent(bodyFor() as never, request),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.current()).toBeNull();

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-checkr-webhook-dispatch',
    });
  });

  it('runs the event_replay branch inside the exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const fakeBackgroundCheck = {
      applyWebhookEvent: async () => {
        captured = store.current();
        return err({ reason: 'event_replay', eventId: 'evt_wrap' }) as ApplyReturn;
      },
    } as unknown as BackgroundCheckService;

    const controller = new ApplicationsController(
      makeFakeApplications(),
      fakeBackgroundCheck,
      makeEnv(),
      store,
    );

    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-checkr-webhook-dispatch',
    });
    expect(response.outcome).toBe('replayed');
    expect(response.record).toBeNull();
  });

  it('runs the report_mismatch branch inside the exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const fakeBackgroundCheck = {
      applyWebhookEvent: async () => {
        captured = store.current();
        return err({ reason: 'report_mismatch', reportId: 'rep_wrap' }) as ApplyReturn;
      },
    } as unknown as BackgroundCheckService;

    const controller = new ApplicationsController(
      makeFakeApplications(),
      fakeBackgroundCheck,
      makeEnv(),
      store,
    );

    const response = await controller.receiveWebhookEvent(bodyFor() as never, reqWithHeader(KEY));

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-checkr-webhook-dispatch',
    });
    expect(response.outcome).toBe('report_mismatch');
    expect(response.record).toBeNull();
  });
});
