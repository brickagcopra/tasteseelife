import { ConflictException } from '@nestjs/common';
import type { SignupRequest } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordHasherService } from './password-hasher.service';

/**
 * Build a `PrismaService`-shaped fake exposing only the surface the
 * AuthService actually uses (`prisma.$transaction` wrapping
 * `prisma.user.create`). Strict typing on the fake ensures any future
 * widening of the AuthService's Prisma surface forces the test author to
 * extend this stub deliberately.
 *
 * TS-510 made signup transactional: the email-verification token and its
 * delivery event are appended alongside the user row, so a rolled-back signup
 * leaves nothing behind. The fake's `$transaction` therefore hands the same
 * fake back as the transaction client — enough to prove the ordering the
 * service depends on, and the real interactive-transaction semantics are
 * covered by the integration suite and by the TS-505 E2E fleet.
 */
type FakePrisma = Pick<PrismaService, 'user' | '$transaction'>;

interface CreatedRow {
  readonly id: string;
  readonly email: string;
  readonly phone: string | null;
  readonly status: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
  readonly createdAt: Date;
}

function buildFakePrisma(args: {
  onCreate: (data: {
    email: string;
    phone: string | null;
    passwordHash: string;
  }) => CreatedRow | Promise<never>;
}): FakePrisma {
  const fake: FakePrisma = {
    user: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: vi.fn(async (req: any) => args.onCreate(req.data)),
      // The remainder of `prisma.user` is unused by AuthService and
      // deliberately not stubbed — accessing any other method in tests
      // is a defect the type system should surface.
    } as unknown as PrismaService['user'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (fn: any) => fn(fake)) as unknown as PrismaService['$transaction'],
  };
  return fake;
}

/**
 * Records that signup minted a verification token, and with which user.
 *
 * A spy rather than `{}`: minting is not incidental to signup. Without it the
 * account is created in `pending_verification` with no way to ever reach
 * `active`, which is exactly the state TS-510 exists to make unreachable.
 */
class FakeEmailVerification {
  readonly issued: { readonly id: string; readonly email: string }[] = [];
  issueForSignup = vi.fn(
    async (_tx: unknown, user: { readonly id: string; readonly email: string }): Promise<void> => {
      this.issued.push(user);
    },
  );
}

/** A bcrypt-shaped stub digest. Format `$2b$12$<22-salt><31-hash>`. */
const FAKE_DIGEST = `$2b$12$${'a'.repeat(22)}${'b'.repeat(31)}`;

class FakeHasher {
  hash = vi.fn(async (_plaintext: string): Promise<string> => FAKE_DIGEST);
  verify = vi.fn(async (): Promise<boolean> => true);
  inspectCost = vi.fn((): number | null => 12);
}

const validInput: SignupRequest = {
  email: 'Alice@Example.com',
  phone: '+14155551212',
  password: 'correct horse battery staple',
};

