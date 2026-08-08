import 'reflect-metadata';

import { UnauthorizedException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { AuthService } from '../services/auth.service';
import type { RefreshTokenService } from '../services/refresh-token.service';
import type { TokenService } from '../services/token.service';
import { AuthController } from './auth.controller';

/**
 * Controller-level wiring tests for `AuthController`.
 *
 * Two describe blocks today:
 *
 *   1. `@Idempotent()` metadata wiring on the signup endpoint
 *      (TS-044-followup-2). The IdempotencyInterceptor reads this
 *      symbol; without it, replayed POST /signup requests would silently
 *      re-run the handler.
 *
 *   2. `runWithoutTenantContext` wrapping on the four pre-auth handlers
 *      (TS-020-followup-2a). The pre-auth surface runs BEFORE any
 *      `requestContext` exists, so the Prisma extension's gate would
 *      otherwise emit warn-level audit lines for every pre-auth Prisma
 *      operation. The wrap installs an explicit `exempt` frame so the
 *      gate proceeds without warnings — the prerequisite for ramping
 *      `enforcement: 'audit'` → `enforcement: 'enforce'` in
 *      TS-020-followup-2b.
 *
 * The service-layer tests in `services/auth.service.test.ts` +
 * `services/auth.service.login.test.ts` carry the deeper behavioural
 * coverage. When controller-level integration tests follow
 * (TS-022-followup-5 has already landed for auth), additional describe
 * blocks can slot in alongside the wiring blocks below.
 */
describe('AuthController idempotency wiring (TS-044-followup-2)', () => {
  // The IdempotencyInterceptor (provided globally by IdempotencyModule
  // in app.module.ts) reads this exact symbol when deciding whether to
  // engage the Redis-backed Idempotency-Key replay cache. The metadata
  // MUST be present on the signup endpoint or a replayed request will
  // silently re-run the handler — defeating CLAUDE.md §3.3 / §17.5.
  //
  // We reference the symbol via `Symbol.for(...)` rather than importing
  // it from `@taste-and-see/nest-idempotency` so this test pins the
  // wire contract — a refactor that renames the symbol will fail here
  // first, before it can silently disable the cache.
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks POST /api/v1/auth/signup as @Idempotent()', () => {
    const handler = AuthController.prototype.signup as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  // Negative tests. Login / refresh / logout are NOT @Idempotent() —
  // their replay semantics are wrong for the cache (login generates
  // fresh access tokens on every call, refresh rotates the family,
  // logout always-revokes). A class-level @Idempotent() applied
  // accidentally would make every auth call pay a Redis round-trip
  // AND risk replaying a stale access token from cache. Catch the
  // drift here before it can ship.

  it('does NOT mark POST /api/v1/auth/login as @Idempotent()', () => {
    const handler = AuthController.prototype.login as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('does NOT mark POST /api/v1/auth/refresh as @Idempotent()', () => {
    const handler = AuthController.prototype.refresh as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('does NOT mark POST /api/v1/auth/logout as @Idempotent()', () => {
    const handler = AuthController.prototype.logout as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });
});

/**
 * Each of the four pre-auth handlers (signup, login, refresh, logout)
 * runs BEFORE any `requestContext` exists on the request — the user
 * has not yet been authenticated, so the `TenantContextInterceptor`
 * cannot seed a scoped frame. Without an explicit exempt wrap, every
 * Prisma operation downstream of these handlers triggers a warn-level
 * audit line from the tenant-scope Prisma extension (Phase 1 default:
 * `enforcement: 'audit'`).
 *
 * These tests pin the wrap contract by passing a real
 * `TenantContextStore` and a fake downstream service that captures
 * `store.current()` at call time. The captured frame must be
 * `{ kind: 'exempt', reason: 'pre-auth-{handler}' }` — the precise
 * reason string the audit log will surface, so a future log scan can
 * trace every "no-context" Prisma access back to its pre-auth source.
 *
 * The captured frame also acts as the implicit assertion that the
 * service is invoked INSIDE the wrap's lexical scope. A regression that
 * pulled a Prisma call outside the wrap (e.g. by computing input before
 * the wrap starts) would surface here as `frame === null`.
 */
describe('AuthController tenant-scope exempt wrap (TS-020-followup-2a)', () => {
  function buildEnv(): Env {
    return {
      REFRESH_COOKIE_SECURE: false,
      JWT_REFRESH_TTL_SECONDS: 60 * 60 * 24 * 30,
    } as unknown as Env;
  }

  function buildRequest(opts: { cookieHeader?: string } = {}): Request {
    return {
      headers: opts.cookieHeader === undefined ? {} : { cookie: opts.cookieHeader },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
  }

  function buildResponse(): Response {
    return {
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as Response;
  }

  it('runs signup inside an exempt frame with reason "pre-auth-signup"', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const signupMock = vi.fn(async () => {
      captured = store.current();
      return {
        id: 'cuid_u1',
        email: 'alice@example.com',
        phone: null,
        status: 'pending_verification' as const,
        createdAt: new Date('2026-05-20T12:00:00.000Z').toISOString(),
      };
    });
    const authService = { signup: signupMock } as unknown as AuthService;

    const controller = new AuthController(
      authService,
      {} as unknown as RefreshTokenService,
      {} as unknown as TokenService,
      buildEnv(),
      store,
    );

    await controller.signup({
      email: 'alice@example.com',
      password: 'correct horse battery staple',
    });

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-signup' });
    expect(signupMock).toHaveBeenCalledTimes(1);
  });

  it('runs login inside an exempt frame with reason "pre-auth-login"', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const loginMock = vi.fn(async () => {
      captured = store.current();
      return {
        outcome: 'session' as const,
        refreshToken: 'raw_refresh_value',
        refreshExpiresAt: new Date('2026-06-20T12:00:00.000Z'),
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
    const authService = { login: loginMock } as unknown as AuthService;

    const tokenService = {
      refreshCookieMaxAgeSeconds: 60 * 60 * 24 * 30,
    } as unknown as TokenService;

    const controller = new AuthController(
      authService,
      {} as unknown as RefreshTokenService,
      tokenService,
      buildEnv(),
      store,
    );

    await controller.login(
      { email: 'alice@example.com', password: 'pw' },
      buildRequest(),
      buildResponse(),
    );

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-login' });
    expect(loginMock).toHaveBeenCalledTimes(1);
  });

  it('runs refresh inside an exempt frame with reason "pre-auth-refresh"', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const rotateMock = vi.fn(async () => {
      captured = store.current();
      return {
        ok: true as const,
        userId: 'cuid_u1',
        familyId: 'cuid_family',
        newRawRefreshToken: 'rotated_value',
        newRefreshExpiresAt: new Date('2026-06-20T12:00:00.000Z'),
      };
    });
    const refreshTokenService = {
      rotate: rotateMock,
    } as unknown as RefreshTokenService;

    const tokenService = {
      signAccessToken: vi.fn(() => ({
        token: 'access_token',
        expiresInSeconds: 900,
      })),
      refreshCookieMaxAgeSeconds: 60 * 60 * 24 * 30,
    } as unknown as TokenService;

    const controller = new AuthController(
      {} as unknown as AuthService,
      refreshTokenService,
      tokenService,
      buildEnv(),
      store,
    );

    await controller.refresh(
      buildRequest({ cookieHeader: 'tns_refresh=raw_refresh_value' }),
      buildResponse(),
    );

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-refresh' });
    expect(rotateMock).toHaveBeenCalledTimes(1);
  });

  it('runs refresh inside an exempt frame even when no cookie is presented (missing-cookie 401 path)', async () => {
    const store = new TenantContextStore();
    // The 401-on-missing-cookie branch never calls a downstream service,
    // so we capture the frame via the response.clearCookie side-effect
    // — the unauthorized() helper invokes it INSIDE the wrap.
    let captured: TenantContextFrame | null = null;
    const response = {
      cookie: vi.fn(),
      clearCookie: vi.fn(() => {
        captured = store.current();
      }),
    } as unknown as Response;

    const controller = new AuthController(
      {} as unknown as AuthService,
      {} as unknown as RefreshTokenService,
      {} as unknown as TokenService,
      buildEnv(),
      store,
    );

    await expect(controller.refresh(buildRequest(), response)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-refresh' });
  });

  it('runs logout inside an exempt frame with reason "pre-auth-logout" (cookie present)', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const findFamilyMock = vi.fn(async () => {
      captured = store.current();
      return { familyId: 'cuid_family' };
    });
    const revokeFamilyMock = vi.fn(async () => ({ revokedCount: 1 }));
    const refreshTokenService = {
      findFamilyForRawToken: findFamilyMock,
      revokeFamily: revokeFamilyMock,
    } as unknown as RefreshTokenService;

    const controller = new AuthController(
      {} as unknown as AuthService,
      refreshTokenService,
      {} as unknown as TokenService,
      buildEnv(),
      store,
    );

    await controller.logout(
      buildRequest({ cookieHeader: 'tns_refresh=raw_refresh_value' }),
      buildResponse(),
    );

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-logout' });
    expect(findFamilyMock).toHaveBeenCalledTimes(1);
    expect(revokeFamilyMock).toHaveBeenCalledTimes(1);
  });

  it('runs logout inside an exempt frame even when no cookie is presented (no service hop)', async () => {
    const store = new TenantContextStore();
    let captured: TenantContextFrame | null = null;
    const response = {
      cookie: vi.fn(),
      clearCookie: vi.fn(() => {
        captured = store.current();
      }),
    } as unknown as Response;

    const findFamilyMock = vi.fn();
    const revokeFamilyMock = vi.fn();
    const refreshTokenService = {
      findFamilyForRawToken: findFamilyMock,
      revokeFamily: revokeFamilyMock,
    } as unknown as RefreshTokenService;

    const controller = new AuthController(
      {} as unknown as AuthService,
      refreshTokenService,
      {} as unknown as TokenService,
      buildEnv(),
      store,
    );

    await controller.logout(buildRequest(), response);

    expect(captured).toEqual({ kind: 'exempt', reason: 'pre-auth-logout' });
    // No cookie → no service hops; only clearCookie fires on the way out.
    expect(findFamilyMock).not.toHaveBeenCalled();
    expect(revokeFamilyMock).not.toHaveBeenCalled();
  });

  it('does NOT leak the exempt frame after the handler returns', async () => {
    const store = new TenantContextStore();
    const signupMock = vi.fn(async () => ({
      id: 'cuid_u1',
      email: 'alice@example.com',
      phone: null,
      status: 'pending_verification' as const,
      createdAt: new Date('2026-05-20T12:00:00.000Z').toISOString(),
    }));
    const authService = { signup: signupMock } as unknown as AuthService;

    const controller = new AuthController(
      authService,
      {} as unknown as RefreshTokenService,
      {} as unknown as TokenService,
      buildEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    await controller.signup({
      email: 'alice@example.com',
      password: 'pw',
    });
    expect(store.current()).toBeNull();
  });
});
