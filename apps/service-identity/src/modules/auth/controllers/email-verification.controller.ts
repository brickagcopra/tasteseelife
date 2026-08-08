import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UsePipes } from '@nestjs/common';
import {
  ResendVerificationEmailRequestSchema,
  VerifyEmailRequestSchema,
  type ResendVerificationEmailRequest,
  type ResendVerificationEmailResponse,
  type VerifyEmailRequest,
  type VerifyEmailResponse,
} from '@taste-and-see/contracts';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { EmailVerificationService } from '../services/email-verification.service';

/**
 * Email-verification endpoints (TS-510).
 *
 * Its own controller rather than two more methods on `AuthController`: these
 * are the only routes on the auth surface that neither take credentials nor
 * mint a session, and `AuthController` is already 400 lines of cookie and
 * token handling that has nothing to do with them.
 *
 * **Both routes are unauthenticated, and have to be.** The user cannot log in
 * — that is the state verification exists to leave. So the token *is* the
 * authorisation for `verify-email`, and `verification-emails` has no
 * authorisation at all, which is why it discloses nothing (see the service's
 * note on the 202-always contract) and why it sits behind the gateway's
 * `sensitive` rate-limit policy alongside login and signup.
 *
 * **Tenant scoping.** Like signup / login / refresh, these run before any
 * `requestContext` could exist, so the handlers wrap in
 * `runWithoutTenantContext` — the gate would otherwise fire
 * `MissingRequestContextError` on the first model touch (CLAUDE.md §3.2;
 * mirrors the four `pre-auth-*` wraps in `AuthController`).
 */
@Controller('api/v1/auth')
export class EmailVerificationController {
  constructor(
    private readonly emailVerification: EmailVerificationService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  /**
   * POST /api/v1/auth/verify-email — consume a token and activate the account.
   *
   *   200 OK          — token spent; body carries the resulting status.
   *   400 Bad Request — invalid / expired / already-consumed (one shape, three
   *                     `code`s; see `EmailVerificationService`).
   *
   * `@Idempotent()` matters more here than on most writes. A verification link
   * is fetched by mail clients, link previewers and antivirus scanners before
   * the human ever clicks, and the token is single-use — without the replay
   * cache the user's own click would be the *second* request and would fail as
   * already-consumed. The interceptor replays the original 200 for any retry
   * carrying the same `Idempotency-Key`.
   *
   * That covers retries from one client. It does not cover a preview fetch and
   * a human click arriving with no key at all, which is a real risk with real
   * users and is deliberately out of scope here: fixing it properly means a
   * GET-based confirmation page that does not spend the token, which is a
   * portal surface (TS-510-followup-2), not a change to this endpoint.
   */
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(VerifyEmailRequestSchema))
  async verifyEmail(@Body() input: VerifyEmailRequest): Promise<VerifyEmailResponse> {
    return runWithoutTenantContext(this.tenantStore, 'pre-auth-verify-email', () =>
      this.emailVerification.verify(input.token),
    );
  }

  /**
   * POST /api/v1/auth/verification-emails — mint and re-deliver a token.
   *
   *   202 Accepted    — for every address the schema accepts, whether or not
   *                     it belongs to an account awaiting verification.
   *   400 Bad Request — payload failed validation.
   *
   * 202 rather than 200 is the honest code: the work this triggers is an
   * outbox append that `service-notification` drains later, so nothing has
   * been sent by the time the response is written.
   *
   * Not `@Idempotent()`. Re-requesting is the entire purpose of the endpoint,
   * and the response body is a constant — a replay cache would only serve to
   * silently swallow a genuine second request from a user who did not receive
   * the first mail. Abuse is bounded by the gateway's `sensitive` rate-limit
   * policy; a per-address cooldown is TS-510-followup-3.
   */
  @Post('verification-emails')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(ResendVerificationEmailRequestSchema))
  async resendVerificationEmail(
    @Body() input: ResendVerificationEmailRequest,
  ): Promise<ResendVerificationEmailResponse> {
    await runWithoutTenantContext(this.tenantStore, 'pre-auth-resend-verification', () =>
      this.emailVerification.resend(input.email),
    );
    return { accepted: true };
  }
}