describe('AuthService.signup', () => {
  it('lower-cases the email before persistence', async () => {
    const captured: { email?: string } = {};
    const prisma = buildFakePrisma({
      onCreate: (data) => {
        captured.email = data.email;
        return {
          id: 'cuid_alice',
          email: data.email,
          phone: data.phone,
          status: 'pending_verification',
          createdAt: new Date('2026-05-09T12:00:00.000Z'),
        };
      },
    });

    const hasher = new FakeHasher();
    const svc = new AuthService(
      prisma as unknown as PrismaService,
      hasher as unknown as PasswordHasherService,
      {} as unknown as import('./token.service').TokenService,
      {} as unknown as import('./refresh-token.service').RefreshTokenService,
      {} as unknown as import('./mfa-challenge-token.service').MfaChallengeTokenService,
      {} as unknown as import('../../rbac/role-assignment.service').RoleAssignmentService,
      {} as unknown as import('../../rbac/org-security-policy.service').OrgSecurityPolicyService,
      {} as unknown as import('./lockout.service').LockoutService,
      {} as unknown as import('./ip-circuit-breaker.service').IpCircuitBreakerService,
      new FakeEmailVerification() as unknown as import('./email-verification.service').EmailVerificationService,
    );

    const result = await svc.signup(validInput);

    expect(captured.email).toBe('alice@example.com');
    expect(result.email).toBe('alice@example.com');
    expect(hasher.hash).toHaveBeenCalledWith(validInput.password);
  });

  it('persists the bcrypt digest, never the plaintext password', async () => {
    const captured: { passwordHash?: string } = {};
    const prisma = buildFakePrisma({
      onCreate: (data) => {
        captured.passwordHash = data.passwordHash;
        return {
          id: 'cuid_alice',
          email: data.email,
          phone: data.phone,
          status: 'pending_verification',
          createdAt: new Date('2026-05-09T12:00:00.000Z'),
        };
      },
    });

    const hasher = new FakeHasher();
    const svc = new AuthService(
      prisma as unknown as PrismaService,
      hasher as unknown as PasswordHasherService,
      {} as unknown as import('./token.service').TokenService,
      {} as unknown as import('./refresh-token.service').RefreshTokenService,
      {} as unknown as import('./mfa-challenge-token.service').MfaChallengeTokenService,
      {} as unknown as import('../../rbac/role-assignment.service').RoleAssignmentService,
      {} as unknown as import('../../rbac/org-security-policy.service').OrgSecurityPolicyService,
      {} as unknown as import('./lockout.service').LockoutService,
      {} as unknown as import('./ip-circuit-breaker.service').IpCircuitBreakerService,
      new FakeEmailVerification() as unknown as import('./email-verification.service').EmailVerificationService,
    );

    await svc.signup(validInput);

    expect(captured.passwordHash).toBe(FAKE_DIGEST);
    expect(captured.passwordHash).not.toBe(validInput.password);
  });

  it('returns the mapped DTO with status=pending_verification and ISO createdAt', async () => {
    const prisma = buildFakePrisma({
      onCreate: (data) => ({
        id: 'cuid_alice',
        email: data.email,
        phone: data.phone,
        status: 'pending_verification',
        createdAt: new Date('2026-05-09T12:00:00.000Z'),
      }),
    });

    const hasher = new FakeHasher();
    const svc = new AuthService(
      prisma as unknown as PrismaService,
      hasher as unknown as PasswordHasherService,
      {} as unknown as import('./token.service').TokenService,
      {} as unknown as import('./refresh-token.service').RefreshTokenService,
      {} as unknown as import('./mfa-challenge-token.service').MfaChallengeTokenService,
      {} as unknown as import('../../rbac/role-assignment.service').RoleAssignmentService,
      {} as unknown as import('../../rbac/org-security-policy.service').OrgSecurityPolicyService,
      {} as unknown as import('./lockout.service').LockoutService,
      {} as unknown as import('./ip-circuit-breaker.service').IpCircuitBreakerService,
      new FakeEmailVerification() as unknown as import('./email-verification.service').EmailVerificationService,
    );

    const result = await svc.signup(validInput);

    expect(result).toEqual({
      id: 'cuid_alice',
      email: 'alice@example.com',
      phone: '+14155551212',
      status: 'pending_verification',
      createdAt: '2026-05-09T12:00:00.000Z',
    });
  });

  it('passes phone through as null when omitted from the request', async () => {
    const captured: { phone?: string | null } = {};
    const prisma = buildFakePrisma({
      onCreate: (data) => {
        captured.phone = data.phone;
        return {
          id: 'cuid_alice',
          email: data.email,
          phone: data.phone,
          status: 'pending_verification',
          createdAt: new Date('2026-05-09T12:00:00.000Z'),
        };
      },
    });

    const hasher = new FakeHasher();
    const svc = new AuthService(
      prisma as unknown as PrismaService,
      hasher as unknown as PasswordHasherService,
      {} as unknown as import('./token.service').TokenService,
      {} as unknown as import('./refresh-token.service').RefreshTokenService,
      {} as unknown as import('./mfa-challenge-token.service').MfaChallengeTokenService,
      {} as unknown as import('../../rbac/role-assignment.service').RoleAssignmentService,
      {} as unknown as import('../../rbac/org-security-policy.service').OrgSecurityPolicyService,
      {} as unknown as import('./lockout.service').LockoutService,
      {} as unknown as import('./ip-circuit-breaker.service').IpCircuitBreakerService,
      new FakeEmailVerification() as unknown as import('./email-verification.service').EmailVerificationService,
    );

    const { phone, ...inputNoPhone } = validInput;
    void phone;
    await svc.signup(inputNoPhone);

    expect(captured.phone).toBeNull();
  });

  it('throws 409 ConflictException on Prisma P2002 unique violation', async () => {
    const prismaError = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['email'] },
    });
    const prisma = buildFakePrisma({
      onCreate: () => {
        throw prismaError;
      },
    });

    const hasher = new FakeHasher();
    const svc = new AuthService(
      prisma as unknown as PrismaService,
      hasher as unknown as PasswordHasherService,
      {} as unknown as import('./token.service').TokenService,
      {} as unknown as import('./refresh-token.service').RefreshTokenService,
      {} as unknown as import('./mfa-challenge-token.service').MfaChallengeTokenService,
      {} as unknown as import('../../rbac/role-assignment.service').RoleAssignmentService,
      {} as unknown as import('../../rbac/org-security-policy.service').OrgSecurityPolicyService,
      {} as unknown as import('./lockout.service').LockoutService,
      {} as unknown as import('./ip-circuit-breaker.service').IpCircuitBreakerService,
      new FakeEmailVerification() as unknown as import('./email-verification.service').EmailVerificationService,
    );

    await expect(svc.signup(validInput)).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns a generic conflict message (no account-enumeration leakage)', async () => {
    const prismaError = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['email'] },
    });
    const prisma = buildFakePrisma({
      onCreate: () => {
        throw prismaError;
      },
    });

    const hasher = new FakeHasher();
    const svc = new AuthService(
      prisma as unknown as PrismaService,
      hasher as unknown as PasswordHasherService,
      {} as unknown as import('./token.service').TokenService,
      {} as unknown as import('./refresh-token.service').RefreshTokenService,
      {} as unknown as import('./mfa-challenge-token.service').MfaChallengeTokenService,
      {} as unknown as import('../../rbac/role-assignment.service').RoleAssignmentService,
      {} as unknown as import('../../rbac/org-security-policy.service').OrgSecurityPolicyService,
      {} as unknown as import('./lockout.service').LockoutService,
      {} as unknown as import('./ip-circuit-breaker.service').IpCircuitBreakerService,
      new FakeEmailVerification() as unknown as import('./email-verification.service').EmailVerificationService,
    );

    try {
      await svc.signup(validInput);
      throw new Error('expected ConflictException');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      const body = (err as ConflictException).getResponse() as Record<string, unknown>;
      expect(body['detail']).toBe('An account with the supplied identifier already exists.');
      // Specifically must NOT echo "email" or "phone".
      expect(JSON.stringify(body)).not.toMatch(/email/i);
      expect(JSON.stringify(body)).not.toMatch(/phone/i);
    }
  });

  it('rethrows non-P2002 Prisma errors unchanged', async () => {
    const prismaError = Object.assign(new Error('Connection refused'), { code: 'P1001' });
    const prisma = buildFakePrisma({
      onCreate: () => {
        throw prismaError;
      },
    });

    const hasher = new FakeHasher();
    const svc = new AuthService(
      prisma as unknown as PrismaService,
      hasher as unknown as PasswordHasherService,
      {} as unknown as import('./token.service').TokenService,
      {} as unknown as import('./refresh-token.service').RefreshTokenService,
      {} as unknown as import('./mfa-challenge-token.service').MfaChallengeTokenService,
      {} as unknown as import('../../rbac/role-assignment.service').RoleAssignmentService,
      {} as unknown as import('../../rbac/org-security-policy.service').OrgSecurityPolicyService,
      {} as unknown as import('./lockout.service').LockoutService,
      {} as unknown as import('./ip-circuit-breaker.service').IpCircuitBreakerService,
      new FakeEmailVerification() as unknown as import('./email-verification.service').EmailVerificationService,
    );

    await expect(svc.signup(validInput)).rejects.toBe(prismaError);
  });
});
