import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type { HouseholdScopeResolver } from '../household-scope/services/household-scope.resolver';
import { MeController } from './me.controller';

/**
 * A resolver double returning the given memberships (TS-505d2-followup-5a).
 * `[]` is the common case — staff, providers and partner users belong to no
 * household — so it is the default here too.
 */
function makeController(
  memberships: ReadonlyArray<{ householdId: string; memberRole: string }> = [],
): { controller: MeController; listMemberships: ReturnType<typeof vi.fn> } {
  const listMemberships = vi.fn().mockResolvedValue(memberships);
  return {
    controller: new MeController({ listMemberships } as unknown as HouseholdScopeResolver),
    listMemberships,
  };
}

describe('MeController.me', async () => {
  it('returns the actor identity verbatim from the request context', async () => {
    const { controller } = makeController();
    const request = {
      requestContext: {
        userId: 'usr_abc',
        sessionId: 'sess_xyz',
        mfaVerified: true,
        roles: [
          {
            name: 'family_payer',
            scope: { type: 'global' as const },
            permissions: ['subscription:write', 'booking:read'],
          },
        ],
        tenantScope: { type: 'household' as const, householdId: 'hh_123' },
      },
      headers: {},
    } as unknown as RequestWithContext;

    const response = await controller.me(request);
    expect(response.userId).toBe('usr_abc');
    expect(response.sessionId).toBe('sess_xyz');
    expect(response.mfaVerified).toBe(true);
    expect(response.roles).toHaveLength(1);
    expect(response.roles[0]!.name).toBe('family_payer');
    expect(response.roles[0]!.permissions).toEqual(['subscription:write', 'booking:read']);
    expect(response.tenantScope).toEqual({ type: 'household', householdId: 'hh_123' });
  });

  it('reports every household the actor may act in, alongside the one in scope', async () => {
    // `tenantScope` and `households` answer DIFFERENT questions: which
    // household this request is acting in, versus which ones it could. The
    // family portal needs both — a picker is only shown when there is more
    // than one.
    const { controller, listMemberships } = makeController([
      { householdId: 'hh_a', memberRole: 'primary_payer' },
      { householdId: 'hh_b', memberRole: 'family_observer' },
    ]);
    const response = await controller.me({
      requestContext: {
        userId: 'usr_two',
        sessionId: 'sess_1',
        mfaVerified: false,
        roles: [],
        tenantScope: { type: 'global' as const },
      },
      headers: { 'x-trace-id': 'trace-9' },
    } as unknown as RequestWithContext);

    expect(response.households).toEqual([
      { householdId: 'hh_a', memberRole: 'primary_payer' },
      { householdId: 'hh_b', memberRole: 'family_observer' },
    ]);
    // Still `global`, deliberately — several memberships and no
    // `X-Household-Id` header means the gateway refuses to pick one, which is
    // exactly the state this list exists to let the portal resolve.
    expect(response.tenantScope).toEqual({ type: 'global' });
    expect(listMemberships).toHaveBeenCalledWith({ userId: 'usr_two', traceId: 'trace-9' });
  });

  it('reports an empty list rather than omitting the field, for an actor with no household', async () => {
    // Not `.optional()`: an absent field and an empty list would be
    // indistinguishable to a client deciding whether to show a picker, and
    // "belongs to no household" is a real answer.
    const { controller } = makeController([]);
    const response = await controller.me({
      requestContext: {
        userId: 'usr_staff',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' as const },
      },
      headers: {},
    } as unknown as RequestWithContext);

    expect(response.households).toEqual([]);
    expect('households' in response).toBe(true);
  });

  it('surfaces the actorOnBehalfOf claim on impersonation sessions and omits it otherwise (TS-297)', async () => {
    const { controller } = makeController();
    const base = {
      userId: 'usr_target',
      sessionId: 'fam_imp_1',
      mfaVerified: true,
      roles: [],
      tenantScope: { type: 'global' as const },
    };

    const impersonated = await controller.me({
      requestContext: { ...base, actorOnBehalfOf: 'usr_operator' },
      headers: {},
    } as unknown as RequestWithContext);
    expect(impersonated.actorOnBehalfOf).toBe('usr_operator');
    expect(impersonated.userId).toBe('usr_target');

    const ordinary = await controller.me({
      requestContext: base,
      headers: {},
    } as unknown as RequestWithContext);
    expect('actorOnBehalfOf' in ordinary).toBe(false);
  });

  it('emits sessionId=null when the access token did not carry a session id', async () => {
    const { controller } = makeController();
    const request = {
      requestContext: {
        userId: 'usr_abc',
        mfaVerified: false,
        roles: [],
        tenantScope: { type: 'global' as const },
      },
      headers: {},
    } as unknown as RequestWithContext;

    const response = await controller.me(request);
    expect(response.sessionId).toBeNull();
    expect(response.mfaVerified).toBe(false);
    expect(response.roles).toEqual([]);
    expect(response.tenantScope).toEqual({ type: 'global' });
  });

  it('emits expiresAt when a role assignment carries one', async () => {
    const { controller } = makeController();
    const request = {
      requestContext: {
        userId: 'usr_abc',
        mfaVerified: true,
        roles: [
          {
            name: 'super_admin',
            scope: { type: 'global' as const },
            permissions: [],
            expiresAt: '2026-12-31T23:59:59.000Z',
          },
        ],
        tenantScope: { type: 'global' as const },
      },
      headers: {},
    } as unknown as RequestWithContext;

    const response = await controller.me(request);
    expect(response.roles[0]!.expiresAt).toBe('2026-12-31T23:59:59.000Z');
  });

  it('throws UnauthorizedException when the guard chain failed to attach a request context', async () => {
    const { controller } = makeController();
    const request = { headers: {} } as unknown as RequestWithContext;
    await expect(controller.me(request)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
