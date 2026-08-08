import 'reflect-metadata';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';

import { AdminOrgSecurityPoliciesController } from './admin-org-security-policies.controller';
import type { OrgSecurityPolicyRow, OrgSecurityPolicyService } from './org-security-policy.service';

const NOW = new Date('2026-07-02T12:00:00.000Z');

function policyRow(overrides: Partial<OrgSecurityPolicyRow> = {}): OrgSecurityPolicyRow {
  return {
    id: 'pol_1',
    scopeId: 'tenant_abc',
    ssoRequired: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildService(
  overrides: Partial<{
    listPolicies: OrgSecurityPolicyService['listPolicies'];
    upsertPolicy: OrgSecurityPolicyService['upsertPolicy'];
  }> = {},
): OrgSecurityPolicyService {
  return {
    listPolicies:
      overrides.listPolicies ??
      (vi.fn(async () => [policyRow()]) as unknown as OrgSecurityPolicyService['listPolicies']),
    upsertPolicy:
      overrides.upsertPolicy ??
      (vi.fn(async () => policyRow()) as unknown as OrgSecurityPolicyService['upsertPolicy']),
    ssoRequiredForScopes: vi.fn(async () => false),
  } as unknown as OrgSecurityPolicyService;
}

function actorRequest(userId = 'admin_1'): RequestWithContext {
  return {
    requestContext: {
      userId,
      roles: [
        {
          name: 'super_admin',
          permissions: ['rbac:read', 'rbac:write'],
          scope: { type: 'global' },
        },
      ],
      tenantScope: { type: 'global' },
      sessionId: 'sess_1',
    },
    ip: '203.0.113.9',
    headers: {},
  } as unknown as RequestWithContext;
}

describe('AdminOrgSecurityPoliciesController — authorisation metadata', () => {
  it('gates the list on rbac:read and the upsert on rbac:write + @Idempotent', () => {
    const list = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminOrgSecurityPoliciesController.prototype.listPolicies,
    ) as readonly string[];
    expect(list).toEqual(['rbac:read']);

    const upsert = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminOrgSecurityPoliciesController.prototype.upsertPolicy,
    ) as readonly string[];
    expect(upsert).toEqual(['rbac:write']);

    const idempotent = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      AdminOrgSecurityPoliciesController.prototype.upsertPolicy,
    ) as unknown;
    expect(idempotent).toBeDefined();
  });
});

describe('AdminOrgSecurityPoliciesController.listPolicies', () => {
  it('projects service rows onto the wire DTO (ISO timestamps, contract-parsed)', async () => {
    const controller = new AdminOrgSecurityPoliciesController(buildService());
    const response = await controller.listPolicies();
    expect(response).toEqual({
      policies: [
        {
          id: 'pol_1',
          scopeId: 'tenant_abc',
          ssoRequired: true,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
    });
  });
});

describe('AdminOrgSecurityPoliciesController.upsertPolicy', () => {
  it('forwards the parsed scope id, flag, and verified-token actor to the service', async () => {
    const upsertPolicy = vi.fn(async () => policyRow());
    const controller = new AdminOrgSecurityPoliciesController(
      buildService({
        upsertPolicy: upsertPolicy as unknown as OrgSecurityPolicyService['upsertPolicy'],
      }),
    );

    const response = await controller.upsertPolicy(
      'tenant_abc',
      { ssoRequired: true },
      actorRequest('admin_9'),
    );

    expect(response.policy.scopeId).toBe('tenant_abc');
    expect(upsertPolicy).toHaveBeenCalledTimes(1);
    const [input] = upsertPolicy.mock.calls[0] as unknown as [
      { scopeId: string; ssoRequired: boolean; actor: { actorUserId: string } },
    ];
    expect(input.scopeId).toBe('tenant_abc');
    expect(input.ssoRequired).toBe(true);
    expect(input.actor.actorUserId).toBe('admin_9');
  });

  it('rejects a malformed scope id with 400 before touching the service', async () => {
    const upsertPolicy = vi.fn(async () => policyRow());
    const controller = new AdminOrgSecurityPoliciesController(
      buildService({
        upsertPolicy: upsertPolicy as unknown as OrgSecurityPolicyService['upsertPolicy'],
      }),
    );

    await expect(
      controller.upsertPolicy('bad scope id!', { ssoRequired: true }, actorRequest()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsertPolicy).not.toHaveBeenCalled();
  });

  it('401s when the request context is missing (defence in depth)', async () => {
    const controller = new AdminOrgSecurityPoliciesController(buildService());
    await expect(
      controller.upsertPolicy('tenant_abc', { ssoRequired: false }, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
