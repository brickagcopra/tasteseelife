import { Inject, Injectable, Logger } from '@nestjs/common';
import { withSpan } from '@taste-and-see/tracing';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  KycMetrics,
  type KycSessionOutcome,
  type KycWebhookOutcome,
  normalizeKycEventTypeLabel,
} from '../kyc-metrics';

/**
 * Local KYC enum mirrors. Same root cause as TS-021-followup-2 /
 * -followup-3: the `@prisma/client` namespace re-exports type aliases
 * for the generated enums but does not surface them cleanly under our
 * `moduleResolution: "Node"` tsconfig. Following the established
 * convention in this codebase (see `MfaMethodRow` etc.), we declare
 * the equivalent string-literal unions locally. Drift between this
 * file and the Prisma schema would surface at the first call that
 * passes a non-listed string to Prisma — the test suite cross-pins
 * the surface by asserting each status path.
 */
export type KycRecordStatus =
  | 'pending'
  | 'processing'
  | 'verified'
  | 'requires_input'
  | 'failed'
  | 'canceled';

export type KycRecordProvider = 'stripe_identity';

/**
 * Local mirror of the Prisma-generated `KycRecord` shape, kept narrow
 * to what this service actually reads / writes. Adding a column to
 * `schema.prisma` requires extending this interface too.
 */
export interface KycRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: KycRecordProvider;
  readonly status: KycRecordStatus;
  readonly externalId: string;
  readonly payloadCiphertext: Buffer | null;
  readonly payloadIv: Buffer | null;
  readonly payloadAuthTag: Buffer | null;
  readonly payloadKeyVersion: number | null;
  readonly lastEventId: string | null;
  readonly verifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

import { KycPayloadCipherService } from './kyc-payload-cipher.service';
import {
  StripeIdentityClient,
  type StripeIdentityFailure,
  type StripeIdentitySession,
} from './stripe-identity.client';
import { err, ok, type Result } from './result';

/**
 * Failure shapes returned by `KycService`. Modelled as a discriminated
 * union so the controller's `throwFailure` switch is exhaustive.
 */
export type KycServiceFailure =
  | { readonly reason: 'stripe_unavailable'; readonly cause: unknown }
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'record_not_found' }
  | { readonly reason: 'session_mismatch'; readonly externalId: string }
  | { readonly reason: 'event_replay'; readonly eventId: string };

export interface StartSessionInput {
  readonly userId: string;
  /**
   * Optional Idempotency-Key forwarded both to our local replay cache
   * (via `@Idempotent()`) AND to Stripe's `Idempotency-Key` header so
   * a retried POST that crashed mid-flight returns the same Stripe
   * session rather than creating a duplicate.
   */
  readonly idempotencyKey?: string;
  /**
   * Optional admin label propagated as Stripe metadata.platform_label.
   */
  readonly label?: string;
}

export interface StartSessionResult {
  readonly record: KycRecord;
  readonly clientSecret: string | null;
  readonly hostedUrl: string | null;
}

export interface ApplyWebhookEventInput {
  /**
   * Stripe `event.id`. Used both for idempotency (short-circuit if
   * `lastEventId == event.id`) and for the audit trail on the row.
   */
  readonly eventId: string;
  /**
   * Stripe `event.type` (e.g. `identity.verification_session.verified`).
   * Drives the status transition.
   */
  readonly eventType: string;
  /**
   * The `data.object` payload — the full Stripe
   * `Identity.VerificationSession`. Stored at-rest as an encrypted
   * blob; the small projection on the row (status, verifiedAt) is
   * derived here.
   */
  readonly session: StripeIdentitySession;
  /**
   * Stripe `event.created` (Unix seconds). Used to populate
   * `verifiedAt` on the transition into `verified`.
   */
  readonly eventCreatedSeconds: number;
  /**
   * Raw JSON of the Stripe event we want to persist alongside the
   * row. Encrypted at rest via `KycPayloadCipherService`. Caller is
   * responsible for `JSON.stringify` (we keep the signature plain to
   * make testing trivial).
   */
  readonly rawPayload: string;
}

/**
 * Maps Stripe `Identity.VerificationSession.Status` (the SDK
 * discriminated-union string) to our Prisma `KycStatus` enum. The
 * mapping is intentionally explicit so a future Stripe SDK bump that
 * adds a new status surfaces as a TS error at this exact site rather
 * than as a silent fallback at runtime.
 */
