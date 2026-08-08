import { z } from 'zod';

/**
 * KYC provider — currently only Stripe Identity. The enum exists so a
 * future Checkr / Persona / Onfido integration arrives as an additive
 * contract change rather than a free-text field. Mirrors the Prisma
 * `KycProvider` enum exactly.
 */
export const KycProviderSchema = z.enum(['stripe_identity']);
export type KycProvider = z.infer<typeof KycProviderSchema>;

/**
 * KYC verification status. Mirrors the Prisma `KycStatus` enum.
 *
 * - `pending`         — row inserted, no webhook events received yet.
 * - `processing`      — Stripe is verifying the submitted documents.
 * - `verified`        — Stripe confirmed identity; `verifiedAt` is set.
 * - `requires_input`  — Stripe wants the user to retry.
 * - `failed`          — Stripe gave up on the session.
 * - `canceled`        — operator-initiated or user-initiated cancel.
 *
 * Provider-tier promotion (TS-051) gates on `verified`; the other
 * states are surfaced to the provider portal as call-to-action UX.
 */
export const KycStatusSchema = z.enum([
  'pending',
  'processing',
  'verified',
  'requires_input',
  'failed',
  'canceled',
]);
export type KycStatus = z.infer<typeof KycStatusSchema>;

/**
 * KYC record DTO. Projects the internal `KycRecord` row to the
 * publicly-visible shape — the encrypted payload columns are
 * deliberately omitted (raw Stripe payloads are internal-only;
 * surface them via admin tooling, not the user-facing API).
 *
 * `.strict()` rejects unknown fields at parse time, matching the
 * CLAUDE.md §3.3 "Reject unknown fields by default" rule.
 */
export const KycRecordSchema = z
  .object({
    id: z.string().min(1).max(64),
    provider: KycProviderSchema,
    status: KycStatusSchema,
    /**
     * Stripe `verificationSession.id`. Surfaced to the user-facing
     * portal so it can match an inbound success-redirect query
     * parameter against the local record.
     */
    externalId: z.string().min(1).max(255),
    verifiedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type KycRecord = z.infer<typeof KycRecordSchema>;

/**
 * Response body for `POST /api/v1/identity/kyc-sessions`.
 *
 * `clientSecret` is the short-lived secret the Stripe.js client SDK
 * uses to open the embedded modal. `hostedUrl` is the fallback for
 * environments where the embedded modal cannot run (e.g. native
 * apps in the Phase 2 React Native rollout). Both may be null if
 * Stripe declined to issue them — the caller renders an error
 * state in that case.
 */
export const CreateKycSessionResponseSchema = z
  .object({
    record: KycRecordSchema,
    clientSecret: z.string().min(1).max(512).nullable(),
    hostedUrl: z.string().url().max(2048).nullable(),
  })
  .strict();
export type CreateKycSessionResponse = z.infer<typeof CreateKycSessionResponseSchema>;

/**
 * Response body for `GET /api/v1/identity/kyc-sessions/me`.
 *
 * `record` is null when the user has never started a KYC session —
 * the portal surfaces a "begin verification" CTA in that case. When
 * a record exists, its `status` field drives the UX.
 *
 * Wrapped in `{ record }` so a future extension (e.g. adding a list
 * of historical attempts) is an additive contract change rather than
 * a breaking switch from a bare DTO.
 */
export const KycStatusResponseSchema = z
  .object({
    record: KycRecordSchema.nullable(),
  })
  .strict();
export type KycStatusResponse = z.infer<typeof KycStatusResponseSchema>;

/**
 * Internal dispatch payload — the body service-webhook POSTs to
 * `POST /api/v1/internal/kyc/webhook-events`. Not part of the
 * public REST surface; documented here so both ends of the
 * cross-service contract share a single typed shape.
 *
 * - `eventId`       — Stripe `event.id`. Used for idempotency.
 * - `eventType`     — Stripe `event.type` string (verbatim).
 * - `eventCreatedSeconds` — Stripe `event.created` (Unix seconds).
 *                   Used to stamp `verifiedAt` on the verified
 *                   transition.
 * - `session`       — projection of the Stripe
 *                   `Identity.VerificationSession` data.object the
 *                   event carried. Fields match the
 *                   `StripeIdentitySession` shape inside
 *                   service-identity but are validated at the
 *                   network boundary so a malformed dispatch
 *                   fails fast.
 * - `rawPayload`    — JSON-stringified copy of the raw Stripe event
 *                   `data.object`, persisted at rest under the
 *                   payload cipher. Bounded length to defend
 *                   against a malicious dispatcher sending an
 *                   unbounded blob; Stripe's verification session
 *                   payloads cap well below 64 KiB in practice.
 */
export const KycInternalWebhookEventSchema = z
  .object({
    eventId: z.string().min(1).max(255),
    eventType: z.string().min(1).max(255),
    eventCreatedSeconds: z.number().int().min(0),
    session: z
      .object({
        id: z.string().min(1).max(255),
        status: z.enum(['canceled', 'processing', 'requires_input', 'verified']),
        clientSecret: z.string().max(512).nullable(),
        hostedUrl: z.string().url().max(2048).nullable(),
        verifiedAtSeconds: z.number().int().min(0).nullable(),
      })
      .strict(),
    rawPayload: z.string().min(1).max(65_536),
  })
  .strict();
export type KycInternalWebhookEvent = z.infer<typeof KycInternalWebhookEventSchema>;

/**
 * Internal dispatch response. Surfaces the persisted record (or
 * `null` if the event was a replay we short-circuited) plus an
 * outcome string so the dispatcher's metrics can distinguish
 * "applied" / "replayed" / "missing-row" outcomes.
 */
export const KycInternalWebhookResponseSchema = z
  .object({
    outcome: z.enum(['applied', 'replayed', 'session_mismatch']),
    record: KycRecordSchema.nullable(),
  })
  .strict();
export type KycInternalWebhookResponse = z.infer<typeof KycInternalWebhookResponseSchema>;
