import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UsePipes,
} from '@nestjs/common';
import {
  LoginRequestSchema,
  type LoginRequest,
  type LoginResponse,
  type RefreshResponse,
  SignupRequestSchema,
  type SignupRequest,
  type SignupResponse,
} from '@taste-and-see/contracts';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Response as ExpressResponse } from 'express';
import type { Request, Response } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { AuthService } from '../services/auth.service';
import { RefreshTokenService, type RotateResult } from '../services/refresh-token.service';
import { TokenService } from '../services/token.service';

/**
 * Helpers for refresh-cookie attribute construction. Exported so the
 * MfaController can write the same cookie shape on the verify path
 * (which mints a session after consuming an MFA challenge).
 */
export function refreshCookieOptions(
  env: Env,
  maxAgeSeconds: number,
): {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly path: string;
  readonly maxAge: number;
} {
  return {
    httpOnly: true,
    secure: env.REFRESH_COOKIE_SECURE,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds * 1000,
  };
}

export function refreshCookieClearOptions(env: Env): {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly path: string;
} {
  return {
    httpOnly: true,
    secure: env.REFRESH_COOKIE_SECURE,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  };
}

/**
 * Pull the IP and user-agent from a request — same logic used by the
 * MfaController. Exported so both controllers attribute audit metadata
 * identically.
 */
export function extractAuditContext(request: Request): {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
} {
  return {
    ip: extractClientIp(request),
    userAgent: extractUserAgent(request),
  };
}

/**
 * Write a session response — used by both `/login` (no-MFA branch)
 * and `/mfa/verify` so the success-path side effects (cookie write,
 * body shape) are constructed in exactly one place.
 */
export function writeSessionResponse(
  response: ExpressResponse,
  env: Env,
  result: { readonly refreshToken: string; readonly response: unknown },
  refreshCookieMaxAgeSeconds: number,
): unknown {
  response.cookie(
    REFRESH_COOKIE_NAME,
    result.refreshToken,
    refreshCookieOptions(env, refreshCookieMaxAgeSeconds),
  );
  return result.response;
}

/**
 * Identity / auth HTTP boundary for service-identity.
 *
 * Surface today: signup (TS-021), login + refresh + logout (TS-022).
 * Everything else (MFA, RBAC, KYC, lockout) extends this class as the
 * relevant tasks land.
 *
 * Versioning: `/api/v1/auth/...` — every breaking change moves to v2,
 * v1 keeps working (CLAUDE.md §5.1).
 *
 * The controller writes refresh tokens only to a HttpOnly+Secure cookie
 * (CLAUDE.md §3.1: "no tokens in localStorage"). The cookie's path is
 * scoped to `/api/v1/auth/refresh` and `/api/v1/auth/logout` so it never
 * accompanies access-token requests, which lowers the CSRF surface.
 *
 * Tenant-scoping (TS-020-followup-2a). The four pre-auth handlers below
 * (signup, login, refresh, logout) run BEFORE any `requestContext`
 * exists — the user has not been authenticated yet, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. Each handler
 * therefore wraps its body in `runWithoutTenantContext(...)` so the
 * Prisma extension's gate sees an explicit `exempt` frame rather than
 * a missing-frame `audit` warning. The wrap is the prerequisite for
 * TS-020-followup-2b's ramp from `enforcement: 'audit'` to
 * `enforcement: 'enforce'` — once the pre-auth surface emits zero
 * warn-level audit lines, any remaining warning is a real defect to
 * fix before flipping the flag.
 */
