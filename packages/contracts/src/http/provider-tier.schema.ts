import { z } from 'zod';

import { ProviderRecordSchema, ProviderTierSchema } from './provider-application.schema';

/**
 * Provider certification + tier-promotion contracts (TS-052).
 *
 * Shape pinned at the network boundary so the family-portal, the
 * provider-portal, and the admin tooling all share a single typed
 * surface. The service-layer mirrors live in
 * `apps/service-provider/src/modules/certifications/`.
 *
 * Scope split:
 *   - The certification catalog (Catalog* schemas below) is **public
 *     read** — the family portal renders a "what credentials do our
 *     providers hold?" page and the provider portal renders a
 *     "what certifications can I earn?" page. No auth, no PII.
 *   - The provider-certifications surface (ProviderCertification*
 *     schemas) is **authenticated** — the provider sees their own
 *     issued certs; ops staff with `provider:approve` permission see
 *     any provider's certs.
 *   - The tier-history surface (ProviderTierHistory*) is **ops-only**.
 *     Returns the append-only transition log for an individual
 *     provider.
 */

// ─────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────

/**
 * Bounded lengths for catalog free-text columns. Exported so client
 * UIs can validate inputs at the same caps the service enforces.
 */
export const CERTIFICATION_CODE_MAX_LENGTH = 64;
export const CERTIFICATION_NAME_MAX_LENGTH = 120;
export const CERTIFICATION_DESCRIPTION_MAX_LENGTH = 4000;
export const CERTIFICATION_ISSUER_MAX_LENGTH = 120;
export const CERTIFICATION_NOTES_MAX_LENGTH = 4000;
export const CERTIFICATION_REVOCATION_REASON_MAX_LENGTH = 1000;
export const TIER_OVERRIDE_NOTES_MAX_LENGTH = 2000;

/**
 * Certification catalog entry — projection of a row from the
 * `certifications` table. Exposed on the public GET /api/v1/certifications.
 */
