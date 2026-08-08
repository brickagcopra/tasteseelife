import 'reflect-metadata';

import { UnauthorizedException } from '@nestjs/common';
import { PRIVACY_EXPORT_SLICE_SCHEMA_VERSION } from '@taste-and-see/contracts';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrivacyExportService } from '../services/privacy-export.service';

import { InternalPrivacyExportController } from './internal-privacy-export.controller';

/**
 * Controller tests for the internal export-contribution route (TS-309b).
 *
 * What matters here is not the payload — that is the service's test — but the
 * four boundary properties:
 *   1. the shared secret IS the auth model, compared in constant time;
 *   2. the 401 fires BEFORE path validation, so an unauthenticated caller
 *      cannot probe which subject kinds exist;
 *   3. the response is re-parsed at the boundary, so a slice that grew a field
 *      fails the request rather than shipping it;
 *   4. every path — 401 included — runs inside a tenant-scope exempt frame,
 *      because `User` is a scoped model and the route has no request context.
 */

const SECRET = 'p'.repeat(48);
const HEADER = 'x-internal-api-key';

function makeEnv(): Env {
  return {
    IDENTITY_PRIVACY_EXPORT_HEADER_NAME: HEADER,
    IDENTITY_PRIVACY_EXPORT_API_KEY: SECRET,
  } as unknown as Env;
}

function fakeRequest(headerValue?: string): Request {
  return {
    header: (name: string): string | undefined => (name === HEADER ? headerValue : undefined),
  } as unknown as Request;
}

function heldSlice(): unknown {
  return {
    schemaVersion: PRIVACY_EXPORT_SLICE_SCHEMA_VERSION,
    outcome: 'held',
    service: 'service-identity',
    subjectKind: 'user',
    subjectId: 'usr_1',
    generatedAt: '2026-07-27T09:30:00.000Z',
    sections: [
      { key: 'account', label: 'Your account', recordCount: 1, records: [{ id: 'usr_1' }] },
    ],
    withheld: [{ key: 'password', label: 'Your password', reason: 'credential_material' }],
  };
}

function buildController(buildImpl: () => Promise<unknown> = async () => heldSlice()): {
  controller: InternalPrivacyExportController;
  service: { buildSlice: ReturnType<typeof vi.fn> };
  frames: (TenantContextFrame | null)[];
} {
  const frames: (TenantContextFrame | null)[] = [];
  const store = new TenantContextStore();
  const service = {
    buildSlice: vi.fn(async () => {
      frames.push(store.current());
      return buildImpl();
    }),
  };

  const controller = new InternalPrivacyExportController(
    service as unknown as PrivacyExportService,
    makeEnv(),
    store,
  );

  return { controller, service, frames };
}

describe('InternalPrivacyExportController', () => {
  it('returns the slice when the shared secret matches', async () => {
    const { controller, service } = buildController();

    const result = await controller.exportSlice('user', 'usr_1', fakeRequest(SECRET));

    expect(result.outcome).toBe('held');
    expect(service.buildSlice).toHaveBeenCalledWith('user', 'usr_1');
  });

  it.each([
    ['missing', undefined],
    ['wrong value', 'q'.repeat(48)],
    ['right length, wrong bytes', `${SECRET.slice(0, 47)}x`],
    ['empty', ''],
  ])('rejects a %s secret with 401', async (_label, presented) => {
    const { controller, service } = buildController();

    await expect(controller.exportSlice('user', 'usr_1', fakeRequest(presented))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(service.buildSlice).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller BEFORE validating the subject kind', async () => {
    const { controller } = buildController();

    // A bad kind AND a bad secret: the 401 must win, or the route becomes a
    // probe for which subject kinds this platform models.
    await expect(controller.exportSlice('household', '', fakeRequest())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an unknown subject kind once authenticated', async () => {
    const { controller, service } = buildController();

    await expect(
      controller.exportSlice('household', 'hh_1', fakeRequest(SECRET)),
    ).rejects.toThrowError();
    expect(service.buildSlice).not.toHaveBeenCalled();
  });

  it('fails the request when the slice drifts from the contract', async () => {
    const { controller } = buildController(async () => {
      const slice = heldSlice() as Record<string, unknown>;
      return {
        ...slice,
        sections: [
          {
            key: 'account',
            label: 'Your account',
            recordCount: 1,
            records: [{ id: 'usr_1' }],
            // An undeclared field on a `.strict()` section: exactly how a
            // credential column would arrive if someone widened a `select`.
            passwordHash: 'leaked',
          },
        ],
      };
    });

    await expect(
      controller.exportSlice('user', 'usr_1', fakeRequest(SECRET)),
    ).rejects.toThrowError();
  });

  it('fails the request when recordCount disagrees with the records returned', async () => {
    const { controller } = buildController(async () => {
      const slice = heldSlice() as Record<string, unknown>;
      return {
        ...slice,
        sections: [{ key: 'account', label: 'Your account', recordCount: 9, records: [] }],
      };
    });

    await expect(
      controller.exportSlice('user', 'usr_1', fakeRequest(SECRET)),
    ).rejects.toThrowError();
  });

  it('runs the handler inside a tenant-scope exempt frame', async () => {
    const { controller, frames } = buildController();

    await controller.exportSlice('user', 'usr_1', fakeRequest(SECRET));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ kind: 'exempt', reason: 'identity-internal-privacy-export' });
  });
});
