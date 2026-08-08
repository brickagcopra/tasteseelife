import 'reflect-metadata';

import { UnauthorizedException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuthService } from '../services/auth.service';
import type { MfaChallengeTokenService } from '../services/mfa-challenge-token.service';
import type { MfaService } from '../services/mfa.service';
import { MfaController } from './mfa.controller';

/**
 * Controller-level wiring tests for `MfaController`.
 *
 * The verify endpoint is a pre-auth surface: the user holds only a
 * short-lived MFA challenge token, NOT an access token, so no
 * `requestContext` exists when the handler runs. Without an explicit
 * exempt wrap, every Prisma operation downstream of `verify` would
 * trigger a warn-level audit line from the tenant-scope Prisma
 * extension (Phase 1 default: `enforcement: 'audit'`).
 *
 * The tests below pin the wrap contract by passing a real
 * `TenantContextStore` and fake collaborators that capture
 * `store.current()` at call time. The captured frame must be
 * `{ kind: 'exempt', reason: 'pre-auth-mfa-verify' }` — the precise
 * reason string the audit log will surface, so a future log scan can
 * trace every "no-context" Prisma access in the MFA-verify flow back
 * to its source.
 *
 * The captured frame also acts as the implicit assertion that each
 * collaborator is invoked INSIDE the wrap's lexical scope. A
 * regression that pulled a Prisma call (or a service hop) outside the
 * wrap would surface here as `frame === null`.
 *
 * The four authenticated endpoints (enroll / confirm / list / remove)
 * run AFTER `AccessTokenGuard`, so the `TenantContextInterceptor`
 * seeds a scoped frame before they execute — they don't need wrapping
 * and the tests in this file deliberately do not cover them. Deeper
 * behavioural coverage of those endpoints lives in
 * `mfa.integration.test.ts`.
 */
