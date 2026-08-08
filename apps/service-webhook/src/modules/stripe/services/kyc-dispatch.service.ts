import { Inject, Injectable, Logger } from '@nestjs/common';
import { withSpan } from '@taste-and-see/tracing';
import type Stripe from 'stripe';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { type KycDispatchOutcome, WebhookMetrics } from '../../../observability/webhook-metrics';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Internal-dispatch helper that forwards a verified
 * `identity.verification_session.*` Stripe event from
 * service-webhook to service-identity.
 *
 * **Why this exists.** TS-026 (KYC) needs Stripe Identity webhook
 * events to land on `identity.kyc_records` rows in service-identity.
 * The eventual mechanism is TS-142's outbox relay; until that ships,
 * we use a synchronous HTTP POST from this service to service-
 * identity's internal route. The dispatch is best-effort:
 *
 *   - On 2xx (`applied` | `replayed` | `session_mismatch`) we stamp
 *     `dispatched_at = now()` on the `webhook.stripe_processed_events`
 *     row. The future relay then skips it.
 *
 *   - On any non-2xx, timeout, or thrown error we LEAVE
 *     `dispatched_at` null. The Stripe webhook still returns 200 (we
 *     already persisted the event in `StripeIngressService.persist`),
 *     and the future TS-142 relay backfills the dispatch from the
 *     undispatched-events query. The pre-relay window means a
 *     dispatch failure today translates into a delayed `kyc_records`
 *     update — never a silent loss.
 *
 * **No retry inside the dispatcher.** A failed dispatch is logged at
 * warn level and the row stays undispatched. We deliberately don't
 * implement a retry loop here because (a) the relay will own that
 * concern soon and (b) retrying inside the Stripe webhook HTTP
 * handler would hold the ack open past Stripe's tolerance window
 * and risk Stripe marking the endpoint as unhealthy.
 *
 * **Optional config.** When `KYC_DISPATCH_URL` is unset, this service
 * behaves as a no-op (the relay will dispatch later, or operator
 * tooling will dispatch via a one-shot script). The local-dev /
 * CI runbook leaves the config unset by default.
 *
 * **No PII in logs.** We log the event id, type, sessionId, status,
 * and the outcome string we received from service-identity. We
 * never log the payload (CLAUDE.md §3.9).
 */