const STRIPE_STATUS_MAP: Readonly<Record<StripeIdentitySession['status'], KycRecordStatus>> = {
  // The Stripe.Identity.VerificationSession.Status union includes:
  //   'canceled' | 'processing' | 'requires_input' | 'verified'
  // Stripe does not surface a 'failed' or 'pending' status directly
  // — `failed` is communicated via `last_error` on a `requires_input`
  // session, and `pending` is our local-only state before any webhook
  // lands. The map below is exhaustive over Stripe's union; our
  // `failed` state is set by `applyWebhookEvent` when the event type
  // is `identity.verification_session.failed` even though the SDK
  // status surface elides it.
  canceled: 'canceled',
  processing: 'processing',
  requires_input: 'requires_input',
  verified: 'verified',
};

/**
 * `KycService` — owns the KYC row lifecycle for service-identity.
 *
 * Two write paths:
 *
 *   1. `startSession(userId)` — inserts a `pending` row, asks Stripe
 *      for a verification session, persists the Stripe handle on the
 *      row, returns the client_secret + hosted URL so the caller can
 *      open the embedded modal or redirect the user.
 *
 *   2. `applyWebhookEvent(...)` — invoked by the controller's internal
 *      dispatch route once service-webhook delivers an
 *      `identity.verification_session.*` event. Idempotent on
 *      `event.id` (short-circuits if the row's `lastEventId` already
 *      matches); updates the row's status, verifiedAt, and encrypts
 *      + persists the latest Stripe payload.
 *
 * One read path:
 *
 *   3. `getLatestForUser(userId)` — returns the most-recent
 *      `KycRecord` for the user, or null when none exists. The
 *      controller projects this to the contract DTO.
 *
 * **Outbox-ready.** Today the row is updated in-process. When
 * TS-142's outbox relay lands, the same call path can emit a
 * `kyc.status_changed` event transactionally with the update — the
 * follow-up captures this.
 *
 * **No PII in logs.** We log the userId, sessionId, status, and
 * eventId. We never log the Stripe payload — the encrypted column
 * is the only durable copy (CLAUDE.md §3.9).
 *
 * **Observability (TS-026-followup-7; CLAUDE.md §10).** Both write
 * paths run inside an OTel logical span (`kyc.start_session` /
 * `kyc.apply_webhook_event`) so the operation shows up as a named
 * parent in traces, with the auto-instrumented Stripe SDK call (HTTP)
 * and the Prisma writes (pg) stitched on as child spans. Three
 * Prometheus instruments ride on the service `/metrics` endpoint via
 * {@link KycMetrics}: `kyc_sessions_created_total{outcome}`,
 * `kyc_webhook_applied_total{event_type,outcome}`, and the
 * `kyc_webhook_apply_duration_seconds{outcome}` histogram. Metric
 * labels are bounded string-literal unions / a normalised event-type
 * — never the (encrypted) payload, userId, or session id.
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  private readonly returnUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeIdentityClient,
    private readonly cipher: KycPayloadCipherService,
    @Inject(ENV_TOKEN) env: Env,
    // Optional so direct `new KycService(...)` unit-test call sites keep
    // working; in the Nest DI graph the registered `KycMetrics` provider
    // is injected. Instruments are no-ops until `initMetrics` runs, so the
    // default instance is harmless in tests (JanitorMetrics / WebhookMetrics
    // precedent).
    private readonly metrics: KycMetrics = new KycMetrics(),
  ) {
    this.returnUrl = env.STRIPE_IDENTITY_RETURN_URL;
  }

  async startSession(
    input: StartSessionInput,
  ): Promise<Result<StartSessionResult, KycServiceFailure>> {
    return withSpan('kyc.start_session', async (span) => {
      // Default to `error` so the unexpected-throw path (e.g. the P2002 on
      // the external_id unique constraint, which re-throws) still records a
      // bounded outcome rather than leaving the metric silent. Overwritten
      // with the real outcome the moment a Result is in hand.
      let outcome: KycSessionOutcome = 'error';
      try {
        const result = await this.runStartSession(input);
        outcome = result.ok ? 'ok' : startSessionOutcome(result.error);
        return result;
      } finally {
        span.setAttribute('kyc.outcome', outcome);
        this.metrics.recordSessionCreated(outcome);
      }
    });
  }

  private async runStartSession(
    input: StartSessionInput,
  ): Promise<Result<StartSessionResult, KycServiceFailure>> {
    if (input.userId.length === 0) {
      return err({ reason: 'invalid_request', message: 'userId is required' });
    }

    const stripeResult = await this.stripe.createVerificationSession({
      userId: input.userId,
      returnUrl: this.returnUrl,
      ...(input.label !== undefined && { label: input.label }),
      ...(input.idempotencyKey !== undefined && {
        idempotencyKey: `kyc-start:${input.idempotencyKey}`,
      }),
    });
    if (!stripeResult.ok) {
      return err(stripeFailureToServiceFailure(stripeResult.error));
    }

    const session = stripeResult.value;
    let record: KycRecord;
    try {
      record = (await this.prisma.kycRecord.create({
        data: {
          userId: input.userId,
          provider: 'stripe_identity',
          // Stripe may already report a non-`requires_input` status if
          // the user has previously verified — preserve whichever
          // status Stripe reports, fall back to `pending` for the
          // ambiguous case Stripe surfaces but we don't recognise.
          status: STRIPE_STATUS_MAP[session.status] ?? 'pending',
          externalId: session.id,
        },
      })) as KycRecord;
    } catch (cause) {
      // The unique constraint on `external_id` should never fire on
      // the happy path — Stripe's ids are globally unique. A P2002
      // here would mean we somehow received the same session id
      // twice; surface as a generic invalid_request so the controller
      // can map it to a 409.
      this.logger.error(
        { userId: input.userId, sessionId: session.id, err: errorMessage(cause) },
        'kyc-record.create failed',
      );
      throw cause;
    }

    this.logger.log(
      {
        userId: input.userId,
        kycRecordId: record.id,
        sessionId: session.id,
        status: record.status,
      },
      'kyc.startSession ok',
    );
    return ok({
      record,
      clientSecret: session.clientSecret,
      hostedUrl: session.hostedUrl,
    });
  }

  async getLatestForUser(userId: string): Promise<KycRecord | null> {
    if (userId.length === 0) return null;
    const row = (await this.prisma.kycRecord.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })) as KycRecord | null;
    return row;
  }

  async applyWebhookEvent(
    input: ApplyWebhookEventInput,
  ): Promise<Result<KycRecord, KycServiceFailure>> {
    return withSpan('kyc.apply_webhook_event', async (span) => {
      const startNs = process.hrtime.bigint();
      // Default to `error` so an unexpected throw (e.g. a Prisma update
      // failure) records a bounded outcome rather than mislabelling the
      // sample as a success.
      let outcome: KycWebhookOutcome = 'error';
      try {
        const result = await this.runApplyWebhookEvent(input);
        outcome = result.ok ? 'applied' : applyWebhookOutcome(result.error);
        return result;
      } finally {
        const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
        span.setAttribute('kyc.event_type', normalizeKycEventTypeLabel(input.eventType));
        span.setAttribute('kyc.outcome', outcome);
        this.metrics.recordWebhookApplied(input.eventType, outcome, seconds);
      }
    });
  }

  private async runApplyWebhookEvent(
    input: ApplyWebhookEventInput,
  ): Promise<Result<KycRecord, KycServiceFailure>> {
    if (input.eventId.length === 0) {
      return err({ reason: 'invalid_request', message: 'eventId is required' });
    }
    if (input.session.id.length === 0) {
      return err({ reason: 'invalid_request', message: 'session.id is required' });
    }

    const row = (await this.prisma.kycRecord.findUnique({
      where: { externalId: input.session.id },
    })) as KycRecord | null;
    if (row === null) {
      // The session was created outside our system (e.g. via the
      // Stripe Dashboard) — we don't have a local row to attach to.
      // Surface as a 404 so service-webhook's dispatcher logs the
      // miss without retrying indefinitely.
      this.logger.warn(
        { sessionId: input.session.id, eventId: input.eventId },
        'kyc.applyWebhookEvent: no local row for session',
      );
      return err({ reason: 'session_mismatch', externalId: input.session.id });
    }
    if (row.lastEventId === input.eventId) {
      // Idempotent replay — the dispatcher resent an event we already
      // applied. Return the existing row.
      this.logger.debug(
        { sessionId: input.session.id, eventId: input.eventId, kycRecordId: row.id },
        'kyc.applyWebhookEvent: replay (already applied)',
      );
      return err({ reason: 'event_replay', eventId: input.eventId });
    }

    const nextStatus = mapEventTypeToStatus(input.eventType, input.session.status);
    const encrypted = this.cipher.encrypt(input.rawPayload);

    // Local update shape mirrors the row columns this service writes.
    // Avoids importing Prisma's namespace-resolved `KycRecordUncheckedUpdateInput`
    // (same TS-021-followup-2/3 root cause). The Prisma `update.data`
    // typing is structural — Prisma accepts this shape at runtime.
    const update: Record<string, unknown> = {
      status: nextStatus,
      payloadCiphertext: encrypted.ciphertext,
      payloadIv: encrypted.iv,
      payloadAuthTag: encrypted.authTag,
      payloadKeyVersion: encrypted.keyVersion,
      lastEventId: input.eventId,
    };
    // Set verifiedAt exactly once — on the transition into `verified`
    // from a non-verified state. Don't overwrite an earlier
    // verifiedAt if Stripe redelivers a verified event after we
    // already booked the verification.
    if (nextStatus === 'verified' && row.status !== 'verified') {
      update.verifiedAt = new Date(input.eventCreatedSeconds * 1000);
    }

    const updated = (await this.prisma.kycRecord.update({
      where: { id: row.id },
      data: update,
    })) as KycRecord;

    this.logger.log(
      {
        sessionId: input.session.id,
        eventId: input.eventId,
        eventType: input.eventType,
        kycRecordId: row.id,
        previousStatus: row.status,
        nextStatus: updated.status,
      },
      'kyc.applyWebhookEvent ok',
    );
    return ok(updated);
  }
}

/**
 * Map the Stripe event type string to our local KycStatus enum. The
 * mapping is explicit per event-type so a Stripe SDK bump that adds
 * a new event type surfaces here rather than silently falling through
 * to the session-status default.
 *
 * Events we recognise (Stripe Identity catalog as of API 2024-06-20):
 *   - identity.verification_session.created       → use session.status
 *   - identity.verification_session.processing    → processing
 *   - identity.verification_session.verified      → verified
 *   - identity.verification_session.requires_input → requires_input
 *   - identity.verification_session.canceled      → canceled
 *
 * Stripe currently has no `identity.verification_session.failed`
 * event — `requires_input` is the catch-all for unrecoverable
 * verification outcomes. We keep `failed` in the enum for forward
 * compatibility (an operator can move a row to `failed` via admin
 * tooling once TS-127 lands).
 */
