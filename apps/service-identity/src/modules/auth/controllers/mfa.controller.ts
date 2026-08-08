import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  MfaConfirmRequestSchema,
  MfaEnrollRequestSchema,
  MfaRecoveryVerifyRequestSchema,
  MfaVerifyRequestSchema,
  type LoginSessionResponse,
  type MfaConfirmRequest,
  type MfaConfirmResponse,
  type MfaEnrollRequest,
  type MfaEnrollResponse,
  type MfaListResponse,
  type MfaRecoveryVerifyRequest,
  type MfaRemoveResponse,
  type MfaVerifyRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request, Response } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthService } from '../services/auth.service';
import { MfaChallengeTokenService } from '../services/mfa-challenge-token.service';
import { MfaService } from '../services/mfa.service';
import {
  REFRESH_COOKIE_NAME,
  extractAuditContext,
  refreshCookieClearOptions,
  refreshCookieOptions,
} from './auth.controller';

/**
 * MFA HTTP boundary (TS-023, TS-023-followup-2). Six endpoints:
 *
 *   POST /api/v1/auth/mfa/totp/enroll     — auth required
 *   POST /api/v1/auth/mfa/totp/confirm    — auth required
 *   POST /api/v1/auth/mfa/verify          — NO auth (challenge-token)
 *   POST /api/v1/auth/mfa/recovery/verify — NO auth (challenge-token)
 *   GET  /api/v1/auth/mfa/methods         — auth required
 *   DELETE /api/v1/auth/mfa/methods/:id   — auth required
 *
 * Auth model. Enrollment / list / remove are protected by
 * `AccessTokenGuard` — only an authenticated user can manage their
 * own MFA methods. The two verify endpoints are unauthenticated by
 * design (the user is in the middle of logging in and does NOT yet
 * have an access token); they instead consume the short-lived
 * challenge JWT issued by `/api/v1/auth/login`. `recovery/verify` is
 * the lost-device path — it accepts a single-use recovery code
 * (TS-023-followup-2) in lieu of a TOTP code.
 *
 * Tenant scoping (CLAUDE.md §3.2). The four authenticated endpoints
 * (enroll, confirm, list, remove) run AFTER `AccessTokenGuard`, so the
 * `TenantContextInterceptor` (TS-141) seeds a scoped frame from the
 * request context before any Prisma operation fires. The two verify
 * endpoints (`verify` and `recovery/verify`) are pre-auth surfaces (the
 * user holds only a short-lived MFA challenge token, NOT an access
 * token), so no `requestContext` exists yet. TS-020-followup-2a2 / -2
 * therefore wrap each verify body in `runWithoutTenantContext(store,
 * 'pre-auth-mfa-verify' | 'pre-auth-mfa-recovery-verify', ...)` so the
 * Prisma extension's gate sees an explicit `exempt` frame rather than a
 * missing-frame `audit` warning — mirroring the four pre-auth wraps
 * `AuthController` ships under TS-020-followup-2a.
 * Together the five named exempt frames are the prerequisite for
 * TS-020-followup-2b's ramp from `enforcement: 'audit'` to
 * `enforcement: 'enforce'` — once every pre-auth surface emits zero
 * warn-level audit lines, any remaining warning is a real defect.
 *
 * Idempotency. Write endpoints accept `Idempotency-Key`; the same
 * "log + defer cache to TS-044" pattern as the signup endpoint is
 * applied — natural-uniqueness invariants (single-method-per-user,
 * single-use challenge) guard against double-effect today.
 */
@Controller('api/v1/auth/mfa')
export class MfaController {
  private readonly logger = new Logger(MfaController.name);

