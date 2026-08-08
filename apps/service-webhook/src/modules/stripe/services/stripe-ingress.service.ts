import { Injectable, Logger } from '@nestjs/common';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import type Stripe from 'stripe';

import { WebhookMetrics } from '../../../observability/webhook-metrics';
import { PrismaService } from '../../../prisma/prisma.service';
import { StripeIdentityKycDispatchService } from './kyc-dispatch.service';
import { mapStripeEventToOutbox, type StripeRelayAppend } from './stripe-event-relay';

/**
 * The outcome of an ingress attempt. Surfaced to the controller so it can
 * distinguish first-time persistence (200 OK + future dispatch) from a
 * duplicate replay (200 OK + no-op).
 *
 * Stripe retries delivery for up to 3 days on 5xx responses and will also
 * replay an event when an operator clicks "Resend" in the Dashboard. Both
 * cases land on the duplicate path — the goal here is that they are
 * indistinguishable to Stripe (200 ack) and a no-op for us downstream
 * (CLAUDE.md §6 / §17.8 / §3.5).
 */
export type StripeIngressOutcome = 'persisted' | 'duplicate';

/**
 * Raised when the outbox rejects a relay payload (TS-041a-followup-2).
 *
 * Thrown INSIDE the ingress transaction so the `stripe_processed_events` row
 * rolls back with it. That pairing is the point: if we cannot durably queue
 * "this subscription changed", we must not record "we have seen this event"
 * either — the ingress row's primary key is what makes a Stripe redelivery a
 * no-op, so committing it after a failed append would turn a retryable
 * failure into a permanently lost billing event.
 */