@Controller('api/v1/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly tokenService: TokenService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  /**
   * POST /api/v1/auth/signup — create a new account.
   *
   * Status codes:
   *   201 Created           — new account; body is the `SignupResponse` DTO.
   *   400 Bad Request       — payload failed Zod validation (RFC 7807).
   *   409 Conflict          — email or phone already in use.
   *
   * Idempotency. Two layers (CLAUDE.md §3.3 / §17.5):
   *
   *   1. Natural content idempotency. Signup is unique on the email
   *      column at the DB layer — sending the same payload twice
   *      converges (the second request hits the unique constraint and
   *      surfaces as 409 email-already-exists).
   *
   *   2. Redis-backed replay cache (TS-044-followup-2). The global
   *      `IdempotencyInterceptor` from `@taste-and-see/nest-idempotency`
   *      claims a Redis slot per `Idempotency-Key`, body-hashes the
   *      request, and replays the cached HTTP response (status + body +
   *      content-type) for any retry within the 24h TTL. A same-key-
   *      different-body retry returns 409 with a problem-shaped body;
   *      a concurrent in-flight retry returns 409 + `Retry-After`. The
   *      cache short-circuits the handler entirely, defeating the
   *      partial-success bug where the DB write succeeded but the
   *      response was lost on the wire — the natural-content layer
   *      alone would surface that retry as a confusing 409 instead of
   *      replaying the original 201.
   *
   * The actor segment of the Redis key falls back to `anonymous` for
   * this pre-auth endpoint (default actor resolver — no `requestContext`
   * exists yet because the user is being created). The body hash is the
   * isolation gate against unrelated clients colliding on a lucky
   * Idempotency-Key.
   */
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(SignupRequestSchema))
  async signup(
    @Body() input: SignupRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SignupResponse> {
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey) },
        'signup request carried Idempotency-Key',
      );
    }
    return runWithoutTenantContext(this.tenantStore, 'pre-auth-signup', () =>
      this.authService.signup(input),
    );
  }

  /**
   * POST /api/v1/auth/login — exchange email + password for an access
   * token + refresh-token cookie.
   *
   * Status codes:
   *   200 OK                — credentials valid; body has the access token.
   *   400 Bad Request       — payload failed Zod validation.
   *   401 Unauthorized      — generic credential-failure (no enumeration).
   *
   * The refresh token never appears in the JSON body — only as a
   * `Set-Cookie` header (HttpOnly, Secure, SameSite=Lax, scoped to
   * `/api/v1/auth/refresh` + `/logout`).
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(LoginRequestSchema))
  async login(
    @Body() input: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    return runWithoutTenantContext(this.tenantStore, 'pre-auth-login', async () => {
      const result = await this.authService.login(input, extractAuditContext(request));

      if (result.outcome === 'session') {
        response.cookie(REFRESH_COOKIE_NAME, result.refreshToken, this.refreshCookieOptions());
        return result.response;
      }

      // outcome === 'challenge' — refresh cookie deliberately not
      // written here. The cookie comes only after the user completes
      // the MFA challenge via `/api/v1/auth/mfa/verify`.
      return result.response;
    });
  }

  /**
   * POST /api/v1/auth/refresh — exchange a presented refresh-token cookie
   * for a fresh access token + a rotated refresh-token cookie.
   *
   * Status codes:
   *   200 OK                — rotation succeeded.
   *   401 Unauthorized      — missing / unknown / expired / revoked / reused.
   *
   * On reuse-detection (presented token already rotated once), the
   * `RefreshTokenService` revokes the entire family server-side; this
   * controller only translates the result to an HTTP outcome. The cookie
   * is cleared on every 401 so a stale credential doesn't stay in the
   * browser jar.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RefreshResponse> {
    return runWithoutTenantContext(this.tenantStore, 'pre-auth-refresh', async () => {
      const presented = readCookieValue(request, REFRESH_COOKIE_NAME);
      if (presented === null) {
        throw this.unauthorized(response, 'missing-cookie');
      }

      const rotation: RotateResult = await this.refreshTokenService.rotate({
        presentedRawToken: presented,
        ip: extractClientIp(request),
        userAgent: extractUserAgent(request),
      });

      if (!rotation.ok) {
        throw this.unauthorized(response, rotation.reason);
      }

      const access = this.tokenService.signAccessToken({
        userId: rotation.userId,
        sessionId: rotation.familyId,
        mfaVerified: false,
      });

      response.cookie(
        REFRESH_COOKIE_NAME,
        rotation.newRawRefreshToken,
        this.refreshCookieOptions(),
      );

      return {
        accessToken: access.token,
        tokenType: 'Bearer',
        expiresIn: access.expiresInSeconds,
      };
    });
  }

  /**
   * POST /api/v1/auth/logout — revoke the entire refresh-token family
   * tied to the presented cookie and clear it from the browser.
   *
   * Always returns 204 — even when no cookie was presented or the
   * presented value is unknown — so the endpoint is idempotent and
   * doesn't leak whether a session existed.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    return runWithoutTenantContext(this.tenantStore, 'pre-auth-logout', async () => {
      const presented = readCookieValue(request, REFRESH_COOKIE_NAME);
      if (presented !== null) {
        // Look up the family to revoke. We don't reuse rotate() here
        // because logout should not trigger reuse-detection consequences
        // even if the presented token has already been rotated — the
        // user's intent is "end this session", not "I'm being attacked".
        const family = await this.refreshTokenService.findFamilyForRawToken(presented);
        if (family !== null) {
          await this.refreshTokenService.revokeFamily(family.familyId);
        }
      }
      response.clearCookie(REFRESH_COOKIE_NAME, this.refreshCookieClearOptions());
    });
  }

  private refreshCookieOptions(): {
    readonly httpOnly: true;
    readonly secure: boolean;
    readonly sameSite: 'lax';
    readonly path: string;
    readonly maxAge: number;
  } {
    return {
      httpOnly: true,
      secure: this.env.REFRESH_COOKIE_SECURE,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      // express's `maxAge` is milliseconds.
      maxAge: this.tokenService.refreshCookieMaxAgeSeconds * 1000,
    };
  }

  private refreshCookieClearOptions(): {
    readonly httpOnly: true;
    readonly secure: boolean;
    readonly sameSite: 'lax';
    readonly path: string;
  } {
    return {
      httpOnly: true,
      secure: this.env.REFRESH_COOKIE_SECURE,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
    };
  }

  /**
   * Construct a generic 401 + clear the refresh cookie on the way out.
   * Logged at debug — info-level logs of every refresh failure would
   * include the IP and risk turning the log pipeline into an
   * enumeration tool.
   */
  private unauthorized(
    response: Response,
    reason: 'missing-cookie' | 'unknown' | 'reused' | 'expired' | 'revoked',
  ): UnauthorizedException {
    response.clearCookie(REFRESH_COOKIE_NAME, this.refreshCookieClearOptions());
    this.logger.debug({ reason }, 'refresh failed');
    return new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail:
        reason === 'reused'
          ? 'Session expired. Please sign in again.'
          : 'Session expired. Please sign in again.',
    });
  }
}