describe('MfaController tenant-scope exempt wrap (TS-020-followup-2a2)', () => {
  function buildEnv(): Env {
    return {
      REFRESH_COOKIE_SECURE: false,
      JWT_REFRESH_TTL_SECONDS: 60 * 60 * 24 * 30,
    } as unknown as Env;
  }

  function buildRequest(): Request {
    return {
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
  }

  function buildResponse(): Response {
    return {
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as Response;
  }

  function buildController(opts: {
    mfa?: Partial<MfaService>;
    mfaChallenge?: Partial<MfaChallengeTokenService>;
    auth?: Partial<AuthService>;
    prisma?: Partial<PrismaService>;
    store: TenantContextStore;
  }): MfaController {
    return new MfaController(
      (opts.mfa ?? {}) as unknown as MfaService,
      (opts.mfaChallenge ?? {}) as unknown as MfaChallengeTokenService,
      (opts.auth ?? {}) as unknown as AuthService,
      (opts.prisma ?? {}) as unknown as PrismaService,
      buildEnv(),
      opts.store,
    );
  }

  // ─── happy path ───────────────────────────────────────────────

  it('runs verify inside an exempt frame with reason "pre-auth-mfa-verify"', async () => {
    const store = new TenantContextStore();
    let capturedAtChallenge: TenantContextFrame | null = null;
    let capturedAtVerify: TenantContextFrame | null = null;
    let capturedAtUserLookup: TenantContextFrame | null = null;
    let capturedAtIssueSession: TenantContextFrame | null = null;

    const consumeMock = vi.fn(async () => {
      capturedAtChallenge = store.current();
      return { ok: true as const, userId: 'cuid_u1' };
    });
    const verifyForChallengeMock = vi.fn(async () => {
      capturedAtVerify = store.current();
      return true;
    });
    const findUniqueMock = vi.fn(async () => {
      capturedAtUserLookup = store.current();
      return {
        id: 'cuid_u1',
        email: 'alice@example.com',
        status: 'active' as const,
        deletedAt: null,
      };
    });
    const issueSessionForMock = vi.fn(async () => {
      capturedAtIssueSession = store.current();
      return {
        outcome: 'session' as const,
        refreshToken: 'raw_refresh_value',
        refreshExpiresAt: new Date('2026-06-20T12:00:00.000Z'),
        sessionFamilyId: 'fam_mock',
        response: {
          outcome: 'session' as const,
          accessToken: 'access_token',
          tokenType: 'Bearer' as const,
          expiresIn: 900,
          user: {
            id: 'cuid_u1',
            email: 'alice@example.com',
            status: 'active' as const,
          },
        },
      };
    });

    const controller = buildController({
      store,
      mfaChallenge: { consume: consumeMock },
      mfa: { verifyForChallenge: verifyForChallengeMock },
      auth: { issueSessionFor: issueSessionForMock },
      prisma: { user: { findUnique: findUniqueMock } } as unknown as Partial<PrismaService>,
    });

    const response = buildResponse();
    await controller.verify(
      { challengeToken: 'challenge.jwt.value', code: '123456' },
      buildRequest(),
      response,
    );

    // Every collaborator was invoked inside the exempt frame.
    const expected: TenantContextFrame = { kind: 'exempt', reason: 'pre-auth-mfa-verify' };
    expect(capturedAtChallenge).toEqual(expected);
    expect(capturedAtVerify).toEqual(expected);
    expect(capturedAtUserLookup).toEqual(expected);
    expect(capturedAtIssueSession).toEqual(expected);

    // Cookie is written inside the wrap, so cookie() was called once.
    expect(response.cookie).toHaveBeenCalledTimes(1);
  });

  // ─── failure branches ─────────────────────────────────────────

  it('runs verify inside an exempt frame when the challenge token is invalid (401)', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const consumeMock = vi.fn(async () => {
      captured = store.current();
      return { ok: false as const, reason: 'invalid-signature' as const };
    });
    const verifyForChallengeMock = vi.fn();
    const findUniqueMock = vi.fn();
    const issueSessionForMock = vi.fn();

    const controller = buildController({
      store,
      mfaChallenge: { consume: consumeMock },
      mfa: { verifyForChallenge: verifyForChallengeMock },
      auth: { issueSessionFor: issueSessionForMock },
      prisma: { user: { findUnique: findUniqueMock } } as unknown as Partial<PrismaService>,
    });

    await expect(
      controller.verify(
        { challengeToken: 'bad.jwt', code: '123456' },
        buildRequest(),
        buildResponse(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-mfa-verify' });
    // Short-circuit: no downstream calls fire on a rejected challenge.
    expect(verifyForChallengeMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(issueSessionForMock).not.toHaveBeenCalled();
  });

  it('runs verify inside an exempt frame when the TOTP code is invalid (401)', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const consumeMock = vi.fn(async () => ({ ok: true as const, userId: 'cuid_u1' }));
    const verifyForChallengeMock = vi.fn(async () => {
      captured = store.current();
      return false;
    });
    const findUniqueMock = vi.fn();
    const issueSessionForMock = vi.fn();

    const controller = buildController({
      store,
      mfaChallenge: { consume: consumeMock },
      mfa: { verifyForChallenge: verifyForChallengeMock },
      auth: { issueSessionFor: issueSessionForMock },
      prisma: { user: { findUnique: findUniqueMock } } as unknown as Partial<PrismaService>,
    });

    await expect(
      controller.verify(
        { challengeToken: 'good.jwt', code: '000000' },
        buildRequest(),
        buildResponse(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-mfa-verify' });
    // Short-circuit: no user lookup or session issuance on bad code.
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(issueSessionForMock).not.toHaveBeenCalled();
  });

  it('runs verify inside an exempt frame when the user is gone / inactive (401)', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const consumeMock = vi.fn(async () => ({ ok: true as const, userId: 'cuid_u1' }));
    const verifyForChallengeMock = vi.fn(async () => true);
    const findUniqueMock = vi.fn(async () => {
      captured = store.current();
      // Race scenario: user soft-deleted between login and verify.
      return {
        id: 'cuid_u1',
        email: 'alice@example.com',
        status: 'active' as const,
        deletedAt: new Date('2026-05-19T08:00:00.000Z'),
      };
    });
    const issueSessionForMock = vi.fn();

    const controller = buildController({
      store,
      mfaChallenge: { consume: consumeMock },
      mfa: { verifyForChallenge: verifyForChallengeMock },
      auth: { issueSessionFor: issueSessionForMock },
      prisma: { user: { findUnique: findUniqueMock } } as unknown as Partial<PrismaService>,
    });

    await expect(
      controller.verify(
        { challengeToken: 'good.jwt', code: '123456' },
        buildRequest(),
        buildResponse(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-mfa-verify' });
    // Session never issued for a soft-deleted user.
    expect(issueSessionForMock).not.toHaveBeenCalled();
  });

  // ─── no-leak invariant ────────────────────────────────────────

  it('does NOT leak the exempt frame after the verify handler returns (happy path)', async () => {
    const store = new TenantContextStore();
    const controller = buildController({
      store,
      mfaChallenge: {
        consume: vi.fn(async () => ({ ok: true as const, userId: 'cuid_u1' })),
      },
      mfa: { verifyForChallenge: vi.fn(async () => true) },
      auth: {
        issueSessionFor: vi.fn(async () => ({
          outcome: 'session' as const,
          refreshToken: 'raw_refresh_value',
          refreshExpiresAt: new Date('2026-06-20T12:00:00.000Z'),
          sessionFamilyId: 'fam_mock',
          response: {
            outcome: 'session' as const,
            accessToken: 'access_token',
            tokenType: 'Bearer' as const,
            expiresIn: 900,
            user: {
              id: 'cuid_u1',
              email: 'alice@example.com',
              status: 'active' as const,
            },
          },
        })),
      },
      prisma: {
        user: {
          findUnique: vi.fn(async () => ({
            id: 'cuid_u1',
            email: 'alice@example.com',
            status: 'active' as const,
            deletedAt: null,
          })),
        },
      } as unknown as Partial<PrismaService>,
    });

    expect(store.current()).toBeNull();
    await controller.verify(
      { challengeToken: 'good.jwt', code: '123456' },
      buildRequest(),
      buildResponse(),
    );
    expect(store.current()).toBeNull();
  });

  it('does NOT leak the exempt frame after the verify handler returns (401 path)', async () => {
    const store = new TenantContextStore();
    const controller = buildController({
      store,
      mfaChallenge: {
        consume: vi.fn(async () => ({
          ok: false as const,
          reason: 'expired' as const,
        })),
      },
    });

    expect(store.current()).toBeNull();
    await expect(
      controller.verify(
        { challengeToken: 'expired.jwt', code: '123456' },
        buildRequest(),
        buildResponse(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.current()).toBeNull();
  });
});

/**
 * Recovery-verify endpoint (TS-023-followup-2). Mirrors the `verify`
 * wrap contract — the only differences are the reason string
 * (`pre-auth-mfa-recovery-verify`) and that the second-factor check
 * routes through `MfaService.verifyRecoveryCode` (consuming a one-time
 * code) instead of `verifyForChallenge` (a TOTP code).
 */
describe('MfaController recovery-verify exempt wrap (TS-023-followup-2)', () => {
  function buildEnv(): Env {
    return {
      REFRESH_COOKIE_SECURE: false,
      JWT_REFRESH_TTL_SECONDS: 60 * 60 * 24 * 30,
    } as unknown as Env;
  }

  function buildRequest(): Request {
    return {
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
  }

  function buildResponse(): Response {
    return { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response;
  }

  function buildController(opts: {
    mfa?: Partial<MfaService>;
    mfaChallenge?: Partial<MfaChallengeTokenService>;
    auth?: Partial<AuthService>;
    prisma?: Partial<PrismaService>;
    store: TenantContextStore;
  }): MfaController {
    return new MfaController(
      (opts.mfa ?? {}) as unknown as MfaService,
      (opts.mfaChallenge ?? {}) as unknown as MfaChallengeTokenService,
      (opts.auth ?? {}) as unknown as AuthService,
      (opts.prisma ?? {}) as unknown as PrismaService,
      buildEnv(),
      opts.store,
    );
  }

  const EXEMPT: TenantContextFrame = {
    kind: 'exempt',
    reason: 'pre-auth-mfa-recovery-verify',
  };

  it('runs recovery-verify inside the exempt frame and issues a session on success', async () => {
    const store = new TenantContextStore();
    let capturedAtChallenge: TenantContextFrame | null = null;
    let capturedAtRecovery: TenantContextFrame | null = null;
    let capturedAtUserLookup: TenantContextFrame | null = null;

    const consumeMock = vi.fn(async () => {
      capturedAtChallenge = store.current();
      return { ok: true as const, userId: 'cuid_u1' };
    });
    const verifyRecoveryCodeMock = vi.fn(async () => {
      capturedAtRecovery = store.current();
      return true;
    });
    const findUniqueMock = vi.fn(async () => {
      capturedAtUserLookup = store.current();
      return {
        id: 'cuid_u1',
        email: 'alice@example.com',
        status: 'active' as const,
        deletedAt: null,
      };
    });
    const issueSessionForMock = vi.fn(async () => ({
      outcome: 'session' as const,
      refreshToken: 'raw_refresh_value',
      refreshExpiresAt: new Date('2026-06-20T12:00:00.000Z'),
      sessionFamilyId: 'fam_mock',
      response: {
        outcome: 'session' as const,
        accessToken: 'access_token',
        tokenType: 'Bearer' as const,
        expiresIn: 900,
        user: { id: 'cuid_u1', email: 'alice@example.com', status: 'active' as const },
      },
    }));

    const controller = buildController({
      store,
      mfaChallenge: { consume: consumeMock },
      mfa: { verifyRecoveryCode: verifyRecoveryCodeMock },
      auth: { issueSessionFor: issueSessionForMock },
      prisma: { user: { findUnique: findUniqueMock } } as unknown as Partial<PrismaService>,
    });

    const response = buildResponse();
    await controller.recoveryVerify(
      { challengeToken: 'challenge.jwt.value', recoveryCode: 'ABCDE-FGHJK' },
      buildRequest(),
      response,
    );

    expect(capturedAtChallenge).toEqual(EXEMPT);
    expect(capturedAtRecovery).toEqual(EXEMPT);
    expect(capturedAtUserLookup).toEqual(EXEMPT);
    expect(verifyRecoveryCodeMock).toHaveBeenCalledWith({
      userId: 'cuid_u1',
      code: 'ABCDE-FGHJK',
    });
    expect(response.cookie).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 inside the exempt frame when the recovery code is invalid', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const consumeMock = vi.fn(async () => ({ ok: true as const, userId: 'cuid_u1' }));
    const verifyRecoveryCodeMock = vi.fn(async () => {
      captured = store.current();
      return false;
    });
    const findUniqueMock = vi.fn();
    const issueSessionForMock = vi.fn();

    const controller = buildController({
      store,
      mfaChallenge: { consume: consumeMock },
      mfa: { verifyRecoveryCode: verifyRecoveryCodeMock },
      auth: { issueSessionFor: issueSessionForMock },
      prisma: { user: { findUnique: findUniqueMock } } as unknown as Partial<PrismaService>,
    });

    await expect(
      controller.recoveryVerify(
        { challengeToken: 'good.jwt', recoveryCode: 'ZZZZZ-ZZZZZ' },
        buildRequest(),
        buildResponse(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(captured).toEqual(EXEMPT);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(issueSessionForMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 inside the exempt frame when the challenge is invalid (short-circuit)', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const consumeMock = vi.fn(async () => {
      captured = store.current();
      return { ok: false as const, reason: 'expired' as const };
    });
    const verifyRecoveryCodeMock = vi.fn();

    const controller = buildController({
      store,
      mfaChallenge: { consume: consumeMock },
      mfa: { verifyRecoveryCode: verifyRecoveryCodeMock },
    });

    await expect(
      controller.recoveryVerify(
        { challengeToken: 'expired.jwt', recoveryCode: 'ABCDE-FGHJK' },
        buildRequest(),
        buildResponse(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(captured).toEqual(EXEMPT);
    expect(verifyRecoveryCodeMock).not.toHaveBeenCalled();
  });

  it('does NOT leak the exempt frame after recovery-verify returns', async () => {
    const store = new TenantContextStore();
    const controller = buildController({
      store,
      mfaChallenge: {
        consume: vi.fn(async () => ({ ok: false as const, reason: 'expired' as const })),
      },
      mfa: { verifyRecoveryCode: vi.fn() },
    });

    expect(store.current()).toBeNull();
    await expect(
      controller.recoveryVerify(
        { challengeToken: 'expired.jwt', recoveryCode: 'ABCDE-FGHJK' },
        buildRequest(),
        buildResponse(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.current()).toBeNull();
  });
});
