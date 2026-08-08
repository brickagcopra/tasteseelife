import { z } from 'zod';

import { BackgroundCheckStatusSchema } from './provider-application.schema';
import { ProviderMetricsSectionSchema } from './provider-metrics.schema';
import { ProviderProfileRecordSchema } from './provider-profile.schema';
import {
  ProviderCertificationRecordSchema,
  ProviderTierHistoryRecordSchema,
} from './provider-tier.schema';

/**
 * Admin provider dossier (TS-305a; PRD §10.14, PDD §16.1).
 *
 * Response shape for
 * `GET /api/v1/admin/providers/{providerId}/dossier` — the one
 * round-trip a reviewer needs before deliberating on a provider:
 * who they are, what credentials they hold (and have lost), how
 * their tier has moved, and whether their background check cleared.
 *
 * **This is a read-only projection assembled from surfaces that
 * already exist inside service-provider.** It adds no new state. The
 * reason it exists as its own endpoint rather than three client-side
 * calls is that two of the three underlying reads had no admin
 * surface at all (certifications were self-view-only; the
 * background-check status was reachable only through the applicant's
 * own application response), and a committee tool that fans out to
 * four endpoints to answer one question is four chances to render a
 * half-loaded dossier.
 *
 * **What is deliberately NOT here.**
 *   - *Ratings and performance metrics.* PRD §10.14 names both. Neither
 *     exists anywhere in the platform — see TS-305d / TS-305e. They are
 *     absent from this contract rather than present-and-null, because a
 *     nullable field reads as "no data for this provider" when the truth
 *     is "this platform does not measure that yet". The consumer must
 *     state the difference; a null cannot.
 *   - *Incidents.* They live in service-trust-safety and are composed in
 *     by the gateway (TS-305b). A cross-service join here would violate
 *     CLAUDE.md §2.3.
 *   - *Pricing.* The provider's hourly rate belongs to the pricing
 *     surface. It is not one of the questions a review committee asks,
 *     and money on the wire deserves its own contract decision.
 */

// ─────────────────────────────────────────────────────────────────────
// Background check — verdict only
// ─────────────────────────────────────────────────────────────────────

/**
 * Background-check verdict as the dossier exposes it.
 *
 * **Narrower than `ProviderBackgroundCheckRecordSchema` on purpose.**
 * That schema (the applicant's own view) carries `checkrCandidateId`
 * and `checkrReportId`. Those are handles into a consumer-reporting
 * system, and the encrypted `payload_*` columns behind them hold the
 * report itself. A deliberation view needs the verdict, not the file:
 * widening a committee surface to carry report identifiers enlarges
 * the FCRA blast radius for no decision it helps anyone make. If a
 * reviewer genuinely needs the underlying report, that is an
 * adverse-action workflow with its own notice requirements — not a
 * field on a 360 page.
 *
 * `completedAt` is null until the check reaches a terminal status;
 * a `pending` check with a null `completedAt` is the normal
 * in-flight shape, not missing data.
 */
export const ProviderDossierBackgroundCheckSchema = z
  .object({
    id: z.string().min(1).max(64),
    status: BackgroundCheckStatusSchema,
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderDossierBackgroundCheck = z.infer<typeof ProviderDossierBackgroundCheckSchema>;

// ─────────────────────────────────────────────────────────────────────
// Provider core
// ─────────────────────────────────────────────────────────────────────

/**
 * Provider core row as the dossier exposes it — the public profile
 * record plus the two admin-only columns.
 *
 * `userId` is the soft FK into `identity.users.id`. Carried so the
 * console can cross-link to the user detail page; it is not public
 * and never appears on `ProviderProfileRecordSchema`.
 *
 * `deletedAt` is non-null for an archived provider. **The dossier
 * deliberately serves archived providers**, unlike
 * `GET /api/v1/providers/{id}/profile`, which 404s them. That
 * endpoint is a listing read where an archived provider should be
 * invisible; this one is a review surface, and "this provider was
 * archived on 3 March" is precisely the fact a committee convened
 * about them needs. Suppressing the row would make the tool useless
 * in exactly the cases it matters most.
 */
export const ProviderDossierCoreSchema = ProviderProfileRecordSchema.extend({
  userId: z.string().min(1).max(64),
  deletedAt: z.string().datetime().nullable(),
}).strict();
export type ProviderDossierCore = z.infer<typeof ProviderDossierCoreSchema>;

// ─────────────────────────────────────────────────────────────────────
// Dossier
// ─────────────────────────────────────────────────────────────────────

/**
 * Response body for `GET /api/v1/admin/providers/{providerId}/dossier`.
 *
 * `certifications` is the **full** issuance history, newest-first —
 * not the active-only set the provider self-view returns. A revoked
 * food-handler certification is a fact about a provider under review;
 * filtering it out would hide the single most relevant row.
 * `ProviderCertificationRecord.active` already distinguishes the two,
 * so the consumer can style them differently without a second call.
 *
 * `tierHistory` is the append-only transition log, newest-first.
 *
 * `backgroundCheck` is the MOST RECENT check only, or null when the
 * provider has none on file (a legacy row, or an application that
 * never reached the Checkr call). Null means "no check on file" —
 * which is itself a finding, and the consumer must say so rather than
 * rendering an empty panel.
 *
 * `generatedAt` is composition wall-clock, so the console can render
 * "as of …" without a second round-trip. It matters here more than on
 * most reads: a committee screenshots this page into a deliberation
 * record.
 */
export const ProviderDossierResponseSchema = z
  .object({
    provider: ProviderDossierCoreSchema,
    certifications: z.array(ProviderCertificationRecordSchema),
    tierHistory: z.array(ProviderTierHistoryRecordSchema),
    backgroundCheck: ProviderDossierBackgroundCheckSchema.nullable(),
    /**
     * Reliability figures derived from service-booking's lifecycle
     * events (TS-305d). Always present — its own `state` discriminator
     * distinguishes "measured", "too little history to state a rate"
     * and "never seen a booking", so there is nothing a null could say
     * that the section cannot say better.
     *
     * Still **no `rating`**: see `provider-metrics.schema.ts`. That
     * absence remains the contract (TS-305e).
     */
    metrics: ProviderMetricsSectionSchema,
    generatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderDossierResponse = z.infer<typeof ProviderDossierResponseSchema>;
