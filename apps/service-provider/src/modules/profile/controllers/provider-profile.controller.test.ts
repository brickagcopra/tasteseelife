import 'reflect-metadata';

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import { err, ok } from '../services/result';
import type {
  ProviderProfileService,
  ProviderProfileSnapshot,
} from '../services/provider-profile.service';

import { ProviderProfileController } from './provider-profile.controller';

type UpdateReturn = Awaited<ReturnType<ProviderProfileService['updateProfile']>>;

const SNAPSHOT: ProviderProfileSnapshot = {
  row: {
    id: 'prov_1',
    userId: 'user_self',
    status: 'active',
    tier: 'certified',
    displayName: 'Chef Sam',
    headline: 'Comfort food specialist',
    bio: 'Updated bio.',
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    dementiaSensitive: true,
    createdAt: new Date('2026-05-20T12:00:00.000Z'),
    updatedAt: new Date('2026-05-20T12:00:01.000Z'),
    deletedAt: null,
  },
  languages: ['en', 'es'],
  cuisines: ['italian'],
  dietaryExpertise: ['low-sodium'],
};

interface FakeServiceHandle {
  readonly service: ProviderProfileService;
  /** Captured `updateProfile` input from the most recent call. */
  readonly capture: { input?: Parameters<ProviderProfileService['updateProfile']>[0] };
}

function makeFakeService(
  response?: UpdateReturn,
  snapshot: ProviderProfileSnapshot | null = SNAPSHOT,
): ProviderProfileService {
  return makeFakeServiceWithCapture(response, snapshot).service;
}

function makeFakeServiceWithCapture(
  response?: UpdateReturn,
  snapshot: ProviderProfileSnapshot | null = SNAPSHOT,
): FakeServiceHandle {
  const capture: FakeServiceHandle['capture'] = {};
  const service = {
    updateProfile: async (input: Parameters<ProviderProfileService['updateProfile']>[0]) => {
      capture.input = input;
      return response ?? (ok(SNAPSHOT) as UpdateReturn);
    },
    getProfile: async () => snapshot,
    getProfileByUserId: async () => snapshot,
  } as unknown as ProviderProfileService;
  return { service, capture };
}

function reqWithUser(userId = 'user_self'): RequestWithContext {
  return {
    requestContext: {
      userId,
      sessionId: 'sid_1',
      mfa: false,
      roles: [],
      tenantScope: { type: 'global' },
    },
    header: () => undefined,
  } as unknown as RequestWithContext;
}

const VALID_REQUEST = {
  bio: 'Updated bio.',
  languages: ['en', 'es'],
  cuisines: ['italian'],
  dietaryExpertise: ['low-sodium'],
  dementiaSensitive: true,
};

