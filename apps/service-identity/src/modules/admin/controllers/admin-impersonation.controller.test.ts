import 'reflect-metadata';

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';

import type {
  AdminImpersonationService,
  ImpersonationEndResult,
  ImpersonationStartResult,
} from '../services/admin-impersonation.service';
import { AdminImpersonationController } from './admin-impersonation.controller';

const NOW = new Date('2026-07-02T12:00:00.000Z');

function okStart(): ImpersonationStartResult {
  return {
    ok: true,
    value: {
      accessToken: 'access.jwt',
      expiresIn: 900,
      refreshToken: 'raw-refresh',
      sessionFamilyId: 'fam_imp_1',
      sessionExpiresAt: new Date('2026-07-02T13:00:00.000Z'),
      operatorUserId: 'usr_operator',
      user: { id: 'usr_target', email: 'target@example.com', status: 'active' },
    },
  };
}

function okEnd(ended = true): ImpersonationEndResult {
  return {
    ok: true,
    value: { sessionFamilyId: 'fam_imp_1', ended, endedAt: NOW },
  };
}

function buildService(
  overrides: Partial<{
    start: ImpersonationStartResult;
    end: ImpersonationEndResult;
  }> = {},
): {
  service: AdminImpersonationService;
  start: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn(async () => overrides.start ?? okStart());
  const end = vi.fn(async () => overrides.end ?? okEnd());
  return { service: { start, end } as unknown as AdminImpersonationService, start, end };
}

function actorRequest(userId = 'usr_operator'): RequestWithContext {
  return {
    requestContext: {
      userId,
      sessionId: 'sess_op',
      mfaVerified: true,
      roles: [
        {
          name: 'super_admin',
          permissions: ['user:impersonate'],
          scope: { type: 'global' },
        },
      ],
      tenantScope: { type: 'global' },
    },
    ip: '203.0.113.9',
    headers: { 'user-agent': 'vitest', 'x-request-id': 'req_1' },
  } as unknown as RequestWithContext;
}

describe('AdminImpersonationController.impersonate', () => {
  it('mints and returns the impersonation session envelope', async () => {
    const { service, start } = buildService();
    const controller = new AdminImpersonationController(service);

    const response = await controller.impersonate(
      'usr_target',
      { reason: 'diagnose checkout' },
      actorRequest(),
    );

    expect(response.accessToken).toBe('access.jwt');
    expect(response.tokenType).toBe('Bearer');
    expect(response.sessionFamilyId).toBe('fam_imp_1');
    expect(response.operatorUserId).toBe('usr_operator');
    expect(response.user).toEqual({
      id: 'usr_target',
      email: 'target@example.com',
      status: 'active',
    });

    const input = start.mock.calls[0]?.[0] as {
      targetUserId: string;
      reason: string;
      operatorMfaVerified: boolean;
      actor: { actorUserId: string; ip: string | null };
    };
    expect(input.targetUserId).toBe('usr_target');
    expect(input.reason).toBe('diagnose checkout');
    expect(input.operatorMfaVerified).toBe(true);
    expect(input.actor.actorUserId).toBe('usr_operator');
    expect(input.actor.ip).toBe('203.0.113.9');
  });

  it('404s an unknown target', async () => {
    const { service } = buildService({
      start: { ok: false, failure: { kind: 'target_not_found' } },
    });
    const controller = new AdminImpersonationController(service);
    await expect(
      controller.impersonate('usr_missing', { reason: 'x' }, actorRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403s self-impersonation', async () => {
    const { service } = buildService({ start: { ok: false, failure: { kind: 'self' } } });
    const controller = new AdminImpersonationController(service);
    await expect(
      controller.impersonate('usr_operator', { reason: 'x' }, actorRequest()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403s admin-staff targets', async () => {
    const { service } = buildService({
      start: { ok: false, failure: { kind: 'admin_target' } },
    });
    const controller = new AdminImpersonationController(service);
    await expect(
      controller.impersonate('usr_colleague', { reason: 'x' }, actorRequest()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('409s deactivated targets', async () => {
    const { service } = buildService({
      start: { ok: false, failure: { kind: 'deactivated' } },
    });
    const controller = new AdminImpersonationController(service);
    await expect(
      controller.impersonate('usr_closed', { reason: 'x' }, actorRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('401s when the request context is missing (guard misconfiguration)', async () => {
    const { service, start } = buildService();
    const controller = new AdminImpersonationController(service);
    await expect(
      controller.impersonate('usr_target', { reason: 'x' }, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(start).not.toHaveBeenCalled();
  });

  it('is gated on user:impersonate and marked @Idempotent', () => {
    const impersonate = AdminImpersonationController.prototype.impersonate;
    expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, impersonate)).toEqual([
      'user:impersonate',
    ]);
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, impersonate)).toBe(true);
  });
});

describe('AdminImpersonationController.end', () => {
  it('ends a session and reports the receipt', async () => {
    const { service, end } = buildService();
    const controller = new AdminImpersonationController(service);

    const response = await controller.end({ sessionFamilyId: 'fam_imp_1' }, actorRequest());

    expect(response.ended).toBe(true);
    expect(response.sessionFamilyId).toBe('fam_imp_1');
    const input = end.mock.calls[0]?.[0] as { sessionFamilyId: string };
    expect(input.sessionFamilyId).toBe('fam_imp_1');
  });

  it('reports ended: false on an already-ended family (idempotent convergence)', async () => {
    const { service } = buildService({ end: okEnd(false) });
    const controller = new AdminImpersonationController(service);
    const response = await controller.end({ sessionFamilyId: 'fam_imp_1' }, actorRequest());
    expect(response.ended).toBe(false);
  });

  it('404s an unknown family', async () => {
    const { service } = buildService({
      end: { ok: false, failure: { kind: 'family_not_found' } },
    });
    const controller = new AdminImpersonationController(service);
    await expect(
      controller.end({ sessionFamilyId: 'fam_missing' }, actorRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s a non-impersonation family', async () => {
    const { service } = buildService({
      end: { ok: false, failure: { kind: 'not_impersonation' } },
    });
    const controller = new AdminImpersonationController(service);
    await expect(
      controller.end({ sessionFamilyId: 'fam_normal' }, actorRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('is gated on user:impersonate and marked @Idempotent', () => {
    const end = AdminImpersonationController.prototype.end;
    expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, end)).toEqual([
      'user:impersonate',
    ]);
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, end)).toBe(true);
  });
});
