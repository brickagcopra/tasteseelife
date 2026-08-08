import {
  SERVICE_CATALOG_DEFAULT_CURRENCY,
  type BookingServiceKind,
  type ProviderTier,
} from '@taste-and-see/contracts';

/**
 * Phase-1 service catalog — the canonical seven bookable service kinds
 * seeded into `booking.service_catalog` by `pnpm seed:catalog`
 * (TS-060-followup-2; PRD §5.4 / §6.3, PDD §8.2).
 *
 * **Source of truth.** This is the admin-editable catalog the platform
 * launches with. The names + descriptions mirror the constant
 * substitute in `../concierge/services/service-kind-defaults.ts`
 * (TS-125) so the two stay aligned until the booking-create flow is
 * migrated to read the catalog (TS-060-followup-2a) and the constant is
 * retired.
 *
 * **Rate bands.** PRD §5.4 prices commission rates, not per-service
 * dollar bands; the existing `service-kind-defaults.ts` carries a single
 * platform-default `basePriceMinor` per kind. The catalog widens that
 * into a `min`/`max` window — the floor anchors on the existing default
 * price; the ceiling is a conservative headroom (~+50–70%) reflecting
 * the per-visit variability (duration, distance, luxury tier). These
 * are starting anchors ops re-tunes via admin tooling
 * (TS-128-followup-6); the seed is idempotent on `kind` so a reseed
 * after a hand-edit only refreshes these columns.
 *
 * **Durations** are the default visit length per kind (the booking-
 * create quote will multiply the band by this once TS-060-followup-2a
 * wires it), taken from the `service-kind-defaults.ts` rationale
 * comments (e.g. companion dining = a 2-hour visit → 120 minutes).
 *
 * **Money is integer USD minor units (cents)** here; the seed function
 * crosses to the `Decimal(12,2)` column via `src/common/money.ts`.
 *
 * **Sort position** mirrors the `SERVICE_KIND_CATALOG` order so the
 * family-portal picker renders the kinds in a stable, intentional order.
 *
 * **Required provider tier (TS-220).** The first seven kinds are the
 * basic-marketplace services (`null` = any tier). The trailing six are
 * the Tier-3 concierge experiences (PRD §6.6) — each carries `'elite'`
 * because only Elite Concierge providers may fulfil them (CLAUDE.md §12).
 */
export interface SeedCatalogEntry {
  readonly kind: BookingServiceKind;
  readonly name: string;
  readonly description: string;
  /** Rate-band floor, integer USD minor units. */
  readonly baseRateMinMinor: number;
  /** Rate-band ceiling, integer USD minor units. `>= baseRateMinMinor`. */
  readonly baseRateMaxMinor: number;
  /** Default visit length, minutes. */
  readonly durationMinutes: number;
  readonly currency: typeof SERVICE_CATALOG_DEFAULT_CURRENCY;
  readonly active: boolean;
  /** Minimum provider tier; `null` = any tier (basic marketplace). */
  readonly requiredProviderTier: ProviderTier | null;
  readonly sortPosition: number;
}

