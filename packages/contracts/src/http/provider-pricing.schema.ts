import { z } from 'zod';

import {
  ProviderStatusSchema,
  ProviderTierSchema,
  type ProviderTier,
} from './provider-application.schema';

/**
 * Provider pricing-band contracts (TS-204).
 *
 * PRD §5.1 / §5.2 / §7.2 frame provider pricing as **platform-set
 * bands per tier**: a provider names their own hourly rate, but only
 * within a min/max window the platform defines for their marketplace
 * tier (Basic / Certified / Elite — PRD §5.2; persona C in PRD §3
 * targets a $40–$120/hr range across tiers). This module supplies the
 * self-service write surface that lets an active provider set that
 * rate plus the read surfaces the editor + (future) booking-quote
 * path consume.
 *
 * Why a separate file from `provider-profile.schema.ts`:
 *
 *   - Money is its own concern. The profile surface owns marketing-
 *     shaped content (bio, tags, dementia-sensitive flag); pricing
 *     owns a `Decimal(12,2)` money column + an ISO-4217 currency code
 *     (CLAUDE.md §4.1). Keeping the two surfaces in separate PUT
 *     endpoints bounds the blast radius of a pricing change and keeps
 *     each editor tab focused.
 *
 *   - The per-tier band is **platform policy**, not provider input.
 *     `PROVIDER_PRICING_BANDS` is the single source of truth shared by
 *     the web-provider editor (renders the allowed range) and
 *     `service-provider` (enforces it at write time → 422). Sourcing
 *     the bands from a configurable `service_catalog` row is a
 *     follow-up (TS-204-followup-2 / TS-060-followup-2); today they
 *     live as a frozen constant so the wire shape stays stable while
 *     the storage home evolves.
 *
 * Money on the wire is **integer minor units** (cents) + a currency
 * code, mirroring the booking surface (`basePriceMinor` + `currency`).
 * The persistence layer stores `Decimal(12,2)` + `Char(3)`; the
 * service crosses that boundary exactly once per row per request
 * (CLAUDE.md §6 — "Round once, at presentation").
 *
 * Authorization model (CLAUDE.md §3.2 / TS-141). The `PUT` endpoint is
 * self-service-first: the authenticated user must own the
 * `providers.user_id` row matching the `:providerId` path param. Admin
 * override lands as a follow-up once `PermissionGuard` lifts to
 * `packages/nest-auth` via TS-052-followup-11 — captured as
 * TS-204-followup-3.
 */

// ─────────────────────────────────────────────────────────────────────
// Currency + absolute platform bounds
// ─────────────────────────────────────────────────────────────────────

/**
 * ISO-4217 currency code. Phase 1 launches USD-only (PRD §11.4 /
 * PDD §11.2); the contract accepts any 3-letter code so the wire shape
 * survives the Phase-3 multi-currency rollout without a v1 break
 * (mirrors the booking surface's `z.string().length(3)`). The service
 * rejects any non-USD code with a 422 until multi-currency lands.
 */
export const PROVIDER_PRICING_CURRENCY_CODE_LENGTH = 3;
export const PROVIDER_PRICING_DEFAULT_CURRENCY = 'USD' as const;

/**
 * Absolute platform rail on a submitted rate, in minor units. These
 * are deliberately wider than any per-tier band — they exist only to
 * reject a fat-finger / integer-overflow at the wire boundary
 * (`$0.01`–`$10,000`/hr). The binding per-tier band lives in
 * `PROVIDER_PRICING_BANDS` and is enforced server-side, so re-tuning a
 * band never forces a contract (v1) change.
 */
export const PROVIDER_PRICING_RATE_MIN_MINOR = 1;
export const PROVIDER_PRICING_RATE_MAX_MINOR = 1_000_000;

const HourlyRateMinorSchema = z
  .number()
  .int()
  .min(PROVIDER_PRICING_RATE_MIN_MINOR)
  .max(PROVIDER_PRICING_RATE_MAX_MINOR);

// ─────────────────────────────────────────────────────────────────────
// Platform tier bands (policy)
// ─────────────────────────────────────────────────────────────────────

/**
 * A single tier's allowed hourly-rate window, in minor units (cents).
 * `minHourlyRateMinor` ≤ `maxHourlyRateMinor` is guaranteed by the
 * `PROVIDER_PRICING_BANDS` constant below.
 */
export const ProviderPricingBandSchema = z
  .object({
    tier: ProviderTierSchema,
    minHourlyRateMinor: HourlyRateMinorSchema,
    maxHourlyRateMinor: HourlyRateMinorSchema,
  })
  .strict()
  .superRefine((band, ctx) => {
    if (band.minHourlyRateMinor > band.maxHourlyRateMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minHourlyRateMinor must be ≤ maxHourlyRateMinor',
        path: ['minHourlyRateMinor'],
      });
    }
  });
export type ProviderPricingBand = z.infer<typeof ProviderPricingBandSchema>;

/**
 * Platform-set min/max hourly-rate window per marketplace tier
 * (PRD §5.2 / §7.2). Values in minor units (USD cents). The window
 * widens with tier — a Basic provider's ceiling sits below an Elite
 * provider's floor + ceiling, reflecting the luxury-concierge
 * positioning (PRD §5.1 Tier 3 Concierge Lifestyle).
 *
 *   - `basic`     — $40–$80/hr  (4000–8000)
 *   - `certified` — $60–$120/hr (6000–12000)
 *   - `elite`     — $90–$250/hr (9000–25000)
 *
 * **Single source of truth.** The web-provider editor reads these to
 * render the allowed range; `service-provider` reads them to enforce
 * the band at write time (out-of-band → 422). Moving the bands into a
 * configurable `service_catalog` row (so ops can re-tune without a
 * deploy) is TS-204-followup-2 / TS-060-followup-2 — until then this
 * frozen object is the policy.
 */
