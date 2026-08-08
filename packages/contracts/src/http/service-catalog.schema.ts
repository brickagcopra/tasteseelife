import { z } from 'zod';

import { BookingServiceKindSchema } from '../events/booking';
import { ProviderTierSchema } from './provider-application.schema';

/**
 * Service-catalog contracts (TS-060-followup-2).
 *
 * PRD §5.4 / §6.3 + PDD §8.2 frame the bookable-service catalog as the
 * **admin-editable pricing / duration metadata** that sits beside the
 * `service_kind` enum. TS-060 shipped the enum + the
 * `bookings.service_kind` column; this module supplies the wire shape
 * for the catalog rows that carry per-kind rate bands, a default
 * duration, and an operator-editable name + description.
 *
 * Where the catalog is consumed:
 *
 *   - The booking-create flow (concierge request) will derive
 *     `basePrice` from the band at row-creation time — that consumer
 *     wiring is TS-060-followup-2a (pairs with TS-204-followup-1 /
 *     TS-125-followup-8). Today `service-kind-defaults.ts` is the
 *     constant substitute the create path reads.
 *   - The web-admin catalog editor (TS-128-followup-6) reads + edits
 *     the rows via the gateway BFF proxy (TS-060-followup-2b).
 *   - The family-portal service-kind picker can render the catalog
 *     (name + description + duration) once the gateway read proxy lands.
 *
 * **Money on the wire is integer minor units (cents)** + a currency
 * code, mirroring the booking surface (`basePriceMinor` + `currency`)
 * and the provider-pricing surface (`hourlyRateMinor`). The persistence
 * layer stores `Decimal(12,2)` + `Char(3)`; `service-booking` crosses
 * that boundary exactly once per row per request via the shared
 * `money.ts` helpers (CLAUDE.md §6 — "Round once, at presentation").
 *
 * **Phase-1 one-row-per-kind.** The `kind` column is UNIQUE: there is
 * exactly one catalog row per `BookingServiceKind`, so the admin upsert
 * is keyed on the kind (a `PUT /:kind`). Per-region / per-tier band
 * overrides are a Phase-3 concern that lands additively (a nullable
 * `region_code` column + a composite unique key) without a v1 break.
 *
 * **`requiredProviderTier` (TS-220).** The minimum provider tier a
 * household must book to fulfil this kind. `null` means any tier (the
 * basic-marketplace default). The Tier-3 concierge experiences (PRD §6.6)
 * carry `'elite'` — only Elite Concierge providers may fulfil them
 * (CLAUDE.md §12). This is metadata in TS-220; the booking-create
 * enforcement that reads it is a carved follow-up (TS-220-followup-1),
 * mirroring how TS-060-followup-2 shipped the table and deferred the
 * booking-create consult to TS-060-followup-2a.
 */

// ─────────────────────────────────────────────────────────────────────
// Currency + absolute platform bounds
// ─────────────────────────────────────────────────────────────────────

/**
 * ISO-4217 currency code. Phase 1 launches USD-only (PRD §11.4 /
 * PDD §11.2); the contract accepts any 3-letter code so the wire shape
 * survives the Phase-3 multi-currency rollout without a v1 break
 * (mirrors the booking + provider-pricing surfaces). `service-booking`
 * rejects any non-USD code with a 422 until multi-currency lands.
 */
export const SERVICE_CATALOG_CURRENCY_CODE_LENGTH = 3;
export const SERVICE_CATALOG_DEFAULT_CURRENCY = 'USD' as const;

/**
 * Absolute platform rail on a catalog rate band, in minor units. These
 * are deliberately wide — they exist only to reject a fat-finger /
 * integer-overflow at the wire boundary (`$0.01`–`$100,000`). The
 * meaningful per-kind band is the seeded `base_rate_min`/`base_rate_max`
 * pair, re-tunable by ops without a contract change.
 */
export const SERVICE_CATALOG_RATE_MIN_MINOR = 1;
export const SERVICE_CATALOG_RATE_MAX_MINOR = 10_000_000;

/**
 * Default-duration rail, in minutes. A service can be as short as 15
 * minutes (a quick check-in) and as long as a full day (1440). The
 * binding default is the seeded `duration_minutes`; this rail only
 * guards against a nonsensical wire value.
 */
export const SERVICE_CATALOG_DURATION_MIN_MINUTES = 15;
export const SERVICE_CATALOG_DURATION_MAX_MINUTES = 1_440;

/** Max length of the operator-editable `name` / `description` fields. */
export const SERVICE_CATALOG_NAME_MAX_LENGTH = 120;
export const SERVICE_CATALOG_DESCRIPTION_MAX_LENGTH = 1_000;

/** Sort-position rail — a small non-negative integer for UI ordering. */
export const SERVICE_CATALOG_SORT_POSITION_MAX = 999;

const RateMinorSchema = z
  .number()
  .int()
  .min(SERVICE_CATALOG_RATE_MIN_MINOR)
  .max(SERVICE_CATALOG_RATE_MAX_MINOR);