function mapEventTypeToStatus(
  eventType: string,
  sessionStatus: StripeIdentitySession['status'],
): KycRecordStatus {
  switch (eventType) {
    case 'identity.verification_session.verified':
      return 'verified';
    case 'identity.verification_session.processing':
      return 'processing';
    case 'identity.verification_session.requires_input':
      return 'requires_input';
    case 'identity.verification_session.canceled':
      return 'canceled';
    case 'identity.verification_session.created':
    case 'identity.verification_session.redacted':
    default:
      return STRIPE_STATUS_MAP[sessionStatus] ?? 'pending';
  }
}

/**
 * Map a `startSession` failure to its bounded metric outcome. The path
 * only ever surfaces `invalid_request` / `stripe_unavailable`; the other
 * `KycServiceFailure` reasons can't occur here, so they fall through to
 * `error` defensively (a value can't occur ≠ unreachable code the linter
 * trusts).
 */
function startSessionOutcome(failure: KycServiceFailure): KycSessionOutcome {
  switch (failure.reason) {
    case 'invalid_request':
      return 'invalid_request';
    case 'stripe_unavailable':
      return 'stripe_unavailable';
    default:
      return 'error';
  }
}

/**
 * Map an `applyWebhookEvent` failure to its bounded metric outcome. The
 * path surfaces `invalid_request` / `event_replay` / `session_mismatch`;
 * the other reasons can't occur here and fall through to `error`.
 */
function applyWebhookOutcome(failure: KycServiceFailure): KycWebhookOutcome {
  switch (failure.reason) {
    case 'invalid_request':
      return 'invalid_request';
    case 'event_replay':
      return 'replayed';
    case 'session_mismatch':
      return 'session_mismatch';
    default:
      return 'error';
  }
}

function stripeFailureToServiceFailure(failure: StripeIdentityFailure): KycServiceFailure {
  switch (failure.reason) {
    case 'stripe_unavailable':
      return { reason: 'stripe_unavailable', cause: failure.cause };
    case 'invalid_request':
      return { reason: 'invalid_request', message: failure.message };
  }
}

function errorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const m = (cause as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'unknown error';
}
