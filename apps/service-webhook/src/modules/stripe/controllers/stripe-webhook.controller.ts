import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { WebhookMetrics } from '../../../observability/webhook-metrics';
import { StripeIngressService } from '../services/stripe-ingress.service';
import { StripeWebhookVerifierService } from '../services/stripe-webhook-verifier.service';
import { STRIPE_WEBHOOK_PATH } from '../stripe.constants';

interface WebhookAckResponse {
  readonly received: true;
  readonly eventId: string;
  readonly outcome: 'persisted' | 'duplicate';
}

/**
 * Inbound Stripe webhook endpoint.
 *
 * `POST /api/v1/webhooks/stripe` is the single URL Stripe POSTs to from
 * its edge for every event the configured webhook endpoint subscribes to.
 * The path is registered in the Stripe Dashboard (Developers → Webhooks)
 * and printed by `stripe listen --forward-to ...` in local development.
 *
 * Flow on every request:
 *   1. Extract the verified raw body (the `express.raw` parser in main.ts
 *      gives us a `Buffer` on `req.body`).
 *   2. Extract the `Stripe-Signature` header.
 *   3. Hand both to `StripeWebhookVerifierService.verify`.
 *      - Failure → 400 RFC 7807 body (the global filter shapes it). We
 *        deliberately keep the response body terse — "signature
 *        verification failed" — so an attacker probing the endpoint
 *        learns nothing about which check failed. The verifier service
 *        logs the precise reason server-side.
 *      - Success → step 4.
 *   4. Hand the verified event to `StripeIngressService.persist`.
 *      - First time → `'persisted'`, status 200, future dispatch via
 *        TS-142 outbox relay.
 *      - Duplicate (Stripe retry; manual Dashboard replay) → `'duplicate'`,
 *        status 200, no-op. Indistinguishable to Stripe from a fresh ack.
 *
 * Anonymous by design: webhook signature verification IS the auth model
 * for this endpoint (CLAUDE.md §3.5 / §17.8). An access token would be
 * meaningless — Stripe's edge does not log in as a user.
 *
 * No `Idempotency-Key` header plumbing: the inbound contract Stripe sends
 * is keyed on `event.id`, which we persist and use as the idempotency
 * primary key directly. The `Idempotency-Key` header convention applies
 * to *outbound* writes initiated by our own clients (CLAUDE.md §3.3) —
 * the situation here is the reverse.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). This endpoint
 * runs BEFORE any `requestContext` exists — Stripe's edge does not log
 * in as a Taste & See user, so the `TenantContextInterceptor` cannot
 * seed a scoped frame. The handler body is wrapped in
 * `runWithoutTenantContext(..., 'external-stripe-webhook-receive', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The wrap
 * encloses the raw-body assertion + the 400 throw + the signature
 * verification + the 400 throw + the `ingress.persist` call so a future
 * maintainer cannot accidentally hoist a Prisma call out of the wrap by
 * adding "just one tiny read" between collaborator return and response
 * construction. Mirrors the canonical shape landed in `service-identity`'s
 * `KycController.receiveWebhookEvent` and `service-provider`'s
 * `ApplicationsController.receiveWebhookEvent` under TS-020-followup-2b.
 */
@Controller()
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly verifier: StripeWebhookVerifierService,
    private readonly ingress: StripeIngressService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
    // Optional default (TS-041a-followup-4) so the existing unit tests
    // that construct the controller with three args keep working — Nest
    // injects the real singleton (exported from the @Global
    // ObservabilityModule) in production; the `new WebhookMetrics()`
    // default is a no-op-instrument fallback for manual construction.
    // Mirrors the JanitorMetrics optional-default pattern (TS-022-followup-3a).
    private readonly metrics: WebhookMetrics = new WebhookMetrics(),
  ) {}

  @Post(STRIPE_WEBHOOK_PATH)
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: Request,
    @Headers('stripe-signature') signatureHeader: string | string[] | undefined,
  ): Promise<WebhookAckResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'external-stripe-webhook-receive',
      async () => {
        // `express.raw({ type: 'application/json' })` populates `req.body`
        // with a `Buffer`. Anything else is a misconfiguration of main.ts;
        // we'd rather 400 and shout in the logs than silently accept.
        const rawBody = request.body;
        if (!Buffer.isBuffer(rawBody)) {
          this.logger.error(
            { contentType: request.headers['content-type'] },
            'stripe webhook received without raw body — main.ts wiring is broken',
          );
          this.metrics.recordStripeVerification('reject', 'missing_raw_body');
          throw new BadRequestException(badSignatureBody());
        }

        const verification = this.verifier.verify({ rawBody, signatureHeader });
        if (!verification.ok) {
          this.metrics.recordStripeVerification('reject', verification.reason);
          throw new BadRequestException(badSignatureBody());
        }
        this.metrics.recordStripeVerification('ok', 'none');

        const outcome = await this.ingress.persist({
          event: verification.event,
          verifiedAt: verification.verifiedAt,
        });
        this.metrics.recordStripePersisted(outcome);

        return {
          received: true,
          eventId: verification.event.id,
          outcome,
        };
      },
    );
  }
}

/**
 * Body shape for every signature-related rejection. Terse on purpose:
 * an attacker probing the endpoint learns "your signature didn't pass"
 * and nothing about which specific check failed. The verifier service
 * already logged the precise reason server-side; ops can correlate via
 * traceId on the 7807 envelope the global filter attaches.
 */
function badSignatureBody(): {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Bad Request',
    status: 400,
    detail: 'Stripe webhook signature verification failed.',
  };
}