const DurationMinutesSchema = z
  .number()
  .int()
  .min(SERVICE_CATALOG_DURATION_MIN_MINUTES)
  .max(SERVICE_CATALOG_DURATION_MAX_MINUTES);

const SortPositionSchema = z.number().int().min(0).max(SERVICE_CATALOG_SORT_POSITION_MAX);

// ─────────────────────────────────────────────────────────────────────
// Record shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Materialised catalog row for one bookable service kind.
 *
 *   - `baseRateMinMinor` ≤ `baseRateMaxMinor` is guaranteed by the
 *     `superRefine` below — a band whose floor exceeds its ceiling is a
 *     data-integrity bug, rejected at the boundary.
 *   - `durationMinutes` is the default visit length used to seed the
 *     booking-create quote (band × duration) once TS-060-followup-2a
 *     wires it.
 *   - `active` lets ops retire a service kind from the picker without
 *     deleting the row (so historical bookings stay readable). The
 *     `service_kind` enum still bounds the set of permissible values at
 *     the DB level; `active = false` is the soft retirement.
 *   - `requiredProviderTier` is the minimum provider tier a household
 *     must book to fulfil this kind (TS-220). `null` = any tier (the
 *     basic-marketplace default); Tier-3 concierge experiences carry
 *     `'elite'`.
 *   - `updatedAt` reflects the most-recent write to the row and doubles
 *     as a freshness signal for the editor.
 */
export const ServiceCatalogRecordSchema = z
  .object({
    kind: BookingServiceKindSchema,
    name: z.string().min(1).max(SERVICE_CATALOG_NAME_MAX_LENGTH),
    description: z.string().min(1).max(SERVICE_CATALOG_DESCRIPTION_MAX_LENGTH),
    baseRateMinMinor: RateMinorSchema,
    baseRateMaxMinor: RateMinorSchema,
    durationMinutes: DurationMinutesSchema,
    currency: z.string().length(SERVICE_CATALOG_CURRENCY_CODE_LENGTH),
    active: z.boolean(),
    requiredProviderTier: ProviderTierSchema.nullable(),
    sortPosition: SortPositionSchema,
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.baseRateMinMinor > record.baseRateMaxMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseRateMinMinor must be ≤ baseRateMaxMinor',
        path: ['baseRateMinMinor'],
      });
    }
  });
export type ServiceCatalogRecord = z.infer<typeof ServiceCatalogRecordSchema>;

/**
 * Response body for `GET /api/v1/service-catalog`. Wrapped in
 * `{ entries: [...] }` so the shape is forward-compatible with future
 * pagination metadata / filter facets without a v1 break. Entries are
 * returned in `sortPosition` order.
 */
export const ServiceCatalogListResponseSchema = z
  .object({
    entries: z.array(ServiceCatalogRecordSchema),
  })
  .strict();
export type ServiceCatalogListResponse = z.infer<typeof ServiceCatalogListResponseSchema>;

// ─────────────────────────────────────────────────────────────────────
// Admin upsert shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Request body for `PUT /api/v1/admin/service-catalog/:kind` (admin
 * tooling — TS-128-followup-6 web-admin editor; CLAUDE.md §10.5).
 *
 * Full-replace semantics on the editable columns — the `kind` is the
 * path param (never in the body), and the row's `id` / `created_at` are
 * never client-supplied. Both rate-band ends are required; the
 * `superRefine` rejects an inverted band at the boundary (400 via the
 * `ZodValidationPipe`).
 *
 * `currency` accepts any 3-letter code on the wire; `service-booking`
 * rejects non-USD with a 422 until multi-currency lands (Phase 3) — so
 * the wire shape survives the rollout without a contract change.
 */
export const UpsertServiceCatalogEntryRequestSchema = z
  .object({
    name: z.string().min(1).max(SERVICE_CATALOG_NAME_MAX_LENGTH),
    description: z.string().min(1).max(SERVICE_CATALOG_DESCRIPTION_MAX_LENGTH),
    baseRateMinMinor: RateMinorSchema,
    baseRateMaxMinor: RateMinorSchema,
    durationMinutes: DurationMinutesSchema,
    currency: z.string().length(SERVICE_CATALOG_CURRENCY_CODE_LENGTH),
    active: z.boolean(),
    requiredProviderTier: ProviderTierSchema.nullable(),
    sortPosition: SortPositionSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.baseRateMinMinor > body.baseRateMaxMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseRateMinMinor must be ≤ baseRateMaxMinor',
        path: ['baseRateMinMinor'],
      });
    }
  });
export type UpsertServiceCatalogEntryRequest = z.infer<
  typeof UpsertServiceCatalogEntryRequestSchema
>;

/**
 * Response body for `PUT /api/v1/admin/service-catalog/:kind`. Wrapped
 * in `{ entry: ... }` so the shape is forward-compatible with future
 * side-payloads (e.g. an audit-event id) without a v1 break.
 */
export const UpsertServiceCatalogEntryResponseSchema = z
  .object({
    entry: ServiceCatalogRecordSchema,
  })
  .strict();
export type UpsertServiceCatalogEntryResponse = z.infer<
  typeof UpsertServiceCatalogEntryResponseSchema
>;
