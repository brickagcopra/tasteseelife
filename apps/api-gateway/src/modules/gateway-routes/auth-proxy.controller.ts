import {
  BadGatewayException,
  Body,
  Controller,
  GatewayTimeoutException,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  LoginRequestSchema,
  LoginResponseSchema,
  LoginSessionResponseSchema,
  MfaRecoveryVerifyRequestSchema,
  MfaVerifyRequestSchema,
  RefreshResponseSchema,
  ResendVerificationEmailRequestSchema,
  ResendVerificationEmailResponseSchema,
  SignupRequestSchema,
  SignupResponseSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResponseSchema,
  type LoginRequest,
  type LoginResponse,
  type LoginSessionResponse,
  type MfaVerifyRequest,
  type RefreshResponse,
  type ResendVerificationEmailRequest,
  type ResendVerificationEmailResponse,
  type SignupRequest,
  type SignupResponse,
  type VerifyEmailRequest,
  type VerifyEmailResponse,
} from '@taste-and-see/contracts';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request, Response } from 'express';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimit } from '../rate-limit/decorators/rate-limit.decorator';
import { AuthProxyMetrics, outcomeFromBody, type AuthProxySurface } from './auth-proxy-metrics';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Auth proxy (TS-121). Fronts service-identity's authentication endpoints
 * via the api-gateway BFF so the family / provider portals (and any
 * future browser client) never contact service-identity directly.
 *
 * Three surfaces, all rate-limited under the `sensitive` policy:
 *
 *   - `POST /api/v1/auth/signup` — public; forwards the request body to
 *     service-identity and returns the freshly-created `SignupResponse`.
 *     Signup never issues a session token (see `auth.schema.ts` —
 *     "TS-021 ships signup only; tokens land with TS-022 login + refresh")
 *     so no `Set-Cookie` propagation is required here, but the proxy
 *     forwards any cookies the downstream chose to set anyway (forward-
 *     compatible if service-identity grows email-verification cookies).
 *
 *   - `POST /api/v1/auth/login` — public; forwards body, propagates
 *     `Set-Cookie` (refresh-token cookie minted by service-identity) and
 *     returns the discriminated `LoginResponse` (session or MFA
 *     challenge). The web client's server action receives the body AND
 *     re-cookies the refresh token on its own domain via its own
 *     HttpOnly cookie — `Set-Cookie` pass-through is the BFF cookie
 *     boundary.
 *
 *   - `POST /api/v1/auth/refresh` — public (no Bearer required); reads
 *     the inbound `Cookie` header and forwards it verbatim to service-
 *     identity, which consumes the refresh-token cookie + mints a
 *     rotated cookie. The new `Set-Cookie` is forwarded on the way back.
 *
 *   - `POST /api/v1/auth/mfa/verify` — public (TS-123, second step of
 *     the MFA login flow). The portal carries the challenge token in
 *     its body + a fresh TOTP code; service-identity consumes the
 *     single-use challenge JWT + verifies the TOTP, and on success
 *     mints a session (returns LoginSessionResponse + Set-Cookie for
 *     the rotated refresh token). The proxy propagates Set-Cookie
 *     identically to /auth/login so the portal's server action can
 *     re-cookie the refresh token on its own domain.
 *
 * Failure mapping mirrors `PlansProxyController` for consistency:
 *
 *   - `not_configured` → 503 (with `IDENTITY_SERVICE_BASE_URL` hint)
 *   - `timeout`        → 504
 *   - `network_error`  → 502
 *   - `server_error`   → 502
 *   - `client_error`   → re-throw with the downstream's status + body
 *                        (4xx surfaced verbatim; the downstream RFC 7807
 *                        body is the most informative signal for the
 *                        upstream caller)
 *   - `ok` with malformed body → 502 (contract violation between gateway
 *     and downstream — surfaces immediately rather than passing garbage
 *     to the browser)
 *
 * Idempotency. The proxy does NOT decorate with `@Idempotent()` — the
 * gateway has no idempotency store (TS-140-followup-5 was never done and
 * `@taste-and-see/nest-idempotency` is not a gateway dependency). What it
 * DOES do, on every write here, is **forward the caller's `Idempotency-Key`
 * verbatim** so the downstream's own decorator has something to key on
 * (TS-505d-prep-followup-1). Whether a given route honours it is
 * service-identity's call, made per route: `signup` wears `@Idempotent()`,
 * the rest do not.
 *
 * **Note for whoever decorates one of the others.** These are pre-auth
 * surfaces, so `nest-idempotency`'s actor resolver falls back to the shared
 * `anonymous` bucket, and replay protection then rests entirely on the
 * request-body hash. `signup` is safe because its body carries the email.
 * A route with an empty or non-distinguishing body — `refresh`, whose token
 * rides a cookie — would let two unrelated callers who picked the same key
 * collide, and its cached response is a token pair. Tracked as
 * TS-505d-prep-followup-1a; do not decorate `refresh` before it is resolved.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout).** Every
 * handler on this controller runs BEFORE `AccessTokenGuard` could
 * possibly seed a `request.requestContext` — signup/login/refresh/
 * mfa-verify ARE the surfaces that mint the session that future
 * requests carry. The `TenantContextInterceptor` therefore cannot seed
 * a scoped frame here, and the gate would fire `MissingRequestContextError`
 * on the first model touch if a maintainer ever added Prisma to the
 * gateway. Today the gateway has no Prisma (api-gateway is a pure BFF
 * — PDD §7.1 / §7.2), so the gate has no callsite. The handler bodies
 * still wrap in `runWithoutTenantContext(..., 'gateway-pre-auth-{name}', ...)`
 * for defence-in-depth + parity with the canonical thirteen-service
 * rollout shape. Mirrors the four `pre-auth-{signup,login,refresh,
 * logout}` wraps landed in service-identity's `AuthController`
 * (TS-020-followup-2a) and the `pre-auth-mfa-verify` wrap in
 * service-identity's `MfaController.verify` (TS-020-followup-2a2).
 */