export const CertificationSchema = z
  .object({
    id: z.string().min(1).max(64),
    code: z.string().min(1).max(CERTIFICATION_CODE_MAX_LENGTH),
    name: z.string().min(1).max(CERTIFICATION_NAME_MAX_LENGTH),
    description: z.string().min(1).max(CERTIFICATION_DESCRIPTION_MAX_LENGTH),
    issuer: z.string().min(1).max(CERTIFICATION_ISSUER_MAX_LENGTH),
    /**
     * Months from issuance until automatic expiry. `null` means
     * no expiry — appropriate for one-shot credentials with no
     * renewal cycle.
     */
    defaultValidityMonths: z.number().int().positive().max(600).nullable(),
    sortPosition: z.number().int().min(0).max(10_000),
    active: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Certification = z.infer<typeof CertificationSchema>;

/**
 * Response body for `GET /api/v1/certifications`. Wrapper around the
 * catalog array so we can add filter facets / pagination cursors
 * additively in a follow-up without breaking the v1 contract.
 */
export const CertificationsListResponseSchema = z
  .object({
    certifications: z.array(CertificationSchema),
  })
  .strict();
export type CertificationsListResponse = z.infer<typeof CertificationsListResponseSchema>;

// ─────────────────────────────────────────────────────────────────────
// Provider certifications (issuance log)
// ─────────────────────────────────────────────────────────────────────

/**
 * Issued certification record — projection of a row from the
 * `provider_certifications` table. The `active` flag is computed at
 * read time: `revoked_at IS NULL AND (expires_at IS NULL OR
 * expires_at > now)`. The certification details (name + code) are
 * denormalised onto the response so the consumer doesn't need a
 * second round-trip to the catalog.
 */
export const ProviderCertificationRecordSchema = z
  .object({
    id: z.string().min(1).max(64),
    providerId: z.string().min(1).max(64),
    certification: z
      .object({
        id: z.string().min(1).max(64),
        code: z.string().min(1).max(CERTIFICATION_CODE_MAX_LENGTH),
        name: z.string().min(1).max(CERTIFICATION_NAME_MAX_LENGTH),
      })
      .strict(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    revocationReason: z.string().max(CERTIFICATION_REVOCATION_REASON_MAX_LENGTH).nullable(),
    notes: z.string().max(CERTIFICATION_NOTES_MAX_LENGTH).nullable(),
    active: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderCertificationRecord = z.infer<typeof ProviderCertificationRecordSchema>;

/**
 * Response body for `GET /api/v1/providers/me/certifications`.
 */
export const ProviderCertificationsListResponseSchema = z
  .object({
    certifications: z.array(ProviderCertificationRecordSchema),
  })
  .strict();
export type ProviderCertificationsListResponse = z.infer<
  typeof ProviderCertificationsListResponseSchema
>;

/**
 * Request body for `POST /api/v1/admin/providers/:providerId/certifications`.
 *
 * `certificationCode` references the catalog. `issuedAt` defaults to
 * `now` on the service side; supply it only when backfilling. The
 * service computes `expiresAt` from the catalog's
 * `default_validity_months` when not supplied — overriding here is
 * permitted for special-case grants (e.g. extending a renewal).
 */
export const GrantProviderCertificationRequestSchema = z
  .object({
    certificationCode: z.string().min(1).max(CERTIFICATION_CODE_MAX_LENGTH),
    issuedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    notes: z.string().min(1).max(CERTIFICATION_NOTES_MAX_LENGTH).optional(),
  })
  .strict();
export type GrantProviderCertificationRequest = z.infer<
  typeof GrantProviderCertificationRequestSchema
>;

/**
 * Response body for the grant + revoke admin endpoints.
 */
export const ProviderCertificationResponseSchema = z
  .object({
    certification: ProviderCertificationRecordSchema,
  })
  .strict();
export type ProviderCertificationResponse = z.infer<typeof ProviderCertificationResponseSchema>;

/**
 * Request body for `DELETE /api/v1/admin/providers/:providerId/certifications/:certId`.
 *
 * Wrapped in a body even though DELETE traditionally has none — the
 * `reason` is required for audit (CLAUDE.md §6 / §10) and putting it
 * on a query string risks accidental log capture.
 */
export const RevokeProviderCertificationRequestSchema = z
  .object({
    reason: z.string().min(1).max(CERTIFICATION_REVOCATION_REASON_MAX_LENGTH),
  })
  .strict();
export type RevokeProviderCertificationRequest = z.infer<
  typeof RevokeProviderCertificationRequestSchema
>;

// ─────────────────────────────────────────────────────────────────────
// Tier evaluation, override, history
// ─────────────────────────────────────────────────────────────────────

/**
 * Tier-transition reason — mirrors the Prisma `TierTransitionReason`
 * enum on the service side.
 */
export const TierTransitionReasonSchema = z.enum(['auto_evaluation', 'admin_override']);
export type TierTransitionReason = z.infer<typeof TierTransitionReasonSchema>;

/**
 * Tier-history entry — projection of one row from
 * `provider_tier_history`.
 */
export const ProviderTierHistoryRecordSchema = z
  .object({
    id: z.string().min(1).max(64),
    providerId: z.string().min(1).max(64),
    fromTier: ProviderTierSchema.nullable(),
    toTier: ProviderTierSchema,
    reason: TierTransitionReasonSchema,
    triggeredByUserId: z.string().min(1).max(64).nullable(),
    notes: z.string().max(TIER_OVERRIDE_NOTES_MAX_LENGTH).nullable(),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type ProviderTierHistoryRecord = z.infer<typeof ProviderTierHistoryRecordSchema>;

/**
 * Response body for `GET /api/v1/admin/providers/:providerId/tier/history`.
 */
export const ProviderTierHistoryResponseSchema = z
  .object({
    history: z.array(ProviderTierHistoryRecordSchema),
  })
  .strict();
export type ProviderTierHistoryResponse = z.infer<typeof ProviderTierHistoryResponseSchema>;

/**
 * Response body for `POST /api/v1/admin/providers/:providerId/tier/evaluate`.
 *
 * `applied` is `true` only when the evaluation produced a tier
 * change; a no-op evaluation returns `false` and `history` is null.
 * The provider record is always returned so callers don't need a
 * second round-trip.
 */
export const TierEvaluationResponseSchema = z
  .object({
    provider: ProviderRecordSchema,
    previousTier: ProviderTierSchema,
    nextTier: ProviderTierSchema,
    applied: z.boolean(),
    history: ProviderTierHistoryRecordSchema.nullable(),
  })
  .strict();
export type TierEvaluationResponse = z.infer<typeof TierEvaluationResponseSchema>;

/**
 * Request body for `POST /api/v1/admin/providers/:providerId/tier/override`.
 *
 * Manual tier override outside the certification rules. Used when ops
 * needs to suspend a tier (complaint review) or restore one (post-
 * resolution). `notes` is required so the audit trail captures
 * intent.
 */
export const TierOverrideRequestSchema = z
  .object({
    targetTier: ProviderTierSchema,
    notes: z.string().min(1).max(TIER_OVERRIDE_NOTES_MAX_LENGTH),
  })
  .strict();
export type TierOverrideRequest = z.infer<typeof TierOverrideRequestSchema>;

// ─────────────────────────────────────────────────────────────────────
// Provider self-view (profile + active certs)
// ─────────────────────────────────────────────────────────────────────

/**
 * Response body for `GET /api/v1/providers/me/profile`. Surfaces the
 * provider row plus their active certifications — the data the
 * provider portal needs to render the self-view.
 */
export const ProviderProfileResponseSchema = z
  .object({
    provider: ProviderRecordSchema.nullable(),
    activeCertifications: z.array(ProviderCertificationRecordSchema),
  })
  .strict();
export type ProviderProfileResponse = z.infer<typeof ProviderProfileResponseSchema>;
