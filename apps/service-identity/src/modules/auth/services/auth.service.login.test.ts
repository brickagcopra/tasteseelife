import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { LoginRequest } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { OrgSecurityPolicyService } from '../../rbac/org-security-policy.service';
import type { RoleAssignmentService } from '../../rbac/role-assignment.service';
import { AuthService } from './auth.service';
import type { IpCircuitBreakerService } from './ip-circuit-breaker.service';
import type { LockoutService } from './lockout.service';
import type { MfaChallengeTokenService } from './mfa-challenge-token.service';
import type { PasswordHasherService } from './password-hasher.service';
import type { RefreshTokenService } from './refresh-token.service';
import type { TokenService } from './token.service';

const FAKE_DIGEST = `$2b$12$${'a'.repeat(22)}${'b'.repeat(31)}`;

interface FakeUser {
  id: string;
  email: string;
  passwordHash: string;
  status: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
  deletedAt: Date | null;
  mfaEnabled?: boolean;
  lockedUntil?: Date | null;
}

function buildPrismaWithUser(user: FakeUser | null): PrismaService {
  return {
    user: {
      findUnique: vi.fn(async (req: { where: { email?: string } }) => {
        if (user === null) return null;
        if (req.where.email === user.email) {
          // Default mfaEnabled=false and lockedUntil=null so existing
          // fixtures that omit them keep working — fixture authors
          // can override either explicitly.
          return { mfaEnabled: false, lockedUntil: null, ...user };
        }
        return null;
      }),
    },
  } as unknown as PrismaService;
}

class FakeHasher {
  verify = vi.fn(async (plaintext: string, digest: string): Promise<boolean> => {
    // Fakes a real bcrypt by string-comparing plaintext+digest pairs.
    // Tests configure these via .mockResolvedValueOnce when they need
    // a specific outcome.
    void plaintext;
    void digest;
    return false;
  });
}

class FakeTokenService {
  signAccessToken = vi.fn(
    (args: {
      userId: string;
      sessionId: string;
      mfaVerified?: boolean;
      roles?: ReadonlyArray<{ name: string }>;
    }) => ({
      token: `signed.${args.userId}.${args.sessionId}.mfa=${args.mfaVerified ?? false}.roles=${(
        args.roles ?? []
      )
        .map((r) => r.name)
        .join(',')}`,
      expiresInSeconds: 900,
    }),
  );
  generateRefreshToken = vi.fn();
  hashRefreshToken = vi.fn();
  refreshTokenExpiresAt = vi.fn();
  refreshCookieMaxAgeSeconds = 0;
}

class FakeRefreshTokenService {
  issueNewSession = vi.fn(
    async (args: {
      userId: string;
    }): Promise<{ familyId: string; rawRefreshToken: string; expiresAt: Date }> => ({
      familyId: `family_for_${args.userId}`,
      rawRefreshToken: 'raw-refresh-token-abcdef',
      expiresAt: new Date('2026-06-08T12:00:00.000Z'),
    }),
  );
  rotate = vi.fn();
  revokeFamily = vi.fn();
  findFamilyForRawToken = vi.fn();
}

class FakeMfaChallengeTokenService {
  issue = vi.fn(async (args: { userId: string; ip?: string; userAgent?: string }) => ({
    token: `challenge.${args.userId}`,
    expiresInSeconds: 300,
    expiresAt: new Date('2026-05-09T12:05:00.000Z'),
    jti: `jti_${args.userId}`,
  }));
  consume = vi.fn();
}

class FakeRoleAssignmentService {
  getActiveAssignments = vi.fn(async (_userId: string) => [] as readonly never[]);
  holdsAnyRole = vi.fn(async (_userId: string, _roleNames: readonly string[]) => false);
  grant = vi.fn();
  revoke = vi.fn();
  listForUser = vi.fn();
}

/**
 * Fake for `OrgSecurityPolicyService`. Default posture: no scope
 * requires SSO. SSO-gate tests flip `ssoRequiredForScopes` to
 * resolve true and assert the 403.
 */
class FakeOrgSecurityPolicyService {
  ssoRequiredForScopes = vi.fn(async (_scopeIds: readonly string[]): Promise<boolean> => false);
  listPolicies = vi.fn();
  upsertPolicy = vi.fn();
}

class FakeLockoutService {
  isLocked = vi.fn((_lockedUntil: Date | null, _now?: Date) => false);
  recordFailure = vi.fn(
    async (
      _userId: string,
      _now?: Date,
    ): Promise<{ failedLoginCount: number; lockedUntil: Date | null }> => ({
      failedLoginCount: 0,
      lockedUntil: null,
    }),
  );
  recordSuccess = vi.fn(async (_userId: string): Promise<void> => undefined);
}

/**
 * Fake for `IpCircuitBreakerService`. Default posture: never blocked
 * + recordFailure returns 1. Tests that drive the breaker tweak
 * `checkBlocked.mockResolvedValueOnce(true)` for the tripped path.
 */
class FakeIpCircuitBreakerService {
  checkBlocked = vi.fn(async (_ip: string | undefined): Promise<boolean> => false);
  recordFailure = vi.fn(async (_ip: string | undefined): Promise<number | null> => 1);
}

const validInput: LoginRequest = {
  email: 'Alice@Example.com',
  password: 'correct horse battery staple',
};

