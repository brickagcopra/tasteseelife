import { z } from 'zod';

import {
  ProviderDossierBackgroundCheckSchema,
  ProviderDossierCoreSchema,
} from './provider-dossier.schema';
import { ProviderMetricsSectionSchema } from './provider-metrics.schema';
import {
  ProviderCertificationRecordSchema,
  ProviderTierHistoryRecordSchema,
} from './provider-tier.schema';
import { TrustSafetyIncidentSummarySchema } from './trust-safety-incident.schema';

/**
 * Provider 360 — the review committee's composed view (TS-305b;
 * PRD §10.14, PDD §16.1).
 *
 * Response shape for `GET /api/v1/admin/providers/{providerId}/360`,
 * composed at the api-gateway from two upstreams:
 *
 *   - `service-provider` — the TS-305a dossier (core row,
 *     certifications, tier history, background-check verdict).
 *   - `service-trust-safety` — the TS-303c2d incident scroll filtered
 *     to this provider.
 *
 * Cross-service composition happens here rather than in either
 * service because neither may read the other's database
 * (CLAUDE.md §2.3).
 *
 * **The dossier is fatal; incidents degrade.** This is the deliberate
 * difference from `visit-prep-aggregator`, where every upstream is
 * load-bearing and any failure is a 502. Here a committee can still
 * deliberate on a provider's credentials and tier history while
 * trust-safety is down — but not on an empty page, and never on a page
 * that silently omits a section. So the dossier's absence fails the
 * request, and the incident section carries its own state.
 *
 * **The under-count caveat is NOT a field, deliberately.** An incident
 * FILED BY a provider lands with `provider_id` NULL (a provider token
 * carries no `providerId` claim and self-assertion was rejected as a
 * spoofing vector — TS-301b), so this scroll under-reports until
 * TS-301b-followup-1 lands the async linkage. That warning belongs on
 * the screen and is required of every consumer, but a
 * constant-`true` flag on the wire would be a fact about the
 * platform's backlog masquerading as a fact about this provider — and
 * when the linkage lands, every consumer would have to be taught that
 * `false` now means something. The contract documents it; the consumer
 * must state it.
 */

// ─────────────────────────────────────────────────────────────────────
// Incident section
// ─────────────────────────────────────────────────────────────────────

/**
 * Why the incident section could not be filled.
 *
 * Every value is an INFRASTRUCTURE condition. A downstream 403 is
 * deliberately not in this list: the edge already requires
 * `trust_safety:write`, and the incident queue requires
 * `trust_safety:read` — a caller holding the first but not the second
 * is a seed-catalog misconfiguration, and rendering that as
 * "temporarily unavailable" would hide a permissions bug behind an
 * outage message. It surfaces as an error instead.
 */
export const Provider360IncidentsUnavailableReasonSchema = z.enum([
  /** Gateway has no `TRUST_SAFETY_SERVICE_BASE_URL` configured. */
  'not_configured',
  /** DNS / connection failure reaching service-trust-safety. */
  'unreachable',
  /** Upstream did not answer inside the timeout budget. */
  'timeout',
  /** Upstream answered 5xx. */
  'upstream_error',
  /** Upstream answered 2xx with a body that failed the contract. */
  'contract_drift',
]);
export type Provider360IncidentsUnavailableReason = z.infer<
  typeof Provider360IncidentsUnavailableReasonSchema
>;

/**
 * The incident section — present with rows, or absent with a reason.
 *
 * A discriminated union rather than `incidents: [] | null` because
 * "this provider has no incidents" and "we could not ask" are
 * different findings and a committee must never confuse them. An empty
 * array under `state: 'available'` is a clean record; `state:
 * 'unavailable'` is a missing section. Neither shape can be mistaken
 * for the other at the type level.
 *
 * `truncated` is true when either upstream page came back full,
 * meaning older incidents exist beyond what is shown. It
 * over-reports at the boundary — a provider with exactly the page
 * limit is flagged truncated when nothing was actually dropped —
 * which is the right way to be wrong on a deliberation surface.
 *
 * Rows are merged from the live queue and the resolved queue and
 * ordered `openedAt` DESCENDING. Note this is NOT the incident
 * queue's own order (`slaDueAt` ascending): that queue answers "what
 * must I work next", this section answers "what has happened to this
 * provider", and a history reads newest-first.
 */
export const Provider360IncidentsSectionSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('available'),
      incidents: z.array(TrustSafetyIncidentSummarySchema),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      state: z.literal('unavailable'),
      reason: Provider360IncidentsUnavailableReasonSchema,
    })
    .strict(),
]);
export type Provider360IncidentsSection = z.infer<typeof Provider360IncidentsSectionSchema>;

// ─────────────────────────────────────────────────────────────────────
// Composed response
// ─────────────────────────────────────────────────────────────────────

/**
 * Response body for `GET /api/v1/admin/providers/{providerId}/360`.
 *
 * The dossier sections are flattened rather than nested under a
 * `dossier` key: they are never partially present (the dossier read
 * either succeeds whole or fails the request), so an envelope would
 * imply an optionality that does not exist.
 *
 * `generatedAt` is composition wall-clock at the gateway. It is NOT
 * the dossier's own `generatedAt` — those differ by the fan-out
 * latency, and the one a committee cites is the moment the composed
 * page was produced.
 *
 * `metrics` arrives INSIDE the dossier and is passed straight through,
 * so it is not a second degradable section: the dossier is the fatal
 * upstream, and if it answered at all the metrics answered with it.
 * Only `incidents` can be `unavailable`, because only it has an
 * upstream of its own.
 *
 * There is still no `rating`. Nothing on this platform captures one
 * (TS-305e), and its absence remains the contract — the performance
 * half of that sentence was closed by TS-305d.
 */
export const Provider360ResponseSchema = z
  .object({
    provider: ProviderDossierCoreSchema,
    certifications: z.array(ProviderCertificationRecordSchema),
    tierHistory: z.array(ProviderTierHistoryRecordSchema),
    backgroundCheck: ProviderDossierBackgroundCheckSchema.nullable(),
    metrics: ProviderMetricsSectionSchema,
    incidents: Provider360IncidentsSectionSchema,
    generatedAt: z.string().datetime(),
  })
  .strict();
export type Provider360Response = z.infer<typeof Provider360ResponseSchema>;