export const SERVICE_CATALOG_SEED: readonly SeedCatalogEntry[] = [
  {
    kind: 'companion_dining',
    name: 'Companion dining',
    description: 'A chef prepares and shares a meal with your loved one.',
    baseRateMinMinor: 15_000, // $150
    baseRateMaxMinor: 25_000, // $250
    durationMinutes: 120,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: null,
    sortPosition: 0,
  },
  {
    kind: 'personal_chef_visit',
    name: 'Personal chef visit',
    description: 'A chef visits to cook a meal (or stock the fridge for the week).',
    baseRateMinMinor: 20_000, // $200
    baseRateMaxMinor: 35_000, // $350
    durationMinutes: 180,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: null,
    sortPosition: 1,
  },
  {
    kind: 'grocery_coordination',
    name: 'Grocery coordination',
    description: 'Shopping, pantry stocking, and meal prep for the week.',
    baseRateMinMinor: 8_000, // $80
    baseRateMaxMinor: 14_000, // $140
    durationMinutes: 60,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: null,
    sortPosition: 2,
  },
  {
    kind: 'transportation',
    name: 'Transportation',
    description: 'A companion accompanies your loved one to and from an appointment.',
    baseRateMinMinor: 6_500, // $65
    baseRateMaxMinor: 12_000, // $120
    durationMinutes: 90,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: null,
    sortPosition: 3,
  },
  {
    kind: 'social_outing',
    name: 'Social outing',
    description: 'A walk, a coffee, a museum visit — companionship out of the house.',
    baseRateMinMinor: 12_000, // $120
    baseRateMaxMinor: 22_000, // $220
    durationMinutes: 120,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: null,
    sortPosition: 4,
  },
  {
    kind: 'event_dining',
    name: 'Event dining',
    description: 'Birthday dinners, anniversaries, holiday meals catered at home.',
    baseRateMinMinor: 35_000, // $350
    baseRateMaxMinor: 60_000, // $600
    durationMinutes: 240,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: null,
    sortPosition: 5,
  },
  {
    kind: 'emergency_concierge',
    name: 'Emergency concierge',
    description: 'Same-day or next-day support after a hospital discharge or fall.',
    baseRateMinMinor: 25_000, // $250
    baseRateMaxMinor: 45_000, // $450
    durationMinutes: 120,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: null,
    sortPosition: 6,
  },
  // ── Tier-3 concierge experiences (PRD §6.6, TS-220) ───────────────────
  // Each is curated and Elite-provider-only (`requiredProviderTier:
  // 'elite'`, CLAUDE.md §12). Bands sit above their basic-marketplace
  // analogues to reflect the white-glove premium; these are starting
  // anchors ops re-tunes via admin tooling (TS-128-followup-6).
  {
    kind: 'holiday_dinner',
    name: 'Holiday dinner',
    description: 'A curated multi-course holiday dinner prepared and served at home.',
    baseRateMinMinor: 40_000, // $400
    baseRateMaxMinor: 80_000, // $800
    durationMinutes: 240,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: 'elite',
    sortPosition: 7,
  },
  {
    kind: 'birthday_experience',
    name: 'Birthday experience',
    description: 'A concierge-arranged birthday celebration with a personalised menu.',
    baseRateMinMinor: 35_000, // $350
    baseRateMaxMinor: 70_000, // $700
    durationMinutes: 180,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: 'elite',
    sortPosition: 8,
  },
  {
    kind: 'tea_social',
    name: 'Tea social',
    description: 'An afternoon tea social at home — pastries, conversation, and company.',
    baseRateMinMinor: 15_000, // $150
    baseRateMaxMinor: 30_000, // $300
    durationMinutes: 120,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: 'elite',
    sortPosition: 9,
  },
  {
    kind: 'museum_outing',
    name: 'Museum outing',
    description: 'A curated museum or cultural outing accompanied by an Elite companion.',
    baseRateMinMinor: 18_000, // $180
    baseRateMaxMinor: 35_000, // $350
    durationMinutes: 180,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: 'elite',
    sortPosition: 10,
  },
  {
    kind: 'memory_meal',
    name: 'Memory meal',
    description: 'A biographically-meaningful dish recreated to evoke a cherished memory.',
    baseRateMinMinor: 25_000, // $250
    baseRateMaxMinor: 50_000, // $500
    durationMinutes: 180,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: 'elite',
    sortPosition: 11,
  },
  {
    kind: 'custom_request',
    name: 'Custom request',
    description: 'A bespoke experience designed with your household’s dedicated concierge.',
    baseRateMinMinor: 20_000, // $200
    baseRateMaxMinor: 100_000, // $1,000
    durationMinutes: 180,
    currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
    active: true,
    requiredProviderTier: 'elite',
    sortPosition: 12,
  },
] as const;

/**
 * Compile-time guard against a duplicate `kind` landing in the seed.
 * The seed is idempotent on `kind`, but a duplicate here would silently
 * let one entry overwrite another — better caught at module-load time
 * than in the seed run. Also guards the band invariant (min ≤ max) so a
 * fat-fingered anchor can't seed an inverted band.
 */
const seenKinds = new Set<BookingServiceKind>();
for (const entry of SERVICE_CATALOG_SEED) {
  if (seenKinds.has(entry.kind)) {
    throw new Error(`SERVICE_CATALOG_SEED duplicate kind: ${entry.kind}`);
  }
  seenKinds.add(entry.kind);
  if (entry.baseRateMinMinor > entry.baseRateMaxMinor) {
    throw new Error(
      `SERVICE_CATALOG_SEED inverted band for ${entry.kind}: ${entry.baseRateMinMinor} > ${entry.baseRateMaxMinor}`,
    );
  }
}