function buildSvc(args: {
  prisma: PrismaService;
  hasher?: FakeHasher;
  token?: FakeTokenService;
  refresh?: FakeRefreshTokenService;
  mfaChallenge?: FakeMfaChallengeTokenService;
  roleAssignments?: FakeRoleAssignmentService;
  orgSecurityPolicies?: FakeOrgSecurityPolicyService;
  lockout?: FakeLockoutService;
  ipCircuitBreaker?: FakeIpCircuitBreakerService;
}): {
  svc: AuthService;
  hasher: FakeHasher;
  token: FakeTokenService;
  refresh: FakeRefreshTokenService;
  mfaChallenge: FakeMfaChallengeTokenService;
  roleAssignments: FakeRoleAssignmentService;
  orgSecurityPolicies: FakeOrgSecurityPolicyService;
  lockout: FakeLockoutService;
  ipCircuitBreaker: FakeIpCircuitBreakerService;
} {
  const hasher = args.hasher ?? new FakeHasher();
  const token = args.token ?? new FakeTokenService();
  const refresh = args.refresh ?? new FakeRefreshTokenService();
  const mfaChallenge = args.mfaChallenge ?? new FakeMfaChallengeTokenService();
  const roleAssignments = args.roleAssignments ?? new FakeRoleAssignmentService();
  const orgSecurityPolicies = args.orgSecurityPolicies ?? new FakeOrgSecurityPolicyService();
  const lockout = args.lockout ?? new FakeLockoutService();
  const ipCircuitBreaker = args.ipCircuitBreaker ?? new FakeIpCircuitBreakerService();
  const svc = new AuthService(
    args.prisma,
    hasher as unknown as PasswordHasherService,
    token as unknown as TokenService,
    refresh as unknown as RefreshTokenService,
    mfaChallenge as unknown as MfaChallengeTokenService,
    roleAssignments as unknown as RoleAssignmentService,
    orgSecurityPolicies as unknown as OrgSecurityPolicyService,
    lockout as unknown as LockoutService,
    ipCircuitBreaker as unknown as IpCircuitBreakerService,
    // TS-510 — signup's email-verification collaborator. The login path never
    // touches it, so an inert stand-in is honest here: a spy would imply the
    // login tests assert something about verification, which they do not.
    {} as unknown as import('./email-verification.service').EmailVerificationService,
  );
  return {
    svc,
    hasher,
    token,
    refresh,
    mfaChallenge,
    roleAssignments,
    orgSecurityPolicies,
    lockout,
    ipCircuitBreaker,
  };
}

describe('AuthService.login — happy path', () => {
  it('lower-cases the email before lookup, returns access token + refresh token', async () => {
    const captured: { email?: string | undefined } = {};
    const prisma = {
      user: {
        findUnique: vi.fn(async (req: { where: { email?: string } }) => {
          captured.email = req.where.email;
          return {
            id: 'u_1',
            email: 'alice@example.com',
            passwordHash: FAKE_DIGEST,
            status: 'active' as const,
            deletedAt: null,
          };
        }),
      },
    } as unknown as PrismaService;

    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const { svc, refresh, token } = buildSvc({ prisma, hasher });

    const result = await svc.login(validInput, { ip: '127.0.0.1', userAgent: 'unit-test' });

    expect(captured.email).toBe('alice@example.com');
    expect(result.outcome).toBe('session');
    if (result.outcome !== 'session') throw new Error('expected session outcome');
    expect(result.refreshToken).toBe('raw-refresh-token-abcdef');
    expect(result.refreshExpiresAt.toISOString()).toBe('2026-06-08T12:00:00.000Z');
    expect(result.response).toEqual({
      outcome: 'session',
      accessToken: 'signed.u_1.family_for_u_1.mfa=false.roles=',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { id: 'u_1', email: 'alice@example.com', status: 'active' },
    });
    expect(refresh.issueNewSession).toHaveBeenCalledWith({
      userId: 'u_1',
      ip: '127.0.0.1',
      userAgent: 'unit-test',
    });
    expect(token.signAccessToken).toHaveBeenCalledWith({
      userId: 'u_1',
      sessionId: 'family_for_u_1',
      mfaVerified: false,
      roles: [],
    });
  });

  it('omits ip/userAgent gracefully when context is empty', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_1',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: null,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const { svc, refresh } = buildSvc({ prisma, hasher });
    await svc.login(validInput);
    expect(refresh.issueNewSession).toHaveBeenCalledWith({
      userId: 'u_1',
      ip: undefined,
      userAgent: undefined,
    });
  });
});

describe('AuthService.login — failure modes (all return generic 401)', () => {
  it('throws UnauthorizedException with generic message on missing user', async () => {
    const prisma = buildPrismaWithUser(null);
    const { svc } = buildSvc({ prisma });

    try {
      await svc.login(validInput);
      throw new Error('expected UnauthorizedException');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      const body = (err as UnauthorizedException).getResponse() as Record<string, unknown>;
      expect(body['detail']).toBe('Invalid email or password.');
      // Must NOT echo "email", "user", or "found".
      const json = JSON.stringify(body);
      expect(json).not.toMatch(/not[- ]?found/i);
    }
  });

  it('still runs bcrypt verify on the user-not-found path (constant-cost decoy)', async () => {
    const prisma = buildPrismaWithUser(null);
    const hasher = new FakeHasher();
    const { svc } = buildSvc({ prisma, hasher });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(hasher.verify).toHaveBeenCalledTimes(1);
    // The decoy digest path uses the dummy bcrypt-shaped digest.
    expect(hasher.verify).toHaveBeenCalledWith(
      validInput.password,
      expect.stringMatching(/^\$2b\$12\$/),
    );
  });

  it('throws 401 on wrong password, never issues a session', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_1',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: null,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(false);

    const { svc, refresh } = buildSvc({ prisma, hasher });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(refresh.issueNewSession).not.toHaveBeenCalled();
  });

  it('throws 401 when the user is soft-deleted, even with a correct password', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_1',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const { svc } = buildSvc({ prisma, hasher });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([['pending_verification'], ['suspended'], ['deactivated']] as const)(
    'throws 401 when status is %s, even with a correct password',
    async (status) => {
      const prisma = buildPrismaWithUser({
        id: 'u_1',
        email: 'alice@example.com',
        passwordHash: FAKE_DIGEST,
        status,
        deletedAt: null,
      });
      const hasher = new FakeHasher();
      hasher.verify.mockResolvedValueOnce(true);

      const { svc, refresh } = buildSvc({ prisma, hasher });
      await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(refresh.issueNewSession).not.toHaveBeenCalled();
    },
  );

  it('failure body shape is RFC 7807-compatible (type, title, status, detail)', async () => {
    const prisma = buildPrismaWithUser(null);
    const { svc } = buildSvc({ prisma });
    try {
      await svc.login(validInput);
      throw new Error('expected UnauthorizedException');
    } catch (err) {
      const body = (err as UnauthorizedException).getResponse() as Record<string, unknown>;
      expect(body['type']).toBe('about:blank');
      expect(body['title']).toBe('Unauthorized');
      expect(body['status']).toBe(401);
      expect(body['detail']).toBe('Invalid email or password.');
    }
  });
});

