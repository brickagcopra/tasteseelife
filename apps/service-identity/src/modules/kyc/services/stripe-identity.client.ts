import { Inject, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';

import { STRIPE_SDK_TOKEN } from '../kyc.constants';
import { err, ok, type Result } from './result';

/**
 * Failure shapes returned by `StripeIdentityClient`. Modelled as a
 * discriminated union so callers can branch on the specific reason
 * without inspecting raw Stripe error shapes (CLAUDE.md §2.1).
 */
export type StripeIdentityFailure =
  | { readonly reason: 'stripe_unavailable'; readonly cause: unknown }
  | { readonly reason: 'invalid_request'; readonly message: string };

export interface CreateVerificationSessionInput {
  /**
   * Platform `users.id`. Stamped onto Stripe's
   * `metadata.platform_user_id` for cross-system traceability.
   */
  readonly userId: string;
  /**
   * URL Stripe redirects to after the user completes (or abandons)
   * the hosted flow. Validated at env-load time
   * (`STRIPE_IDENTITY_RETURN_URL`).
   */
  readonly returnUrl: string;
  /**
   * Optional human label surfaced in the Stripe Dashboard's session
   * list — useful for ops triage.
   */
  readonly label?: string;
  /**
   * Idempotency key forwarded to Stripe's `Idempotency-Key` header so
   * a network retry within Stripe's 24h dedup window returns the same
   * verification session rather than creating a duplicate. Separate
   * from the Redis-backed CLAUDE.md §3.3 replay cache on our own
   * endpoint.
   */
  readonly idempotencyKey?: string;
}

/**
 * Subset of Stripe's `Identity.VerificationSession` shape we surface
 * to callers. The full SDK type carries dozens of fields and discriminated
 * subtypes; this projection captures only what the persistence + response
 * layers need, keeping the Stripe-SDK boundary thin.
 */
export interface StripeIdentitySession {
  readonly id: string;
  readonly status: Stripe.Identity.VerificationSession.Status;
  /**
   * Short-lived secret the client SDK uses to open the embedded modal.
   * Null when Stripe declines to mint one (e.g. session is in a
   * terminal state). Surface as-is to the caller — never log.
   */
  readonly clientSecret: string | null;
  /**
   * Hosted Stripe-Identity URL the user can be redirected to as a
   * fallback when the embedded modal is unavailable.
   */
  readonly hostedUrl: string | null;
  /**
   * Set on the transition into `verified`. Null otherwise.
   */
  readonly verifiedAtSeconds: number | null;
}

/**
 * Thin wrapper around `stripe.identity.verificationSessions.create`
 * + `.retrieve`. Exists to:
 *
 *   1. Project the Stripe SDK's wide-shouldered type into a narrow
 *      `StripeIdentitySession` the rest of the module consumes — the
 *      Stripe SDK boundary stops here.
 *   2. Convert Stripe-thrown errors into `Result<_, StripeIdentityFailure>`
 *      so the call site cannot swallow them with a generic catch
 *      (CLAUDE.md §2.1 / §3.9).
 *   3. Centralise the `metadata` shape we stamp on every session —
 *      `platform_user_id` is what links a Stripe row back to our
 *      `users.id` without leaking PII into the request body.
 *
 * **Authentication scope.** `STRIPE_SECRET_KEY` is the only credential
 * Stripe needs for these calls. The same key is used in
 * service-subscription's outbound Stripe calls — they share the Stripe
 * account but each service constructs its own SDK instance.
 *
 * **No PII in logs.** We log the session id, status, and the platform
 * userId. We never log the Stripe payload — it can include document
 * type, last4 of an ID, and the verified name (CLAUDE.md §3.9).
 */
@Injectable()
export class StripeIdentityClient {
  private readonly logger = new Logger(StripeIdentityClient.name);

  constructor(@Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe) {}

  async createVerificationSession(
    input: CreateVerificationSessionInput,
  ): Promise<Result<StripeIdentitySession, StripeIdentityFailure>> {
    if (input.userId.length === 0) {
      return err({ reason: 'invalid_request', message: 'userId is required' });
    }
    if (input.returnUrl.length === 0) {
      return err({ reason: 'invalid_request', message: 'returnUrl is required' });
    }

    let session: Stripe.Identity.VerificationSession;
    try {
      session = await this.stripe.identity.verificationSessions.create(
        {
          type: 'document',
          metadata: {
            platform_user_id: input.userId,
            ...(input.label !== undefined && { platform_label: input.label }),
          },
          return_url: input.returnUrl,
        },
        {
          ...(input.idempotencyKey !== undefined && {
            idempotencyKey: input.idempotencyKey,
          }),
        },
      );
    } catch (cause) {
      this.logger.warn(
        { userId: input.userId, err: stripeErrorMessage(cause) },
        'stripe-identity.create failed',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    this.logger.log(
      {
        userId: input.userId,
        sessionId: session.id,
        status: session.status,
      },
      'stripe-identity.create ok',
    );
    return ok(project(session));
  }

  async retrieveVerificationSession(
    sessionId: string,
  ): Promise<Result<StripeIdentitySession, StripeIdentityFailure>> {
    if (sessionId.length === 0) {
      return err({ reason: 'invalid_request', message: 'sessionId is required' });
    }

    let session: Stripe.Identity.VerificationSession;
    try {
      session = await this.stripe.identity.verificationSessions.retrieve(sessionId);
    } catch (cause) {
      this.logger.warn(
        { sessionId, err: stripeErrorMessage(cause) },
        'stripe-identity.retrieve failed',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    return ok(project(session));
  }
}

function project(session: Stripe.Identity.VerificationSession): StripeIdentitySession {
  return {
    id: session.id,
    status: session.status,
    // Stripe types `client_secret` as `string | null` — verified rows
    // and canceled rows have no usable secret.
    clientSecret: session.client_secret ?? null,
    // Stripe types `url` as `string | null` — only set while the
    // hosted flow is available.
    hostedUrl: session.url ?? null,
    // `verified_outputs` is set when status === 'verified'; we treat
    // `last_verification_report` presence as the canonical signal.
    // Stripe doesn't emit a flat `verifiedAt` timestamp on the
    // session — we use `created` as a coarse proxy for verified
    // sessions (the verification completes after creation but
    // before the webhook lands), and the KycService overlays the
    // precise verifiedAt from the webhook event timestamp.
    verifiedAtSeconds: session.status === 'verified' ? session.created : null,
  };
}

/**
 * Defensive narrowing of an unknown Stripe-thrown value to a log-safe
 * string. The Stripe SDK throws `StripeError` instances with a
 * `.message` field; a non-Error value becomes the literal string
 * `unknown stripe error`. Mirrors the helper in
 * service-subscription's StripeCustomerService — duplicated rather
 * than shared because the helper is six lines and the shared-package
 * pattern is not worth a workspace dependency for cross-service
 * defensive code.
 */
function stripeErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown stripe error';
}