@Controller('api/v1/auth')
@UseGuards(RateLimitGuard)
export class AuthProxyController {
  constructor(
    private readonly downstream: DownstreamHttpClient,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
    private readonly metrics: AuthProxyMetrics,
  ) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ policy: 'sensitive' })
  async signup(
    @Body() input: SignupRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignupResponse> {
    return runWithoutTenantContext(this.tenantStore, 'gateway-pre-auth-signup', async () => {
      const parsedRequest = SignupRequestSchema.safeParse(input);
      if (!parsedRequest.success) {
        // Counted BEFORE any downstream call: a 400 from us and a 401 from
        // identity are both "the caller failed", and only one of them means
        // somebody is probing the shape of the API (TS-121-followup-9).
        this.metrics.recordCall('signup', 'invalid_request');
        throw new HttpException(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: HttpStatus.BAD_REQUEST,
            detail: 'Signup payload failed validation.',
            issues: parsedRequest.error.issues,
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result: DownstreamResult = await this.downstream.call({
        service: 'identity',
        path: '/api/v1/auth/signup',
        method: 'POST',
        body: parsedRequest.data,
        traceId: extractTraceId(request),
        idempotencyKey: readIdempotencyKey(request),
      });

      return mapResult(
        result,
        response,
        SignupResponseSchema,
        'signup',
        extractTraceId(request),
        this.metrics,
      );
    });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'sensitive' })
  async login(
    @Body() input: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    return runWithoutTenantContext(this.tenantStore, 'gateway-pre-auth-login', async () => {
      const parsedRequest = LoginRequestSchema.safeParse(input);
      if (!parsedRequest.success) {
        // Counted BEFORE any downstream call: a 400 from us and a 401 from
        // identity are both "the caller failed", and only one of them means
        // somebody is probing the shape of the API (TS-121-followup-9).
        this.metrics.recordCall('login', 'invalid_request');
        throw new HttpException(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: HttpStatus.BAD_REQUEST,
            detail: 'Login payload failed validation.',
            issues: parsedRequest.error.issues,
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result: DownstreamResult = await this.downstream.call({
        service: 'identity',
        path: '/api/v1/auth/login',
        method: 'POST',
        body: parsedRequest.data,
        traceId: extractTraceId(request),
        idempotencyKey: readIdempotencyKey(request),
      });

      return mapResult(
        result,
        response,
        LoginResponseSchema,
        'login',
        extractTraceId(request),
        this.metrics,
      );
    });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'sensitive' })
  async refresh(
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RefreshResponse> {
    return runWithoutTenantContext(this.tenantStore, 'gateway-pre-auth-refresh', async () => {
      const cookieHeader = readCookieHeader(request);

      const result: DownstreamResult = await this.downstream.call({
        service: 'identity',
        path: '/api/v1/auth/refresh',
        method: 'POST',
        ...(cookieHeader === null ? {} : { cookieHeader }),
        traceId: extractTraceId(request),
        idempotencyKey: readIdempotencyKey(request),
      });

      return mapResult(
        result,
        response,
        RefreshResponseSchema,
        'refresh',
        extractTraceId(request),
        this.metrics,
      );
    });
  }

  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'sensitive' })
  async mfaVerify(
    @Body() input: MfaVerifyRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginSessionResponse> {
    return runWithoutTenantContext(this.tenantStore, 'gateway-pre-auth-mfa-verify', async () => {
      const parsedRequest = MfaVerifyRequestSchema.safeParse(input);
      if (!parsedRequest.success) {
        // Counted BEFORE any downstream call: a 400 from us and a 401 from
        // identity are both "the caller failed", and only one of them means
        // somebody is probing the shape of the API (TS-121-followup-9).
        this.metrics.recordCall('mfa-verify', 'invalid_request');
        throw new HttpException(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: HttpStatus.BAD_REQUEST,
            detail: 'MFA verify payload failed validation.',
            issues: parsedRequest.error.issues,
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result: DownstreamResult = await this.downstream.call({
        service: 'identity',
        path: '/api/v1/auth/mfa/verify',
        method: 'POST',
        body: parsedRequest.data,
        traceId: extractTraceId(request),
        idempotencyKey: readIdempotencyKey(request),
      });

      return mapResult(
        result,
        response,
        LoginSessionResponseSchema,
        'mfa-verify',
        extractTraceId(request),
        this.metrics,
      );
    });
  }

  /**
   * TS-510 — `POST /api/v1/auth/verify-email`.
   *
   * **Without this proxy the feature does not exist.** Nothing but the gateway
   * is reachable from a browser, so an unproxied identity route is a route no
   * customer can call — and this one is the only path from the
   * `pending_verification` an account is created in to the `active` login
   * requires.
   *
   * `sensitive` rate-limit policy: the token is a bearer credential on an
   * unauthenticated endpoint, so it is guessing-shaped in exactly the way
   * login is, even though 256 bits makes guessing hopeless.
   *
   * The `Idempotency-Key` header is forwarded rather than re-implemented here,
   * because service-identity's `@Idempotent()` interceptor is what holds the
   * replay cache — two caches with independent TTLs over one single-use token
   * is a way to make a link work in one and fail in the other.
   */
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'sensitive' })
  async verifyEmail(
    @Body() input: VerifyEmailRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VerifyEmailResponse> {
    return runWithoutTenantContext(this.tenantStore, 'gateway-pre-auth-verify-email', async () => {
      const parsedRequest = VerifyEmailRequestSchema.safeParse(input);
      if (!parsedRequest.success) {
        this.metrics.recordCall('verify-email', 'invalid_request');
        throw new HttpException(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: HttpStatus.BAD_REQUEST,
            detail: 'Email-verification payload failed validation.',
            issues: parsedRequest.error.issues,
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result: DownstreamResult = await this.downstream.call({
        service: 'identity',
        path: '/api/v1/auth/verify-email',
        method: 'POST',
        body: parsedRequest.data,
        traceId: extractTraceId(request),
        idempotencyKey: readIdempotencyKey(request),
      });

      return mapResult(
        result,
        response,
        VerifyEmailResponseSchema,
        'verify-email',
        extractTraceId(request),
        this.metrics,
      );
    });
  }

  /**
   * TS-510 — `POST /api/v1/auth/verification-emails`.
   *
   * 202 for every accepted payload. The downstream's non-disclosure contract
   * (a registered, unregistered and already-verified address are one response)
   * only holds if this proxy does not add a distinction of its own — which is
   * why the response is re-validated like every other proxied body: a
   * downstream that grew a `sent: false` field would be a leak, and drift
   * becomes a 502 rather than reaching the browser.
   */
  @Post('verification-emails')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit({ policy: 'sensitive' })
  async resendVerificationEmail(
    @Body() input: ResendVerificationEmailRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ResendVerificationEmailResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'gateway-pre-auth-resend-verification',
      async () => {
        const parsedRequest = ResendVerificationEmailRequestSchema.safeParse(input);
        if (!parsedRequest.success) {
          this.metrics.recordCall('resend-verification', 'invalid_request');
          throw new HttpException(
            {
              type: 'about:blank',
              title: 'Bad Request',
              status: HttpStatus.BAD_REQUEST,
              detail: 'Verification-email payload failed validation.',
              issues: parsedRequest.error.issues,
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        const result: DownstreamResult = await this.downstream.call({
          service: 'identity',
          path: '/api/v1/auth/verification-emails',
          method: 'POST',
          body: parsedRequest.data,
          traceId: extractTraceId(request),
          idempotencyKey: readIdempotencyKey(request),
        });

        return mapResult(
          result,
          response,
          ResendVerificationEmailResponseSchema,
          'resend-verification',
          extractTraceId(request),
          this.metrics,
        );
      },
    );
  }

  /**
   * TS-309d-followup-1 — the lost-device second step.
   *
   * Sits here rather than on the authenticated MFA proxy for the same reason
   * `mfa/verify` does: it is PRE-AUTH (the caller holds a challenge token, not
   * a session) and it MINTS a session, so it needs the same
   * `runWithoutTenantContext` frame and belongs on the same outcome counter.
   *
   * **Its absence was half of the same defect.** Enrolment hands the customer
   * ten single-use recovery codes; without this route no portal could redeem
   * one, so the codes were a promise the product could not keep — and the
   * scenario they exist for, a lost device, is exactly the one where the
   * customer cannot reach any other route.
   *
   * `sensitive` rate-limit policy, matching `mfa/verify`: a recovery code is a
   * credential, and the endpoint is unauthenticated.
   */
  @Post('mfa/recovery/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'sensitive' })
  async mfaRecoveryVerify(
    @Body() input: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginSessionResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'gateway-pre-auth-mfa-recovery-verify',
      async () => {
        const parsedRequest = MfaRecoveryVerifyRequestSchema.safeParse(input);
        if (!parsedRequest.success) {
          this.metrics.recordCall('mfa-recovery-verify', 'invalid_request');
          throw new HttpException(
            {
              type: 'about:blank',
              title: 'Bad Request',
              status: HttpStatus.BAD_REQUEST,
              detail: 'MFA recovery payload failed validation.',
              issues: parsedRequest.error.issues,
            },
            HttpStatus.BAD_REQUEST,
          );
        }

        const result: DownstreamResult = await this.downstream.call({
          service: 'identity',
          path: '/api/v1/auth/mfa/recovery/verify',
          method: 'POST',
          body: parsedRequest.data,
          traceId: extractTraceId(request),
          idempotencyKey: readIdempotencyKey(request),
        });

        return mapResult(
          result,
          response,
          LoginSessionResponseSchema,
          'mfa-recovery-verify',
          extractTraceId(request),
          this.metrics,
        );
      },
    );
  }
}

/**
 * Render a typed `DownstreamResult` into the HTTP response. Centralised
 * because all three auth surfaces follow the identical mapping table —
 * any drift between them would be a contract bug.
 *
 * On success we (a) propagate every `Set-Cookie` value the downstream
 * minted, then (b) validate the body against the route's response
 * schema. Validation failure surfaces as 502 (the body did not match
 * the contract — a sign of a gateway/identity drift) rather than
 * passing the malformed body through.
 */
function mapResult<TResponse>(
  result: DownstreamResult,
  response: Response,
  schema: {
    safeParse: (input: unknown) => { success: true; data: TResponse } | { success: false };
  },
  surface: AuthProxySurface,
  traceId: string | undefined,
  metrics: AuthProxyMetrics,
): TResponse {
  switch (result.kind) {
    case 'ok': {
      propagateSetCookies(response, result.setCookies);
      const parsed = schema.safeParse(result.body);
      if (!parsed.success) {
        // TS-121-followup-9 — a 200 whose body drifted from the contract is
        // rendered as a 502, which in the status series is indistinguishable
        // from a downstream 5xx. It means something else entirely: deploy
        // skew between the gateway and service-identity.
        metrics.recordCall(surface, 'contract_violation');
        throw new BadGatewayException({
          type: 'about:blank',
          title: 'Bad Gateway',
          status: HttpStatus.BAD_GATEWAY,
          detail: `Downstream service-identity returned a body that does not conform to the ${surface} contract.`,
          ...(traceId !== undefined && { traceId }),
        });
      }
      // The contract's own discriminator is the outcome where it has one:
      // a login challenge and a login session are both 200s.
      metrics.recordCall(surface, outcomeFromBody(parsed.data));
      return parsed.data;
    }
    case 'client_error': {
      // Even on 4xx, the downstream may have set a clearing cookie
      // (e.g. the refresh path clears the cookie on any 401). Propagate
      // before throwing so the cookie state lands in the browser jar.
      propagateSetCookies(response, result.setCookies);
      metrics.recordCall(surface, 'client_error');
      const body = toBodyOrFallback(result.body, 'Downstream client error.');
      throw new HttpException(body, result.status);
    }
    case 'server_error': {
      propagateSetCookies(response, result.setCookies);
      metrics.recordCall(surface, 'server_error');
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-identity returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      metrics.recordCall(surface, 'timeout');
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-identity did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      metrics.recordCall(surface, 'network_error');
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-identity is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      metrics.recordCall(surface, 'not_configured');
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail:
          "Gateway has no route for the 'identity' service. Configure IDENTITY_SERVICE_BASE_URL.",
        ...(traceId !== undefined && { traceId }),
      });
    }
  }
}

function propagateSetCookies(response: Response, setCookies: readonly string[]): void {
  if (setCookies.length === 0) return;
  // Use the underlying header-set so multiple values are emitted as
  // distinct `Set-Cookie` headers (Express's `response.cookie(...)`
  // would re-parse + re-emit, losing the downstream's attribute order).
  response.setHeader('Set-Cookie', [...setCookies]);
}

function toBodyOrFallback(body: unknown, fallbackDetail: string): string | Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {
    type: 'about:blank',
    title: 'Error',
    detail: fallbackDetail,
  };
}

function extractTraceId(request: Request): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function readCookieHeader(request: Request): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  return header;
}

// Idempotency-Key forwarding. TS-510 forwarded the header on `verify-email`
// alone, on the reasoning that it was "the one place on this controller where
// dropping the key changes the outcome rather than just the caching" — the
// token is single-use, so a mail-client link preview spends it and the human's
// click lands as `already_consumed`.
//
// That reasoning was right about verify-email and wrong about the rest, because
// it assumed a gateway-side cache would eventually collapse the other retries.
// There is no such cache. `signup` wears `@Idempotent()` downstream and its key
// was being dropped here, so its replay cache had nothing to key on. All seven
// writes now forward (TS-505d-prep-followup-1); the value is the caller's and
// the gateway's job is to not be the place it dies.

/**
 * Returns `undefined` rather than `null` so the value drops straight into
 * `DownstreamCallOptions.idempotencyKey` (`string | undefined`) without a
 * conditional spread. The spread form is what let the property go missing
 * at 22 call sites — `...(key === null ? {} : { key })` types as an
 * *optional* property, which the write branch of the union now rejects.
 */
function readIdempotencyKey(request: Request): string | undefined {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}