/**
 * Idempotency keys are opaque tokens supplied by clients; not strictly
 * secret, but better not to log them in full for the same reason we
 * don't log full request IDs everywhere — they're correlation handles.
 * First 8 + last 4 is plenty for support-grade tracing.
 */
function redactKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '…';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * Cookie name + path are exported so the web client can pin them in
 * tests / type definitions. Path is scoped narrowly so the cookie does
 * NOT accompany requests to non-auth endpoints — reducing CSRF surface.
 *
 * The `__Host-` / `__Secure-` cookie-name prefixes are deliberately NOT
 * used: `__Host-` requires `Path=/` (which would defeat the scoped
 * path), and `__Secure-` requires HTTPS which doesn't hold in local dev
 * where `REFRESH_COOKIE_SECURE=false`. The prefix would force a
 * conditional name that varies by environment — confusing and
 * test-fragile. Instead we get equivalent practical protection from
 * `HttpOnly + Secure (when env=true) + SameSite=Lax + scoped Path`,
 * documented as the explicit defensive surface.
 */
export const REFRESH_COOKIE_NAME = 'tns_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * Read a single cookie value from the raw `Cookie` header without
 * pulling in `cookie-parser` middleware. Returns the FIRST value if the
 * client (incorrectly) sends multiple cookies with the same name, which
 * is the whatwg-fetch / RFC 6265 behaviour expected by browsers.
 *
 * Splits on `; ` per RFC 6265 §4.2.1; tolerates either `; ` or `;` to
 * match real-world client behaviour. Trims whitespace around the name
 * but not the value (cookie values are opaque strings; trimming would
 * silently mutate them).
 */
function readCookieValue(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) {
    return null;
  }
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      const value = part.slice(eq + 1);
      // Cookie values may be wrapped in double-quotes per RFC 6265.
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1);
      }
      return value;
    }
  }
  return null;
}

/**
 * Best-effort client IP extraction. Trusts `x-forwarded-for` only when
 * the first hop is set; in production a proper trust-proxy chain is
 * configured at the load-balancer level. Falls back to the socket's
 * remote address. Result is informational (audit only) — never used as
 * a security boundary, so the looseness is acceptable.
 */
function extractClientIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0];
    if (typeof first === 'string' && first.length > 0) return first;
  }
  return request.socket.remoteAddress ?? undefined;
}

function extractUserAgent(request: Request): string | undefined {
  const ua = request.headers['user-agent'];
  if (typeof ua === 'string' && ua.length > 0) return ua;
  return undefined;
}