@Injectable()
export class StripeIdentityKycDispatchService {
  private readonly logger = new Logger(StripeIdentityKycDispatchService.name);
  private readonly dispatchUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    @Inject(ENV_TOKEN) env: Env,
    private readonly prisma: PrismaService,
    // Optional so the two-arg unit-test call sites keep working; the
    // Nest DI graph injects the global `WebhookMetrics` provider. No-op
    // until `initMetrics` runs (controller / JanitorMetrics precedent).
    private readonly metrics: WebhookMetrics = new WebhookMetrics(),
  ) {
    this.dispatchUrl = env.KYC_DISPATCH_URL;
    this.apiKey = env.KYC_DISPATCH_API_KEY;
    this.timeoutMs = env.KYC_DISPATCH_TIMEOUT_MS;
  }

  /**
   * `true` when the event is an `identity.verification_session.*`
   * type we know how to dispatch. Used by the ingress to decide
   * whether to call `dispatch` at all.
   */
  static isDispatchable(eventType: string): boolean {
    return eventType.startsWith('identity.verification_session.');
  }

  /**
   * Best-effort dispatch. Returns the outcome string from
   * service-identity (`applied` | `replayed` | `session_mismatch`)
   * when the call succeeded, or `null` when the dispatch was a
   * no-op / failed. The caller uses the return value only to decide
   * whether to stamp `dispatched_at`.
   */
  async dispatch(event: Stripe.Event): Promise<'applied' | 'replayed' | 'session_mismatch' | null> {
    return withSpan('kyc.dispatch', async (span) => {
      span.setAttribute('kyc.event_type', event.type);

      if (this.dispatchUrl === undefined || this.apiKey === undefined) {
        // No-op mode — the future relay will pick up the undispatched row.
        this.logger.debug(
          { eventId: event.id, eventType: event.type },
          'kyc-dispatch: KYC_DISPATCH_URL unset, skipping',
        );
        this.metrics.recordKycDispatch('skipped');
        span.setAttribute('kyc.dispatch_outcome', 'skipped');
        return null;
      }
      if (!StripeIdentityKycDispatchService.isDispatchable(event.type)) {
        // Defensive — the ingress should have gated this call.
        this.metrics.recordKycDispatch('skipped');
        span.setAttribute('kyc.dispatch_outcome', 'skipped');
        return null;
      }

      const session = event.data.object as Stripe.Identity.VerificationSession;
      const body = {
        eventId: event.id,
        eventType: event.type,
        eventCreatedSeconds: event.created,
        session: {
          id: session.id,
          status: session.status,
          clientSecret: session.client_secret ?? null,
          hostedUrl: session.url ?? null,
          verifiedAtSeconds: session.status === 'verified' ? session.created : null,
        },
        rawPayload: JSON.stringify(session),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const startNs = process.hrtime.bigint();
      let response: Response;
      try {
        response = await fetch(this.dispatchUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // The header name has to match the constant in
            // service-identity (`KYC_DISPATCH_HEADER_NAME` =
            // 'x-kyc-internal-api-key'). We hard-code the string
            // here rather than depending on service-identity's
            // package — cross-service constants are routinely
            // duplicated in this codebase (CLAUDE.md §2.3 — no
            // cross-service imports of internal code).
            'x-kyc-internal-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (cause) {
        this.logger.warn(
          {
            eventId: event.id,
            eventType: event.type,
            err: errorMessage(cause),
          },
          'kyc-dispatch: network failure',
        );
        this.recordOutcome(span, 'network_error', startNs);
        return null;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        this.logger.warn(
          {
            eventId: event.id,
            eventType: event.type,
            status: response.status,
          },
          'kyc-dispatch: service-identity returned non-2xx',
        );
        this.recordOutcome(span, 'http_error', startNs);
        return null;
      }

      let parsed: { outcome?: unknown };
      try {
        parsed = (await response.json()) as { outcome?: unknown };
      } catch (cause) {
        this.logger.warn(
          { eventId: event.id, err: errorMessage(cause) },
          'kyc-dispatch: failed to parse service-identity response',
        );
        this.recordOutcome(span, 'bad_response', startNs);
        return null;
      }
      const outcome = isKnownOutcome(parsed.outcome) ? parsed.outcome : null;
      if (outcome === null) {
        this.logger.warn(
          { eventId: event.id, outcome: parsed.outcome },
          'kyc-dispatch: service-identity returned unknown outcome',
        );
        this.recordOutcome(span, 'bad_response', startNs);
        return null;
      }

      this.logger.log({ eventId: event.id, eventType: event.type, outcome }, 'kyc-dispatch: ok');
      this.recordOutcome(span, outcome, startNs);
      return outcome;
    });
  }

  /**
   * Record the dispatch outcome counter + latency histogram (CLAUDE.md
   * §10). `startNs` is the `process.hrtime.bigint()` taken just before
   * the `fetch` so the latency reflects the HTTP round-trip; the
   * `skipped` no-op path doesn't call this (it never made a request).
   */
  private recordOutcome(
    span: { setAttribute(key: string, value: string): void },
    outcome: KycDispatchOutcome,
    startNs: bigint,
  ): void {
    const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    span.setAttribute('kyc.dispatch_outcome', outcome);
    this.metrics.recordKycDispatch(outcome, seconds);
  }

  /**
   * Stamp `dispatched_at = now()` on the matching event row. Called
   * by the ingress after a successful dispatch. Best-effort; a
   * failure here logs at warn but does not throw — the event has
   * already been persisted and the response to Stripe is already in
   * flight.
   */
  async markDispatched(eventId: string): Promise<void> {
    try {
      await this.prisma.stripeProcessedEvent.update({
        where: { eventId },
        data: { dispatchedAt: new Date() },
      });
    } catch (cause) {
      this.logger.warn(
        { eventId, err: errorMessage(cause) },
        'kyc-dispatch: failed to stamp dispatched_at',
      );
    }
  }
}

function isKnownOutcome(value: unknown): value is 'applied' | 'replayed' | 'session_mismatch' {
  return value === 'applied' || value === 'replayed' || value === 'session_mismatch';
}

function errorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const m = (cause as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'unknown error';
}