export class StripeRelayAppendFailedError extends Error {
  constructor(
    readonly eventName: string,
    readonly stripeEventId: string,
    readonly issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
  ) {
    super(
      `outbox rejected ${eventName} for stripe event ${stripeEventId}: ${issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'StripeRelayAppendFailedError';
  }
}

/**
 * Persists a verified Stripe event row, idempotent on `event.id`.
 *
 * **Idempotency strategy**: insert-and-catch on the primary key. The
 * happy path is one INSERT; the duplicate path is one INSERT that hits
 * P2002 (unique-constraint violation) and is caught here. We deliberately
 * avoid the "SELECT then INSERT" anti-pattern — two concurrent webhook
 * deliveries of the same event id (Stripe retries can overlap when our
 * pod is slow) would both pass the SELECT and both attempt INSERT,
 * relying on the same constraint anyway. Insert-and-catch surfaces the
 * race correctly in one round-trip.
 *
 * **No PII in logs**: we log the event id, type, livemode, and outcome.
 * We never log the payload — Stripe events can include `customer.email`,
 * payment method `last4`, billing addresses, and other PII (CLAUDE.md
 * §3.9 / §17.2).
 *
 * **Relayed billing events (TS-041a-followup-2)**: allow-listed
 * subscription / invoice / payment-method event types additionally
 * append a `stripe.*` platform event to `webhook.outbox_events` **in
 * the same transaction as the ingress row**, which the TS-142 relay
 * forwards to `service-subscription`. The payload carries opaque
 * Stripe handles only — never the event body — and the consumer
 * re-fetches from Stripe; see
 * `packages/contracts/src/events/stripe-billing.ts` for why that is
 * both a PII and a correctness decision. Every other event type still
 * stops at "persist"; the KYC hop below remains its own pre-relay
 * synchronous path (TS-026-followup-1 migrates it).
 */
@Injectable()
export class StripeIngressService {
  private readonly logger = new Logger(StripeIngressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kycDispatch: StripeIdentityKycDispatchService,
    private readonly outbox: OutboxService,
    private readonly metrics: WebhookMetrics,
  ) {}

  async persist(args: {
    readonly event: Stripe.Event;
    readonly verifiedAt: Date;
  }): Promise<StripeIngressOutcome> {
    const { event, verifiedAt } = args;

    // Mapped BEFORE the transaction opens. It is pure, and a
    // `StripeRelayMappingError` here should not have held a database
    // connection open to discover itself.
    const relay = mapStripeEventToOutbox(event);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.stripeProcessedEvent.create({
          data: {
            eventId: event.id,
            eventType: event.type,
            apiVersion: event.api_version ?? null,
            livemode: event.livemode,
            requestId: extractRequestId(event),
            // Stripe.Event is structurally a JSON value (plain objects,
            // arrays, and primitives — Stripe's wire format guarantees
            // this) but its TS type carries unknown-shaped `data.object`
            // discriminated-union branches that don't satisfy Prisma's
            // `InputJsonValue` constraint. We cast at this single boundary
            // — the verifier upstream already proved the bytes round-trip
            // as JSON. CLAUDE.md §2.1 (Result/cast at boundaries) and the
            // duck-typed Prisma error narrowing below share the same
            // tsconfig-driven rationale as TS-021-followup-2.
            //
            // The `as unknown as object` shape sidesteps the unresolved
            // `Prisma.InputJsonValue` namespace export in our tsconfig
            // (TS-021-followup-3 captures the broader namespace issue);
            // Prisma accepts any structurally-JSON value at runtime.
            payload: event as unknown as object,
            signatureVerifiedAt: verifiedAt,
          },
        });

        if (relay !== null) {
          await this.appendRelay(tx as unknown as OutboxRawExecutor, event, relay);
        }
      });

      this.logger.log(
        {
          eventId: event.id,
          eventType: event.type,
          livemode: event.livemode,
          outcome: 'persisted',
          relayedAs: relay?.eventName ?? null,
        },
        'stripe event persisted',
      );

      // TS-026 — synchronous best-effort dispatch for
      // identity.verification_session.* events to service-identity.
      // The dispatcher is no-op when KYC_DISPATCH_URL is unset, and
      // best-effort otherwise (any failure leaves dispatched_at null
      // for the future TS-142 relay to backfill). This call lives
      // here rather than in the controller so the persist + dispatch
      // pair is co-located with the row's lifecycle — keeps the
      // controller a thin orchestration layer (CLAUDE.md §2.3).
      if (StripeIdentityKycDispatchService.isDispatchable(event.type)) {
        const outcome = await this.kycDispatch.dispatch(event);
        if (outcome !== null) {
          await this.kycDispatch.markDispatched(event.id);
        }
      }

      return 'persisted';
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        this.logger.log(
          {
            eventId: event.id,
            eventType: event.type,
            livemode: event.livemode,
            outcome: 'duplicate',
          },
          'stripe event duplicate (already persisted)',
        );
        return 'duplicate';
      }
      // Any other DB error bubbles to the controller's filter chain
      // (RFC 7807 500). The controller never logs `err.message` to the
      // client — only the global RfcProblemFilter does, with a generic
      // detail body.
      throw err;
    }
  }

  /**
   * Append the relay event inside the caller's transaction.
   *
   * `occurredAt` is Stripe's `created`, matching the payload envelope: the
   * outbox row and the payload must not disagree about when the event
   * happened, or a consumer that trusts one and a dashboard that reads the
   * other will tell different stories about the same redelivery.
   */
  private async appendRelay(
    tx: OutboxRawExecutor,
    event: Stripe.Event,
    relay: StripeRelayAppend,
  ): Promise<void> {
    const result = await this.outbox.append(tx, {
      eventName: relay.eventName,
      payload: relay.payload,
      eventId: relay.payload.eventId,
      occurredAt: new Date(event.created * 1000),
    });

    if (result.kind !== 'appended') {
      throw new StripeRelayAppendFailedError(relay.eventName, event.id, result.issues);
    }

    this.metrics.recordStripeRelayAppended(relay.eventName);
  }
}

function extractRequestId(event: Stripe.Event): string | null {
  // Defensively typed as `unknown` — Stripe.Event.request's current SDK
  // types are `{ id, idempotency_key } | null` but older Stripe API
  // versions encoded it as a bare string. We accept either shape so a
  // replayed legacy event from the Stripe Dashboard doesn't crash the
  // ingress path on a TypeError.
  const request: unknown = event.request;
  if (request === null || request === undefined) {
    return null;
  }
  if (typeof request === 'string') {
    return request.length === 0 ? null : request;
  }
  if (typeof request === 'object' && 'id' in request) {
    const id = (request as { id: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }
  return null;
}

/**
 * `Prisma.PrismaClientKnownRequestError` with `code === 'P2002'` is the
 * unique-constraint violation we expect on duplicate event id replays.
 *
 * Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError`
 * because the value-side of `Prisma`'s namespace resolves inconsistently
 * under our `verbatimModuleSyntax: false` / `isolatedModules: true`
 * tsconfig — same root cause as TS-021-followup-2 in service-identity.
 * Revisit on the next Prisma minor bump.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; name?: unknown };
  return candidate.code === 'P2002' && candidate.name === 'PrismaClientKnownRequestError';
}