describe('ProviderProfileController.updateProfile', () => {
  it('returns the validated response on a successful update', async () => {
    const ctrl = new ProviderProfileController(makeFakeService());
    const result = await ctrl.updateProfile('prov_1', VALID_REQUEST, undefined, reqWithUser());
    expect(result.profile.id).toBe('prov_1');
    expect(result.profile.bio).toBe('Updated bio.');
    expect(result.profile.languages).toEqual(['en', 'es']);
    expect(result.profile.cuisines).toEqual(['italian']);
    expect(result.profile.dietaryExpertise).toEqual(['low-sodium']);
    expect(result.profile.dementiaSensitive).toBe(true);
    // ISO-string projection.
    expect(result.profile.updatedAt).toBe('2026-05-20T12:00:01.000Z');
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new ProviderProfileController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(
      ctrl.updateProfile('prov_1', VALID_REQUEST, undefined, req),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps invalid_request → 400', async () => {
    const ctrl = new ProviderProfileController(
      makeFakeService(
        err({
          reason: 'invalid_request',
          message: 'providerId is required',
        }) as UpdateReturn,
      ),
    );
    await expect(
      ctrl.updateProfile('prov_1', VALID_REQUEST, undefined, reqWithUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps not_found → 404', async () => {
    const ctrl = new ProviderProfileController(
      makeFakeService(err({ reason: 'not_found', providerId: 'prov_missing' }) as UpdateReturn),
    );
    await expect(
      ctrl.updateProfile('prov_missing', VALID_REQUEST, undefined, reqWithUser()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps forbidden → 403', async () => {
    const ctrl = new ProviderProfileController(
      makeFakeService(err({ reason: 'forbidden', providerId: 'prov_1' }) as UpdateReturn),
    );
    await expect(
      ctrl.updateProfile('prov_1', VALID_REQUEST, undefined, reqWithUser('user_attacker')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('maps outbox_validation_failed → 500', async () => {
    const ctrl = new ProviderProfileController(
      makeFakeService(
        err({
          reason: 'outbox_validation_failed',
          eventName: 'provider.profile_updated',
          message: 'payload failed validation',
        }) as UpdateReturn,
      ),
    );
    await expect(
      ctrl.updateProfile('prov_1', VALID_REQUEST, undefined, reqWithUser()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('wears the @Idempotent decorator', () => {
    // The decorator hangs a metadata flag on the method object itself
    // (not on the prototype + key) — matches the convention used in
    // `applications.controller.test.ts` and the @taste-and-see/nest-
    // idempotency package's `Idempotent()` implementation.
    const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');
    const handler = ProviderProfileController.prototype.updateProfile as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT wear @Idempotent on the GET snapshot endpoint', () => {
    const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');
    const handler = ProviderProfileController.prototype.getMySnapshot as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  // ─── If-Match (TS-200-followup-5) ────────────────────────────────────
  describe('If-Match header handling (TS-200-followup-5)', () => {
    it('forwards a quoted ISO `If-Match` to the service as a Date', async () => {
      const handle = makeFakeServiceWithCapture();
      const ctrl = new ProviderProfileController(handle.service);
      await ctrl.updateProfile(
        'prov_1',
        VALID_REQUEST,
        '"2026-05-20T12:00:01.000Z"',
        reqWithUser(),
      );
      const input = handle.capture.input;
      expect(input?.ifMatchUpdatedAt).toBeInstanceOf(Date);
      expect(input?.ifMatchUpdatedAt?.toISOString()).toBe('2026-05-20T12:00:01.000Z');
    });

    it('forwards an unquoted ISO `If-Match` to the service (lenient form)', async () => {
      const handle = makeFakeServiceWithCapture();
      const ctrl = new ProviderProfileController(handle.service);
      await ctrl.updateProfile('prov_1', VALID_REQUEST, '2026-05-20T12:00:01.000Z', reqWithUser());
      expect(handle.capture.input?.ifMatchUpdatedAt?.toISOString()).toBe(
        '2026-05-20T12:00:01.000Z',
      );
    });

    it('treats `If-Match: *` as "skip precondition" (no Date forwarded)', async () => {
      const handle = makeFakeServiceWithCapture();
      const ctrl = new ProviderProfileController(handle.service);
      await ctrl.updateProfile('prov_1', VALID_REQUEST, '*', reqWithUser());
      expect(handle.capture.input).toBeDefined();
      expect(handle.capture.input?.ifMatchUpdatedAt).toBeUndefined();
    });

    it('treats an absent `If-Match` header as skip-precondition', async () => {
      const handle = makeFakeServiceWithCapture();
      const ctrl = new ProviderProfileController(handle.service);
      await ctrl.updateProfile('prov_1', VALID_REQUEST, undefined, reqWithUser());
      expect(handle.capture.input?.ifMatchUpdatedAt).toBeUndefined();
    });

    it('treats an empty/whitespace-only `If-Match` header as absent', async () => {
      const handle = makeFakeServiceWithCapture();
      const ctrl = new ProviderProfileController(handle.service);
      await ctrl.updateProfile('prov_1', VALID_REQUEST, '   ', reqWithUser());
      expect(handle.capture.input?.ifMatchUpdatedAt).toBeUndefined();
    });

    it('rejects `If-Match: W/<value>` weak-validator form with 400', async () => {
      const ctrl = new ProviderProfileController(makeFakeService());
      await expect(
        ctrl.updateProfile('prov_1', VALID_REQUEST, 'W/"2026-05-20T12:00:01.000Z"', reqWithUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-ISO `If-Match` header with 400', async () => {
      const ctrl = new ProviderProfileController(makeFakeService());
      await expect(
        ctrl.updateProfile('prov_1', VALID_REQUEST, 'not-a-date', reqWithUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maps service `precondition_failed` → 412 carrying currentUpdatedAt', async () => {
      const currentUpdatedAt = new Date('2026-05-20T12:30:00.000Z');
      const ctrl = new ProviderProfileController(
        makeFakeService(
          err({
            reason: 'precondition_failed',
            providerId: 'prov_1',
            currentUpdatedAt,
          }) as UpdateReturn,
        ),
      );
      try {
        await ctrl.updateProfile(
          'prov_1',
          VALID_REQUEST,
          '"2026-05-20T12:00:00.000Z"',
          reqWithUser(),
        );
        throw new Error('expected 412 throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        const httpErr = e as HttpException;
        expect(httpErr.getStatus()).toBe(412);
        const body = httpErr.getResponse() as Record<string, unknown>;
        expect(body['status']).toBe(412);
        expect(body['currentUpdatedAt']).toBe(currentUpdatedAt.toISOString());
      }
    });
  });
});

describe('ProviderProfileController.getMySnapshot', () => {
  it('returns the snapshot projected to the rich record DTO', async () => {
    const ctrl = new ProviderProfileController(makeFakeService());
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.profile).not.toBeNull();
    expect(result.profile?.id).toBe('prov_1');
    expect(result.profile?.languages).toEqual(['en', 'es']);
    expect(result.profile?.dementiaSensitive).toBe(true);
  });

  it('returns `{ profile: null }` when the user has no provider row yet', async () => {
    const ctrl = new ProviderProfileController(makeFakeService(undefined, null));
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.profile).toBeNull();
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new ProviderProfileController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.getMySnapshot(req)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ProviderProfileController.getProfileById', () => {
  it('returns the bare profile record (no wrapper) on hit', async () => {
    const ctrl = new ProviderProfileController(makeFakeService());
    const result = await ctrl.getProfileById('prov_1', reqWithUser('user_observer'));
    // Bare record — no `{ profile: ... }` wrapper.
    expect(result.id).toBe('prov_1');
    expect(result.languages).toEqual(['en', 'es']);
    expect(result.dementiaSensitive).toBe(true);
    expect(result.updatedAt).toBe('2026-05-20T12:00:01.000Z');
  });

  it('throws 404 when the provider does not exist', async () => {
    const ctrl = new ProviderProfileController(makeFakeService(undefined, null));
    await expect(ctrl.getProfileById('prov_missing', reqWithUser())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 404 when the provider row is soft-deleted', async () => {
    const softDeleted: ProviderProfileSnapshot = {
      ...SNAPSHOT,
      row: { ...SNAPSHOT.row, deletedAt: new Date('2026-05-20T12:00:02.000Z') },
    };
    const ctrl = new ProviderProfileController(makeFakeService(undefined, softDeleted));
    await expect(ctrl.getProfileById('prov_1', reqWithUser())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new ProviderProfileController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.getProfileById('prov_1', req)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does NOT wear @Idempotent (read endpoint)', () => {
    const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');
    const handler = ProviderProfileController.prototype.getProfileById as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('does not consult the actor user id for ownership (any authenticated caller may read)', async () => {
    // PRD §6.3 frames the detailed profile as the family-portal
    // browse experience — any authenticated user may read.
    const ctrl = new ProviderProfileController(makeFakeService());
    const result = await ctrl.getProfileById('prov_1', reqWithUser('user_a_random_family_member'));
    expect(result.id).toBe('prov_1');
  });
});