  constructor(
    private readonly mfa: MfaService,
    private readonly mfaChallenge: MfaChallengeTokenService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  /**
   * POST /api/v1/auth/mfa/totp/enroll — start TOTP enrollment.
   *
   * Status codes:
   *   200 OK            — enrollment begun; body contains the
   *                       otpauth URL + secret.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   *   409 Conflict      — user already has a confirmed method.
   */
  @Post('totp/enroll')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(MfaEnrollRequestSchema))
  async enrollTotp(
    @Body() input: MfaEnrollRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MfaEnrollResponse> {
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey) },
        'enroll request carried Idempotency-Key',
      );
    }
    const userId = requireUserId(request);
    // Look up the email so the otpauth label matches what the user
    // will see in their authenticator app.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (user === null) {
      // Authenticated but user row is gone — extremely unusual. The
      // guard already validated the JWT, so this is a missing-user
      // race that should not happen in practice.
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required.',
      });
    }
    return this.mfa.beginEnrollment({
      userId,
      accountLabel: user.email,
      label: input.label,
    });
  }

  /**
   * POST /api/v1/auth/mfa/totp/confirm — finish TOTP enrollment by
   * proving the user can produce a code from their authenticator.
   *
   * Status codes:
   *   200 OK            — method confirmed, mfaEnabled flipped true.
   *   400 Bad Request   — invalid code or payload.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — methodId does not belong to this user.
   *   409 Conflict      — method already confirmed.
   */
  @Post('totp/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(MfaConfirmRequestSchema))
  async confirmTotp(
    @Body() input: MfaConfirmRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MfaConfirmResponse> {
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey) },
        'confirm request carried Idempotency-Key',
      );
    }
    const userId = requireUserId(request);
    const { recoveryCodes } = await this.mfa.confirmEnrollment({
      userId,
      methodId: input.methodId,
      code: input.code,
    });
    // The recovery codes are transmitted in plaintext exactly here, once
    // (TS-023-followup-2). The client surfaces them to the user and they
    // are never returned again — the server keeps only hashes.
    return { mfaEnabled: true, recoveryCodes: [...recoveryCodes] };
  }

  /**
   * POST /api/v1/auth/mfa/verify — second step of the login flow.
   * Consumes the challenge token, verifies the TOTP code, and on
   * success returns a `LoginSessionResponse` (same shape as a
   * non-MFA login) plus sets the refresh-token cookie.
   *
   * Status codes:
   *   200 OK            — code accepted; body has access token and
   *                       cookie set.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — challenge invalid / expired / replayed,
   *                       or code wrong. Generic — no enumeration.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(MfaVerifyRequestSchema))
  async verify(
    @Body() input: MfaVerifyRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginSessionResponse> {
    return runWithoutTenantContext(this.tenantStore, 'pre-auth-mfa-verify', async () => {
      const challenge = await this.mfaChallenge.consume(input.challengeToken);
      if (!challenge.ok) {
        throw genericMfaUnauthorized(this.logger, 'challenge', challenge.reason);
      }

      const ok = await this.mfa.verifyForChallenge({
        userId: challenge.userId,
        code: input.code,
      });
      if (!ok) {
        throw genericMfaUnauthorized(this.logger, 'code', 'invalid');
      }

      // Look up the user to fill the session response body.
      const user = await this.prisma.user.findUnique({
        where: { id: challenge.userId },
        select: { id: true, email: true, status: true, deletedAt: true },
      });
      if (user === null || user.deletedAt !== null || user.status !== 'active') {
        // Race: user was deleted or suspended between login and verify.
        // Generic 401 — same body, same status.
        throw genericMfaUnauthorized(this.logger, 'user', 'gone');
      }

      const session = await this.auth.issueSessionFor({
        userId: user.id,
        email: user.email,
        status: user.status,
        mfaVerified: true,
        // Completing an MFA challenge (TOTP or recovery code) is NOT
        // an SSO assertion — the TS-296 gate in issueSessionFor
        // still applies on this path.
        ssoAsserted: false,
        ...extractAuditContext(request),
      });

      response.cookie(
        REFRESH_COOKIE_NAME,
        session.refreshToken,
        refreshCookieOptions(this.env, this.cookieMaxAgeSeconds()),
      );

      return session.response;
    });
  }

  /**
   * POST /api/v1/auth/mfa/recovery/verify — lost-device second step of
   * the login flow (TS-023-followup-2). Identical to `verify` except the
   * user presents a single-use recovery code instead of a TOTP code.
   * Consumes the challenge token, consumes the recovery code, and on
   * success returns a `LoginSessionResponse` plus the refresh cookie.
   *
   * Pre-auth surface — same tenant-scope treatment as `verify`: the user
   * holds only a short-lived challenge token, so the body runs inside
   * `runWithoutTenantContext(store, 'pre-auth-mfa-recovery-verify', ...)`
   * so the Prisma extension's gate sees an explicit `exempt` frame.
   *
   * Status codes:
   *   200 OK            — recovery code accepted; access token + cookie.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — challenge invalid / expired / replayed, or
   *                       recovery code wrong / already spent. Generic —
   *                       no enumeration.
   */
  @Post('recovery/verify')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(MfaRecoveryVerifyRequestSchema))
  async recoveryVerify(
    @Body() input: MfaRecoveryVerifyRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginSessionResponse> {
    return runWithoutTenantContext(this.tenantStore, 'pre-auth-mfa-recovery-verify', async () => {
      const challenge = await this.mfaChallenge.consume(input.challengeToken);
      if (!challenge.ok) {
        throw genericMfaUnauthorized(this.logger, 'challenge', challenge.reason);
      }

      const ok = await this.mfa.verifyRecoveryCode({
        userId: challenge.userId,
        code: input.recoveryCode,
      });
      if (!ok) {
        throw genericMfaUnauthorized(this.logger, 'recovery-code', 'invalid');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: challenge.userId },
        select: { id: true, email: true, status: true, deletedAt: true },
      });
      if (user === null || user.deletedAt !== null || user.status !== 'active') {
        throw genericMfaUnauthorized(this.logger, 'user', 'gone');
      }

      const session = await this.auth.issueSessionFor({
        userId: user.id,
        email: user.email,
        status: user.status,
        mfaVerified: true,
        // Completing an MFA challenge (TOTP or recovery code) is NOT
        // an SSO assertion — the TS-296 gate in issueSessionFor
        // still applies on this path.
        ssoAsserted: false,
        ...extractAuditContext(request),
      });

      response.cookie(
        REFRESH_COOKIE_NAME,
        session.refreshToken,
        refreshCookieOptions(this.env, this.cookieMaxAgeSeconds()),
      );

      return session.response;
    });
  }

  /**
   * GET /api/v1/auth/mfa/methods — list the authenticated user's
   * MFA methods (including unconfirmed; excluding soft-deleted).
   */
  @Get('methods')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listMethods(@Req() request: RequestWithContext): Promise<MfaListResponse> {
    const userId = requireUserId(request);
    const methods = await this.mfa.listMethods(userId);
    return {
      methods: methods.map((m) => ({
        id: m.id,
        kind: m.kind,
        label: m.label,
        confirmedAt: m.confirmedAt === null ? null : m.confirmedAt.toISOString(),
        lastUsedAt: m.lastUsedAt === null ? null : m.lastUsedAt.toISOString(),
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /**
   * DELETE /api/v1/auth/mfa/methods/:id — soft-delete one of the
   * authenticated user's MFA methods.
   *
   * Status codes:
   *   200 OK            — removed.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — method does not belong to this user.
   */
  @Delete('methods/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async removeMethod(
    @Param('id') methodId: string,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MfaRemoveResponse> {
    const userId = requireUserId(request);
    await this.mfa.removeMethod({ userId, methodId });

    // If removeMethod just dropped the user's last confirmed method,
    // the service has already flipped `users.mfa_enabled = false`.
    // We don't currently surface session-wide signal back to clients
    // — refresh tokens stay valid. A future "rotate sessions on MFA
    // change" enhancement is captured as TS-023-followup.

    // No cookie is touched here.
    void response;

    return { removed: true };
  }

  /**
   * Refresh-cookie max-age in seconds. Read from the TokenService
   * indirectly via the AuthService — keeps the constant in one
   * place. We intentionally do NOT inject TokenService here to
   * avoid widening the controller's dependency surface; instead
   * we read it from env directly.
   */
  private cookieMaxAgeSeconds(): number {
    return this.env.JWT_REFRESH_TTL_SECONDS;
  }
}

/**
 * Throw a generic 401 for every MFA-verify failure mode. Same body
 * for invalid challenge / expired / replayed / wrong code so the
 * network surface cannot be mined for which-failed signal.
 *
 * `reason` is logged (warn) so ops can correlate without exposing
 * the dimension to clients.
 */
function genericMfaUnauthorized(
  logger: Logger,
  kind: string,
  reason: string,
): UnauthorizedException {
  logger.warn({ kind, reason }, 'mfa verify rejected');
  return new UnauthorizedException({
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
    detail: 'Invalid email or password.',
  });
}

/**
 * Pull the userId out of the request context attached by the
 * AccessTokenGuard. Throws 401 if missing — would only happen if a
 * controller method forgot the `@UseGuards(AccessTokenGuard)`
 * decorator, in which case failing closed is the right behaviour.
 */
function requireUserId(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function redactKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '…';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * Re-export so `auth.module.ts` imports remain organised. (Empty
 * suppress to satisfy the "imports not unused" lint rule when the
 * helper is referenced only via shared file path.)
 */
void refreshCookieClearOptions;
