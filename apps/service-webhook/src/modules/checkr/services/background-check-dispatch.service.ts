import { Inject, Injectable, Logger } from '@nestjs/common';
import { withSpan } from '@taste-and-see/tracing';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { type CheckrDispatchOutcome, WebhookMetrics } from '../../../observability/webhook-metrics';
import { PrismaService } from '../../../prisma/prisma.service';

import { BACKGROUND_CHECK_DISPATCH_HEADER_NAME } from '../checkr.constants';
import type { CheckrEventEnvelope } from './checkr-webhook-verifier.service';

/**
 * Internal-dispatch helper that forwards a verified Checkr
 * `report.*` event from service-webhook to service-provider's
 * internal route.
 *
 * **Why this exists.** TS-051 needs Checkr webhook events to land
 * on `provider.provider_background_checks` rows in service-provider.
 * The eventual mechanism is TS-142's outbox relay; until that
 * ships, we use a synchronous HTTP POST. Mirrors the TS-026
 * `StripeIdentityKycDispatchService` shape and rationale (best-
 * effort; failures leave `dispatched_at` null for the future relay
 * to backfill).
 *
 * **No retry inside the dispatcher.** Same reason as TS-026: the
 * Stripe / Checkr webhook ack would otherwise hold open past the
 * sender's tolerance window.
 *
 * **Optional config.** When `BACKGROUND_CHECK_DISPATCH_URL` is
 * unset, this service behaves as a no-op (the relay will dispatch
 * later, or operator tooling will dispatch via a one-shot script).
 *
 * **No PII in logs.** Event id, type, objectId, status, outcome
 * only. Never the payload.
 */
@Injectable()
export class BackgroundCheckDispatchService {
  private readonly logger = new Logger(BackgroundCheckDispatchService.name);
  private readonly dispatchUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    @Inject(ENV_TOKEN) env: Env,
    private readonly prisma: PrismaService,
    // Optional default (TS-051-followup-7) — keeps the two-arg unit-test
    // call sites working; Nest injects the global WebhookMetrics provider.
    // No-op until `initMetrics` runs (kyc-dispatch precedent).
    private readonly metrics: WebhookMetrics = new WebhookMetrics(),
  ) {
    this.dispatchUrl = env.BACKGROUND_CHECK_DISPATCH_URL;
    this.apiKey = env.BACKGROUND_CHECK_DISPATCH_API_KEY;
    this.timeoutMs = env.BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS;
  }

  /**
   * `true` when the event is a `report.*` type we know how to
   * dispatch. Used by the ingress to gate the call.
   */
  static isDispatchable(eventType: string): boolean {
    return eventType.startsWith('report.');
  }

  /**
   * Best-effort dispatch. Returns the outcome string from
   * service-provider (`applied` | `replayed` | `report_mismatch`)
   * when the call succeeded, or `null` when the dispatch was a
   * no-op / failed.
   */
  async dispatch(
    event: CheckrEventEnvelope,
    payload: unknown,
  ): Promise<'applied' | 'replayed' | 'report_mismatch' | null> {
    return withSpan('checkr.dispatch', async (span) => {
      span.setAttribute('checkr.event_type', event.type);

      if (this.dispatchUrl === undefined || this.apiKey === undefined) {
        this.logger.debug(
          { eventId: event.id, eventType: event.type },
          'bg-dispatch: BACKGROUND_CHECK_DISPATCH_URL unset, skipping',
        );
        this.metrics.recordCheckrDispatch('skipped');
        span.setAttribute('checkr.dispatch_outcome', 'skipped');
        return null;
      }
      if (!BackgroundCheckDispatchService.isDispatchable(event.type)) {
        // Defensive — the ingress should have gated this call.
        this.metrics.recordCheckrDispatch('skipped');
        span.setAttribute('checkr.dispatch_outcome', 'skipped');
        return null;
      }
      if (event.object.candidateId === null) {
        // We need a candidate id to round-trip to the local row;
        // events that don't carry one are typically `candidate.*`
        // events (not `report.*`) and shouldn't reach the dispatcher
        // anyway — defensive guard.
        this.logger.warn(
          { eventId: event.id, eventType: event.type, objectId: event.object.id },
          'bg-dispatch: event missing candidate_id, skipping',
        );
        this.metrics.recordCheckrDispatch('skipped');
        span.setAttribute('checkr.dispatch_outcome', 'skipped');
        return null;
      }
      if (event.object.status === null) {
        this.logger.warn(
          { eventId: event.id, eventType: event.type, objectId: event.object.id },
          'bg-dispatch: event missing status, skipping',
        );
        this.metrics.recordCheckrDispatch('skipped');
        span.setAttribute('checkr.dispatch_outcome', 'skipped');
        return null;
      }

      const body = {
        eventId: event.id,
        eventType: event.type,
        eventCreatedSeconds: event.createdSeconds,
        report: {
          id: event.object.id,
          candidateId: event.object.candidateId,
          status: event.object.status,
        },
        rawPayload: JSON.stringify(payload),
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
            [BACKGROUND_CHECK_DISPATCH_HEADER_NAME]: this.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (cause) {
        this.logger.warn(
          { eventId: event.id, err: errorMessage(cause) },
          'bg-dispatch: network failure',
        );
        this.recordOutcome(span, 'network_error', startNs);
        return null;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        this.logger.warn(
          { eventId: event.id, status: response.status },
          'bg-dispatch: service-provider returned non-2xx',
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
          'bg-dispatch: failed to parse service-provider response',
        );
        this.recordOutcome(span, 'bad_response', startNs);
        return null;
      }
      const outcome = isKnownOutcome(parsed.outcome) ? parsed.outcome : null;
      if (outcome === null) {
        this.logger.warn(
          { eventId: event.id, outcome: parsed.outcome },
          'bg-dispatch: service-provider returned unknown outcome',
        );
        this.recordOutcome(span, 'bad_response', startNs);
        return null;
      }

      this.logger.log({ eventId: event.id, eventType: event.type, outcome }, 'bg-dispatch: ok');
      this.recordOutcome(span, outcome, startNs);
      return outcome;
    });
  }

  /**
   * Record the dispatch outcome counter + latency histogram (CLAUDE.md
   * §10). `startNs` is the `process.hrtime.bigint()` taken just before
   * the `fetch`, so the latency reflects the HTTP round-trip; the
   * `skipped` no-op paths don't call this (they never made a request).
   * Mirrors `StripeIdentityKycDispatchService.recordOutcome`.
   */
  private recordOutcome(
    span: { setAttribute(key: string, value: string): void },
    outcome: CheckrDispatchOutcome,
    startNs: bigint,
  ): void {
    const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    span.setAttribute('checkr.dispatch_outcome', outcome);
    this.metrics.recordCheckrDispatch(outcome, seconds);
  }

  /**
   * Stamp `dispatched_at = now()` on the matching event row.
   */
  async markDispatched(eventId: string): Promise<void> {
    try {
      await this.prisma.checkrProcessedEvent.update({
        where: { eventId },
        data: { dispatchedAt: new Date() },
      });
    } catch (cause) {
      this.logger.warn(
        { eventId, err: errorMessage(cause) },
        'bg-dispatch: failed to stamp dispatched_at',
      );
    }
  }
}

function isKnownOutcome(value: unknown): value is 'applied' | 'replayed' | 'report_mismatch' {
  return value === 'applied' || value === 'replayed' || value === 'report_mismatch';
}

function errorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const m = (cause as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'unknown error';
}