describe('AuthService.login — MFA branch', () => {
  it('returns outcome=challenge with a challengeToken instead of a session when user.mfaEnabled is true', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_mfa',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: null,
      mfaEnabled: true,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const { svc, refresh, token, mfaChallenge } = buildSvc({ prisma, hasher });
    const result = await svc.login(validInput, { ip: '127.0.0.1', userAgent: 'unit-test' });

    expect(result.outcome).toBe('challenge');
    if (result.outcome !== 'challenge') throw new Error('expected challenge outcome');
    expect(result.response).toEqual({
      outcome: 'challenge',
      challengeToken: 'challenge.u_mfa',
      expiresIn: 300,
    });
    // No session and no access token are minted on the challenge branch.
    expect(refresh.issueNewSession).not.toHaveBeenCalled();
    expect(token.signAccessToken).not.toHaveBeenCalled();
    // Challenge service is invoked with the IP/UA context for audit.
    expect(mfaChallenge.issue).toHaveBeenCalledWith({
      userId: 'u_mfa',
      ip: '127.0.0.1',
      userAgent: 'unit-test',
    });
  });

  it('challenge response shape carries no user information (no enumeration)', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_mfa',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: null,
      mfaEnabled: true,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const { svc } = buildSvc({ prisma, hasher });
    const result = await svc.login(validInput);
    if (result.outcome !== 'challenge') throw new Error('expected challenge outcome');
    // No `user` field, no `accessToken`, no `refreshToken` field.
    expect(Object.keys(result.response).sort()).toEqual(['challengeToken', 'expiresIn', 'outcome']);
  });
});

describe('AuthService.login — RBAC propagation (TS-024)', () => {
  it('passes active role assignments into the access-token payload', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_rbac',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: null,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([
      {
        name: 'family_payer',
        scope: { type: 'global' as const },
        permissions: [],
      },
      {
        name: 'finance',
        scope: { type: 'global' as const },
        permissions: ['accounting:close_period', 'finance:adjust'],
        expiresAt: '2026-12-31T00:00:00.000Z',
      },
    ] as never);

    const { svc, token } = buildSvc({ prisma, hasher, roleAssignments });
    const result = await svc.login(validInput);

    expect(roleAssignments.getActiveAssignments).toHaveBeenCalledWith('u_rbac');
    expect(token.signAccessToken).toHaveBeenCalledWith({
      userId: 'u_rbac',
      sessionId: 'family_for_u_rbac',
      mfaVerified: false,
      roles: [
        {
          name: 'family_payer',
          scope: { type: 'global' },
          permissions: [],
        },
        {
          name: 'finance',
          scope: { type: 'global' },
          permissions: ['accounting:close_period', 'finance:adjust'],
          expiresAt: '2026-12-31T00:00:00.000Z',
        },
      ],
    });
    if (result.outcome !== 'session') throw new Error('expected session outcome');
    expect(result.response.accessToken).toBe(
      'signed.u_rbac.family_for_u_rbac.mfa=false.roles=family_payer,finance',
    );
  });

  it('still issues a session when the user holds zero active assignments', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_norole',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: null,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([] as never);

    const { svc, token } = buildSvc({ prisma, hasher, roleAssignments });
    const result = await svc.login(validInput);

    if (result.outcome !== 'session') throw new Error('expected session outcome');
    expect(token.signAccessToken).toHaveBeenCalledWith({
      userId: 'u_norole',
      sessionId: 'family_for_u_norole',
      mfaVerified: false,
      roles: [],
    });
  });
});