export const PROVIDER_PRICING_BANDS: Readonly<
  Record<ProviderTier, { readonly minHourlyRateMinor: number; readonly maxHourlyRateMinor: number }>
> = {
  basic: { minHourlyRateMinor: 4000, maxHourlyRateMinor: 8000 },
  certified: { minHourlyRateMinor: 6000, maxHourlyRateMinor: 12000 },
  elite: { minHourlyRateMinor: 9000, maxHourlyRateMinor: 25000 },
};

/**
 * Resolve the platform band for a given tier as a `ProviderPricingBand`
 * record (the `{ tier, min, max }` shape the editor + record expose).
 */
export function resolveProviderPricingBand(tier: ProviderTier): ProviderPricingBand {
  const band = PROVIDER_PRICING_BANDS[tier];
  return {
    tier,
    minHourlyRateMinor: band.minHourlyRateMinor,
    maxHourlyRateMinor: band.maxHourlyRateMinor,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Request shape
// ─────────────────────────────────────────────────────────────────────

/**
 * Request body for `PUT /api/v1/providers/:providerId/pricing`.
 *
 * Full-replace semantics — the provider names the rate they want;
 * there is no PATCH-shaped partial. Both fields are required:
 *
 *   - `hourlyRateMinor` — the provider's quoted hourly rate in minor
 *     units. The contract enforces only the absolute platform rail;
 *     the per-tier band (which depends on the provider's CURRENT
 *     server-known tier, not a client-supplied value) is enforced
 *     server-side and rejects out-of-band rates with 422.
 *   - `currency` — ISO-4217 code. Phase-1 USD-only is enforced
 *     server-side (422 on any other code) rather than baked into the
 *     contract, so the wire shape survives the multi-currency rollout.
 *
 * Clearing a rate (back to "no rate set") is not a Phase-1 surface —
 * an active provider always carries a rate once they set one. A
 * future "pause my listing" flow would clear it via a dedicated
 * endpoint, not by sending null here.
 */
export const UpdateProviderPricingRequestSchema = z
  .object({
    hourlyRateMinor: HourlyRateMinorSchema,
    currency: z.string().length(PROVIDER_PRICING_CURRENCY_CODE_LENGTH),
  })
  .strict();
export type UpdateProviderPricingRequest = z.infer<typeof UpdateProviderPricingRequestSchema>;

// ─────────────────────────────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────────────────────────────

/**
 * Materialised pricing record for one provider.
 *
 *   - `hourlyRateMinor` / `currency` are nullable — a provider who has
 *     never set a rate reads `null` on both (the editor renders an
 *     empty rate input seeded with the band floor).
 *   - `tier` + `band` are always present so the editor renders the
 *     allowed range without a second fetch and the (future) booking-
 *     quote path can validate the rate it reads is still in-band.
 *   - `updatedAt` reflects the most-recent write to the pricing
 *     columns (it is the `providers.updated_at` timestamp; a pricing
 *     PUT bumps it). Doubles as the optimistic-concurrency token for
 *     the `If-Match` header (mirrors TS-200-followup-5).
 *
 * Used by:
 *   - `PUT /api/v1/providers/:providerId/pricing` response (TS-204).
 *   - `GET /api/v1/providers/me/pricing-snapshot` (wrapped nullable).
 *   - `GET /api/v1/providers/:providerId/pricing` (bare record; 404 on
 *     missing / soft-deleted) — the read the booking-quote path will
 *     consume once TS-204-followup-1 wires the rate into `final_price`.
 */
export const ProviderPricingRecordSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    status: ProviderStatusSchema,
    tier: ProviderTierSchema,
    hourlyRateMinor: HourlyRateMinorSchema.nullable(),
    currency: z.string().length(PROVIDER_PRICING_CURRENCY_CODE_LENGTH).nullable(),
    band: ProviderPricingBandSchema,
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    // `hourlyRateMinor` + `currency` are set together or cleared
    // together — a half-populated row is a data-integrity bug.
    const rateSet = record.hourlyRateMinor !== null;
    const currencySet = record.currency !== null;
    if (rateSet !== currencySet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'hourlyRateMinor and currency must both be set or both be null',
        path: ['hourlyRateMinor'],
      });
    }
  });
export type ProviderPricingRecord = z.infer<typeof ProviderPricingRecordSchema>;

/**
 * Response body for `PUT /api/v1/providers/:providerId/pricing`.
 * Wrapped in `{ pricing: ... }` so the shape is forward-compatible
 * with future side-payloads (e.g. a derived quote preview) without a
 * v1 break.
 */
export const UpdateProviderPricingResponseSchema = z
  .object({
    pricing: ProviderPricingRecordSchema,
  })
  .strict();
export type UpdateProviderPricingResponse = z.infer<typeof UpdateProviderPricingResponseSchema>;

/**
 * Response body for `GET /api/v1/providers/me/pricing-snapshot`.
 * `{ pricing: null }` when the authenticated user has no provider row
 * yet (pre-application); `{ pricing: ProviderPricingRecord }`
 * otherwise. The null branch lets the editor render an empty-state
 * placeholder without a 404 round-trip.
 */
export const ProviderPricingSnapshotResponseSchema = z
  .object({
    pricing: ProviderPricingRecordSchema.nullable(),
  })
  .strict();
export type ProviderPricingSnapshotResponse = z.infer<typeof ProviderPricingSnapshotResponseSchema>;