describe('AuthService.login — admin-MFA gate (TS-023-followup-1)', () => {
  // The login service lower-cases the request email before lookup, so
  // `validInput.email = 'Alice@Example.com'` becomes 'alice@example.com'
  // — both fixtures must use that exact value for the in-memory fake's
  // findUnique to match. The semantic role of the fixture (admin vs
  // non-admin) lives on the id and the holdsAnyRole mock, not the
  // email.
  const ADMIN_USER: FakeUser = {
    id: 'u_admin',
    email: 'alice@example.com',
    passwordHash: FAKE_DIGEST,
    status: 'active',
    deletedAt: null,
    mfaEnabled: false,
  };

  const NON_ADMIN_USER: FakeUser = {
    id: 'u_family',
    email: 'alice@example.com',
    passwordHash: FAKE_DIGEST,
    status: 'active',
    deletedAt: null,
    mfaEnabled: false,
  };

  it('refuses to issue a session for an admin-role-holding user without MFA enabled', async () => {
    const prisma = buildPrismaWithUser(ADMIN_USER);
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.holdsAnyRole.mockResolvedValueOnce(true);

    const { svc, refresh, token, mfaChallenge } = buildSvc({
      prisma,
      hasher,
      roleAssignments,
    });

    await expect(svc.login(validInput)).rejects.toBeInstanceOf(ForbiddenException);

    // Neither a session nor an MFA challenge is issued on the gated path.
    expect(refresh.issueNewSession).not.toHaveBeenCalled();
    expect(token.signAccessToken).not.toHaveBeenCalled();
    expect(mfaChallenge.issue).not.toHaveBeenCalled();
  });

  it('queries the admin role set against the authenticated user id', async () => {
    const prisma = buildPrismaWithUser(ADMIN_USER);
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.holdsAnyRole.mockResolvedValueOnce(true);

    const { svc } = buildSvc({ prisma, hasher, roleAssignments });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(ForbiddenException);

    expect(roleAssignments.holdsAnyRole).toHaveBeenCalledTimes(1);
    const [calledUserId, calledRoleNames] = roleAssignments.holdsAnyRole.mock.calls[0] as [
      string,
      readonly string[],
    ];
    expect(calledUserId).toBe(ADMIN_USER.id);
    // Sanity check: the gate must consult the admin staff role set.
    expect(calledRoleNames).toEqual(
      expect.arrayContaining([
        'super_admin',
        'operations_manager',
        'customer_support',
        'concierge_lead',
        'provider_ops',
        'finance',
        'marketing',
        'content_editor',
        'trust_safety',
        'read_only_auditor',
      ]),
    );
    expect(calledRoleNames).toHaveLength(10);
  });

  it('emits an RFC 7807-shaped 403 with an actionable detail (no role-name leak)', async () => {
    const prisma = buildPrismaWithUser(ADMIN_USER);
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.holdsAnyRole.mockResolvedValueOnce(true);

    const { svc } = buildSvc({ prisma, hasher, roleAssignments });
    try {
      await svc.login(validInput);
      throw new Error('expected ForbiddenException');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const body = (err as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(body['type']).toBe('about:blank');
      expect(body['title']).toBe('Forbidden');
      expect(body['status']).toBe(403);
      // Stable machine-readable discriminator (TS-296) — the login
      // UI branches on this, never on the detail text.
      expect(body['code']).toBe('mfa_enrollment_required');
      const detail = body['detail'] as string;
      expect(detail).toMatch(/multi-factor authentication/i);
      // Must not echo specific role names — defence against role
      // enumeration via login-side error messages.
      const json = JSON.stringify(body);
      expect(json).not.toMatch(/super_admin|finance|trust_safety/i);
    }
  });

  it('does not consult the admin role set when mfaEnabled is true (common-case fast path)', async () => {
    const prisma = buildPrismaWithUser({
      ...ADMIN_USER,
      mfaEnabled: true,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const roleAssignments = new FakeRoleAssignmentService();

    const { svc } = buildSvc({ prisma, hasher, roleAssignments });
    const result = await svc.login(validInput);

    expect(result.outcome).toBe('challenge');
    // mfaEnabled=true bypasses the gate — challenge is issued and
    // we never paid for the role lookup.
    expect(roleAssignments.holdsAnyRole).not.toHaveBeenCalled();
  });

  it('does not block a non-admin user without MFA — they sign in normally', async () => {
    const prisma = buildPrismaWithUser(NON_ADMIN_USER);
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.holdsAnyRole.mockResolvedValueOnce(false);

    const { svc, refresh } = buildSvc({ prisma, hasher, roleAssignments });
    const result = await svc.login(validInput);

    expect(result.outcome).toBe('session');
    expect(refresh.issueNewSession).toHaveBeenCalledTimes(1);
    expect(roleAssignments.holdsAnyRole).toHaveBeenCalledTimes(1);
  });

  it('runs AFTER credential validation — wrong password still surfaces 401, never 403', async () => {
    const prisma = buildPrismaWithUser(ADMIN_USER);
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(false); // wrong password

    const roleAssignments = new FakeRoleAssignmentService();
    // Even if we mocked this to true, the failure must short-circuit
    // before we ever consult the gate.
    roleAssignments.holdsAnyRole.mockResolvedValueOnce(true);

    const { svc } = buildSvc({ prisma, hasher, roleAssignments });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);

    // Gate must not have been consulted on the bad-password path —
    // calling it would be a small but real account-existence oracle.
    expect(roleAssignments.holdsAnyRole).not.toHaveBeenCalled();
  });
});

describe('AuthService.login — per-user lockout (TS-025)', () => {
  const KNOWN_USER: FakeUser = {
    id: 'u_lock',
    email: 'alice@example.com',
    passwordHash: FAKE_DIGEST,
    status: 'active',
    deletedAt: null,
    mfaEnabled: false,
  };

  it('records a failure on the bad-password branch (real user)', async () => {
    const prisma = buildPrismaWithUser(KNOWN_USER);
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(false); // wrong password
    const lockout = new FakeLockoutService();

    const { svc } = buildSvc({ prisma, hasher, lockout });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(lockout.recordFailure).toHaveBeenCalledTimes(1);
    expect(lockout.recordFailure).toHaveBeenCalledWith(KNOWN_USER.id);
    // recordSuccess MUST NOT fire on the bad-password path —
    // recording a clean login here would defeat the schedule.
    expect(lockout.recordSuccess).not.toHaveBeenCalled();
  });

  it('does NOT record a failure on the no-user branch', async () => {
    const prisma = buildPrismaWithUser(null);
    const lockout = new FakeLockoutService();

    const { svc } = buildSvc({ prisma, lockout });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);

    // No user row means there is no counter to increment. A typo'd
    // email must not be allowed to drain another user's lockout
    // budget — and there is no user id to increment against anyway.
    expect(lockout.recordFailure).not.toHaveBeenCalled();
    expect(lockout.recordSuccess).not.toHaveBeenCalled();
  });

  it('does NOT record a failure when the user is soft-deleted (no useful counter)', async () => {
    const prisma = buildPrismaWithUser({
      ...KNOWN_USER,
      deletedAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true); // correct password
    const lockout = new FakeLockoutService();

    const { svc } = buildSvc({ prisma, hasher, lockout });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(lockout.recordFailure).not.toHaveBeenCalled();
    expect(lockout.recordSuccess).not.toHaveBeenCalled();
  });

  it.each([['pending_verification'], ['suspended'], ['deactivated']] as const)(
    'does NOT record a failure on status=%s even with a correct password',
    async (status) => {
      const prisma = buildPrismaWithUser({
        ...KNOWN_USER,
        status,
      });
      const hasher = new FakeHasher();
      hasher.verify.mockResolvedValueOnce(true);
      const lockout = new FakeLockoutService();

      const { svc } = buildSvc({ prisma, hasher, lockout });
      await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);

      expect(lockout.recordFailure).not.toHaveBeenCalled();
      expect(lockout.recordSuccess).not.toHaveBeenCalled();
    },
  );

  it('returns a generic 401 when the user is currently locked, even with a correct password', async () => {
    const future = new Date(Date.now() + 60_000);
    const prisma = buildPrismaWithUser({
      ...KNOWN_USER,
      lockedUntil: future,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true); // correct password
    const lockout = new FakeLockoutService();
    lockout.isLocked.mockReturnValueOnce(true);

    const { svc, refresh, token } = buildSvc({ prisma, hasher, lockout });

    try {
      await svc.login(validInput);
      throw new Error('expected UnauthorizedException');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      const body = (err as UnauthorizedException).getResponse() as Record<string, unknown>;
      // SAME shape as the bad-password body — no lockout-state oracle.
      expect(body['detail']).toBe('Invalid email or password.');
      expect(body['status']).toBe(401);
    }

    // Neither a session nor a recordSuccess fires on the lockout
    // branch — the user is already locked and the schedule has
    // already done its work; an additional recordFailure would just
    // grow the lock for what we believe is a legitimate retry.
    expect(refresh.issueNewSession).not.toHaveBeenCalled();
    expect(token.signAccessToken).not.toHaveBeenCalled();
    expect(lockout.recordSuccess).not.toHaveBeenCalled();
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });

  it('does not consult isLocked on the bad-password branch (gate is creds-valid only)', async () => {
    const prisma = buildPrismaWithUser(KNOWN_USER);
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(false);
    const lockout = new FakeLockoutService();

    const { svc } = buildSvc({ prisma, hasher, lockout });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);

    // Lockout gate is gated on valid credentials — it would be a
    // tiny but real lockout-state oracle if a bad-password attempt
    // returned a different latency / branch for a locked vs.
    // unlocked account.
    expect(lockout.isLocked).not.toHaveBeenCalled();
  });

  it('clears the counter on a successful credential-validated login', async () => {
    const prisma = buildPrismaWithUser(KNOWN_USER);
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);
    const lockout = new FakeLockoutService();

    const { svc, refresh } = buildSvc({ prisma, hasher, lockout });
    const result = await svc.login(validInput);

    expect(result.outcome).toBe('session');
    expect(lockout.recordSuccess).toHaveBeenCalledTimes(1);
    expect(lockout.recordSuccess).toHaveBeenCalledWith(KNOWN_USER.id);
    expect(refresh.issueNewSession).toHaveBeenCalledTimes(1);
  });

  it('clears the counter even when the admin-MFA gate would later reject (creds-valid is the threshold)', async () => {
    const prisma = buildPrismaWithUser(KNOWN_USER);
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);
    const roleAssignments = new FakeRoleAssignmentService();
    // Admin role found → gate fires after lockout clearing.
    roleAssignments.holdsAnyRole.mockResolvedValueOnce(true);
    const lockout = new FakeLockoutService();

    const { svc } = buildSvc({ prisma, hasher, roleAssignments, lockout });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(ForbiddenException);

    // Counter is cleared because the user proved possession of the
    // password — the admin-MFA gate is a precondition for a session,
    // not an authentication failure.
    expect(lockout.recordSuccess).toHaveBeenCalledTimes(1);
    expect(lockout.recordSuccess).toHaveBeenCalledWith(KNOWN_USER.id);
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });

  it('clears the counter on the MFA-challenge branch too (creds-valid is the threshold)', async () => {
    const prisma = buildPrismaWithUser({
      ...KNOWN_USER,
      mfaEnabled: true,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);
    const lockout = new FakeLockoutService();

    const { svc } = buildSvc({ prisma, hasher, lockout });
    const result = await svc.login(validInput);

    expect(result.outcome).toBe('challenge');
    expect(lockout.recordSuccess).toHaveBeenCalledTimes(1);
    expect(lockout.recordSuccess).toHaveBeenCalledWith(KNOWN_USER.id);
  });

  it('passes the row-loaded lockedUntil into isLocked (not a re-fetched value)', async () => {
    const lockInstant = new Date('2026-05-10T13:00:00.000Z');
    const prisma = buildPrismaWithUser({
      ...KNOWN_USER,
      lockedUntil: lockInstant,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);
    const lockout = new FakeLockoutService();
    lockout.isLocked.mockReturnValueOnce(false); // pretend lock has elapsed

    const { svc } = buildSvc({ prisma, hasher, lockout });
    await svc.login(validInput);

    expect(lockout.isLocked).toHaveBeenCalledTimes(1);
    const [calledLock] = lockout.isLocked.mock.calls[0] as [Date | null];
    expect(calledLock?.toISOString()).toBe(lockInstant.toISOString());
  });
});

describe('AuthService.login — IP circuit breaker (TS-025-followup-1)', () => {
  it('returns generic 401 + does not query Prisma when the breaker is tripped', async () => {
    const prisma = {
      user: {
        findUnique: vi.fn(),
      },
    } as unknown as PrismaService;
    const hasher = new FakeHasher();
    const ipCircuitBreaker = new FakeIpCircuitBreakerService();
    ipCircuitBreaker.checkBlocked.mockResolvedValueOnce(true);

    const { svc, lockout, refresh } = buildSvc({ prisma, hasher, ipCircuitBreaker });

    try {
      await svc.login(validInput, { ip: '203.0.113.5', userAgent: 'unit-test' });
      throw new Error('expected UnauthorizedException');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      const body = (err as UnauthorizedException).getResponse() as Record<string, unknown>;
      // Body must be byte-identical to the bad-password 401 so the
      // tripped breaker is not enumerable.
      expect(body).toEqual({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid email or password.',
      });
    }

    // No DB read, no bcrypt cycles, no role lookup — the breaker
    // short-circuits the whole authentication path.
    expect(prisma.user.findUnique as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(hasher.verify).not.toHaveBeenCalled();
    expect(lockout.recordFailure).not.toHaveBeenCalled();
    expect(refresh.issueNewSession).not.toHaveBeenCalled();

    // Breaker was checked exactly once with the request IP. We
    // deliberately do NOT record an additional failure on the
    // blocked path — the breaker is already tripped, and double-
    // counting just keeps the lock open longer than the operator
    // configured window.
    expect(ipCircuitBreaker.checkBlocked).toHaveBeenCalledTimes(1);
    expect(ipCircuitBreaker.checkBlocked).toHaveBeenCalledWith('203.0.113.5');
    expect(ipCircuitBreaker.recordFailure).not.toHaveBeenCalled();
  });

  it('records an IP failure on the bad-password branch (alongside per-user lockout)', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_1',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: null,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(false);

    const { svc, lockout, ipCircuitBreaker } = buildSvc({ prisma, hasher });
    await expect(
      svc.login(validInput, { ip: '203.0.113.5', userAgent: 'unit-test' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Both layers fire: per-user lockout (account-scoped) and the
    // IP breaker (cross-account scoped).
    expect(lockout.recordFailure).toHaveBeenCalledWith('u_1');
    expect(ipCircuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
    expect(ipCircuitBreaker.recordFailure).toHaveBeenCalledWith('203.0.113.5');
  });

  it('records an IP failure on the no-user branch (per-user lockout deliberately skipped)', async () => {
    // The credential-stuffing scenario: an attacker probes many
    // unknown usernames from one IP. Each probe lands the no-user
    // branch. The per-user lockout has no userId to record against
    // and skips by design; the IP breaker still increments so the
    // attacker can't dodge the rate-limit by hitting unknown
    // accounts.
    const prisma = buildPrismaWithUser(null);
    const { svc, lockout, ipCircuitBreaker } = buildSvc({ prisma });
    await expect(
      svc.login(validInput, { ip: '203.0.113.5', userAgent: 'unit-test' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(lockout.recordFailure).not.toHaveBeenCalled();
    expect(ipCircuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
    expect(ipCircuitBreaker.recordFailure).toHaveBeenCalledWith('203.0.113.5');
  });

  it('records an IP failure on the soft-deleted branch', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_1',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const { svc, ipCircuitBreaker } = buildSvc({ prisma, hasher });
    await expect(
      svc.login(validInput, { ip: '203.0.113.5', userAgent: 'unit-test' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(ipCircuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
    expect(ipCircuitBreaker.recordFailure).toHaveBeenCalledWith('203.0.113.5');
  });

  it.each([['pending_verification'], ['suspended'], ['deactivated']] as const)(
    'records an IP failure on the inactive-status (%s) branch',
    async (status) => {
      const prisma = buildPrismaWithUser({
        id: 'u_1',
        email: 'alice@example.com',
        passwordHash: FAKE_DIGEST,
        status,
        deletedAt: null,
      });
      const hasher = new FakeHasher();
      hasher.verify.mockResolvedValueOnce(true);

      const { svc, ipCircuitBreaker } = buildSvc({ prisma, hasher });
      await expect(
        svc.login(validInput, { ip: '203.0.113.5', userAgent: 'unit-test' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(ipCircuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
      expect(ipCircuitBreaker.recordFailure).toHaveBeenCalledWith('203.0.113.5');
    },
  );

  it('does NOT record an IP failure on the happy path', async () => {
    const prisma = buildPrismaWithUser({
      id: 'u_1',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: null,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const { svc, ipCircuitBreaker } = buildSvc({ prisma, hasher });
    const result = await svc.login(validInput, { ip: '203.0.113.5', userAgent: 'unit-test' });

    expect(result.outcome).toBe('session');
    // checkBlocked DOES fire on every login (gate); recordFailure
    // must not fire when authentication succeeds.
    expect(ipCircuitBreaker.checkBlocked).toHaveBeenCalledTimes(1);
    expect(ipCircuitBreaker.recordFailure).not.toHaveBeenCalled();
  });

  it('checks the breaker before the user lookup (short-circuits Prisma read)', async () => {
    // Order-of-operations assertion — when the breaker trips, the
    // login flow must not touch Prisma. This is the latency win
    // documented in the service header: no bcrypt cycles, no DB
    // read, no role lookup on the blocked path.
    const findUnique = vi.fn();
    const prisma = { user: { findUnique } } as unknown as PrismaService;
    const ipCircuitBreaker = new FakeIpCircuitBreakerService();
    ipCircuitBreaker.checkBlocked.mockResolvedValueOnce(true);
    const { svc } = buildSvc({ prisma, ipCircuitBreaker });

    await expect(svc.login(validInput, { ip: '203.0.113.5' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('passes ip=undefined through to the breaker when context has no ip', async () => {
    // The breaker service treats undefined as a skip — its own unit
    // tests pin this — so the AuthService must forward the value
    // verbatim rather than substitute a string.
    const prisma = buildPrismaWithUser(null);
    const { svc, ipCircuitBreaker } = buildSvc({ prisma });
    await expect(svc.login(validInput)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(ipCircuitBreaker.checkBlocked).toHaveBeenCalledWith(undefined);
    expect(ipCircuitBreaker.recordFailure).toHaveBeenCalledWith(undefined);
  });
});

describe('AuthService — SSO enforcement gate (TS-296)', () => {
  // The gate lives in issueSessionFor — the single session-minting
  // choke point — so BOTH the password-only login path and the
  // MFA-verify path (MfaController → issueSessionFor) are covered.
  // These tests exercise issueSessionFor directly, exactly as the
  // MFA controller calls it after a completed challenge.
  const SESSION_ARGS = {
    userId: 'u_staff',
    email: 'alice@example.com',
    status: 'active' as const,
    mfaVerified: true,
    ssoAsserted: false,
  };

  function adminAssignment(name: string, scope: unknown): unknown {
    return { name, scope, permissions: [] };
  }

  it('refuses a session (403 sso_assertion_required) for a tenant-scoped admin whose org requires SSO', async () => {
    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([
      adminAssignment('operations_manager', { type: 'tenant', tenantId: 'tenant_abc' }),
    ] as never);
    const orgSecurityPolicies = new FakeOrgSecurityPolicyService();
    orgSecurityPolicies.ssoRequiredForScopes.mockResolvedValueOnce(true);

    const { svc, refresh, token } = buildSvc({
      prisma: buildPrismaWithUser(null),
      roleAssignments,
      orgSecurityPolicies,
    });

    try {
      await svc.issueSessionFor(SESSION_ARGS);
      throw new Error('expected ForbiddenException');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const body = (err as ForbiddenException).getResponse() as Record<string, unknown>;
      expect(body['status']).toBe(403);
      expect(body['code']).toBe('sso_assertion_required');
      // Hospitality tone, no scope-id / role-name leak.
      expect(JSON.stringify(body)).not.toMatch(/tenant_abc|operations_manager/);
    }

    // The policy was consulted with the assignment's tenant scope id.
    expect(orgSecurityPolicies.ssoRequiredForScopes).toHaveBeenCalledWith(['tenant_abc']);
    // No orphaned session family and no signed token on refusal.
    expect(refresh.issueNewSession).not.toHaveBeenCalled();
    expect(token.signAccessToken).not.toHaveBeenCalled();
  });

  it("maps a GLOBAL-scoped admin assignment onto the 'global' sentinel scope id", async () => {
    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([
      adminAssignment('super_admin', { type: 'global' }),
    ] as never);
    const orgSecurityPolicies = new FakeOrgSecurityPolicyService();
    orgSecurityPolicies.ssoRequiredForScopes.mockResolvedValueOnce(true);

    const { svc } = buildSvc({
      prisma: buildPrismaWithUser(null),
      roleAssignments,
      orgSecurityPolicies,
    });

    await expect(svc.issueSessionFor(SESSION_ARGS)).rejects.toBeInstanceOf(ForbiddenException);
    expect(orgSecurityPolicies.ssoRequiredForScopes).toHaveBeenCalledWith(['global']);
  });

  it('issues the session when the org policy does not require SSO', async () => {
    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([
      adminAssignment('finance', { type: 'global' }),
    ] as never);
    const orgSecurityPolicies = new FakeOrgSecurityPolicyService();
    orgSecurityPolicies.ssoRequiredForScopes.mockResolvedValueOnce(false);

    const { svc, refresh } = buildSvc({
      prisma: buildPrismaWithUser(null),
      roleAssignments,
      orgSecurityPolicies,
    });

    const result = await svc.issueSessionFor(SESSION_ARGS);
    expect(result.outcome).toBe('session');
    expect(refresh.issueNewSession).toHaveBeenCalledTimes(1);
  });

  it('skips the policy lookup entirely for non-admin users (common path pays nothing)', async () => {
    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([
      adminAssignment('family_payer', { type: 'household', householdId: 'hh_1' }),
      adminAssignment('custom_partner_role', { type: 'tenant', tenantId: 'tenant_abc' }),
    ] as never);
    const orgSecurityPolicies = new FakeOrgSecurityPolicyService();

    const { svc } = buildSvc({
      prisma: buildPrismaWithUser(null),
      roleAssignments,
      orgSecurityPolicies,
    });

    const result = await svc.issueSessionFor(SESSION_ARGS);
    expect(result.outcome).toBe('session');
    // Neither system-customer roles nor custom (non-staff) roles
    // trigger the lookup — same classification rule as the MFA gate.
    expect(orgSecurityPolicies.ssoRequiredForScopes).not.toHaveBeenCalled();
  });

  it('honours ssoAsserted: true — the seam the SSO provider integration will satisfy', async () => {
    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([
      adminAssignment('operations_manager', { type: 'tenant', tenantId: 'tenant_abc' }),
    ] as never);
    const orgSecurityPolicies = new FakeOrgSecurityPolicyService();
    orgSecurityPolicies.ssoRequiredForScopes.mockResolvedValueOnce(true);

    const { svc, refresh } = buildSvc({
      prisma: buildPrismaWithUser(null),
      roleAssignments,
      orgSecurityPolicies,
    });

    const result = await svc.issueSessionFor({ ...SESSION_ARGS, ssoAsserted: true });
    expect(result.outcome).toBe('session');
    expect(refresh.issueNewSession).toHaveBeenCalledTimes(1);
    expect(orgSecurityPolicies.ssoRequiredForScopes).not.toHaveBeenCalled();
  });

  it('gates the password-only login path through the same choke point (no MFA-verify bypass twin)', async () => {
    // A user who reaches the session branch of login() (mfaEnabled
    // false, MFA gate mocked open) with an SSO-required admin
    // assignment must still be refused — proving login() cannot
    // reach a session without passing the issueSessionFor gate.
    const prisma = buildPrismaWithUser({
      id: 'u_staff',
      email: 'alice@example.com',
      passwordHash: FAKE_DIGEST,
      status: 'active',
      deletedAt: null,
      mfaEnabled: false,
    });
    const hasher = new FakeHasher();
    hasher.verify.mockResolvedValueOnce(true);

    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.holdsAnyRole.mockResolvedValueOnce(false); // MFA gate open (unit isolation)
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([
      adminAssignment('trust_safety', { type: 'global' }),
    ] as never);
    const orgSecurityPolicies = new FakeOrgSecurityPolicyService();
    orgSecurityPolicies.ssoRequiredForScopes.mockResolvedValueOnce(true);

    const { svc, refresh } = buildSvc({ prisma, hasher, roleAssignments, orgSecurityPolicies });

    await expect(svc.login(validInput)).rejects.toBeInstanceOf(ForbiddenException);
    expect(refresh.issueNewSession).not.toHaveBeenCalled();
  });
});

describe('AuthService.issueSessionFor — impersonation mint (TS-297)', () => {
  const IMPERSONATION_ARGS = {
    userId: 'u_member',
    email: 'member@example.com',
    status: 'active' as const,
    mfaVerified: true,
    ssoAsserted: false,
    impersonation: {
      operatorUserId: 'u_operator',
      sessionExpiresAt: new Date('2026-07-02T13:00:00.000Z'),
    },
  };

  it('threads the operator into the token claim and the session row, capped at the impersonation expiry', async () => {
    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([
      { name: 'family_payer', scope: { type: 'household', householdId: 'hh_1' }, permissions: [] },
    ] as never);

    const { svc, refresh, token } = buildSvc({
      prisma: buildPrismaWithUser(null),
      roleAssignments,
    });

    const result = await svc.issueSessionFor(IMPERSONATION_ARGS);

    expect(result.outcome).toBe('session');
    expect(result.sessionFamilyId).toBe('family_for_u_member');
    const sessionArgs = refresh.issueNewSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sessionArgs['impersonatorUserId']).toBe('u_operator');
    expect(sessionArgs['expiresAt']).toEqual(new Date('2026-07-02T13:00:00.000Z'));
    const tokenArgs = token.signAccessToken.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(tokenArgs['actorOnBehalfOf']).toBe('u_operator');
    expect(tokenArgs['userId']).toBe('u_member');
  });

  it('never trips the SSO gate: impersonation targets hold no admin-staff role, so the policy is not consulted even when one exists', async () => {
    // A live ssoRequired policy exists (would refuse an admin-staff
    // login) — but the target's roles are all non-staff, so the gate's
    // scope set is empty and the lookup is skipped. Admin-staff targets
    // are refused upstream by AdminImpersonationService, which is what
    // makes this invariant total.
    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([
      { name: 'family_payer', scope: { type: 'household', householdId: 'hh_1' }, permissions: [] },
      { name: 'senior_member', scope: { type: 'tenant', tenantId: 'tenant_abc' }, permissions: [] },
    ] as never);
    const orgSecurityPolicies = new FakeOrgSecurityPolicyService();
    orgSecurityPolicies.ssoRequiredForScopes.mockResolvedValue(true);

    const { svc, refresh } = buildSvc({
      prisma: buildPrismaWithUser(null),
      roleAssignments,
      orgSecurityPolicies,
    });

    const result = await svc.issueSessionFor(IMPERSONATION_ARGS);

    expect(result.outcome).toBe('session');
    expect(orgSecurityPolicies.ssoRequiredForScopes).not.toHaveBeenCalled();
    expect(refresh.issueNewSession).toHaveBeenCalledTimes(1);
  });

  it('ordinary sessions carry no impersonation marker', async () => {
    const roleAssignments = new FakeRoleAssignmentService();
    roleAssignments.getActiveAssignments.mockResolvedValueOnce([] as never);

    const { svc, refresh, token } = buildSvc({
      prisma: buildPrismaWithUser(null),
      roleAssignments,
    });

    await svc.issueSessionFor({
      userId: 'u_member',
      email: 'member@example.com',
      status: 'active',
      mfaVerified: false,
      ssoAsserted: false,
    });

    const sessionArgs = refresh.issueNewSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sessionArgs['impersonatorUserId']).toBeUndefined();
    expect(sessionArgs['expiresAt']).toBeUndefined();
    const tokenArgs = token.signAccessToken.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(tokenArgs['actorOnBehalfOf']).toBeUndefined();
  });
});
