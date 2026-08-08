import type { BookingServiceKind } from '@taste-and-see/contracts';

/**
 * Phase-1 platform-default pricing per `BookingServiceKind` (TS-125;
 * PRD §5.4 commission rates; PRD §6.3 service catalog).
 *
 * The family-portal manual-matching booking-request surface does NOT
 * let the family enter dollar amounts. The concierge-request endpoint
 * looks up the default for the requested `serviceKind` here, derives
 * the price + commission, and persists the booking with those numbers.
 * The concierge team can adjust per-booking later via admin tooling
 * (TS-128).
 *
 * **Phase-1 simplification.** These values are constants and apply
 * uniformly to every household + provider. The real `service_catalog`
 * table (TS-060-followup-2 / TS-125-followup-8) materialises them as
 * an admin-editable table with per-region / per-tier overrides; this
 * file is the temporary substitute. Numbers are conservative anchors
 * derived from PRD §5.4 commission bands (10% Elite / 20% Certified /
 * 30% Basic) — we use 20% as the platform-default rate here, leaving
 * tier-aware rate to TS-125-followup-8.
 *
 * Money is integer USD minor units throughout (CLAUDE.md §6 / §17.6).
 * `commissionRateBps` is basis-points (10000 = 100%).
 *
 * The companion `DEFAULT_CURRENCY` codifies PRD §11.4 ("USD only
 * initially").
 */

export const DEFAULT_CURRENCY = 'USD';
export const DEFAULT_COMMISSION_RATE_BPS = 2_000;

export interface ServiceKindDefault {
  /** Base price for the service, integer USD minor units. */
  readonly basePriceMinor: number;
  /** Commission rate, basis-points (10000 = 100%). */
  readonly commissionRateBps: number;
  /** ISO 4217 currency. Phase 1 is USD-only. */
  readonly currency: string;
  /** Human-readable label for the family-portal UI. */
  readonly label: string;
  /** Description text rendered next to the picker. */
  readonly description: string;
}

const DEFAULTS: Readonly<Record<BookingServiceKind, ServiceKindDefault>> = {
  companion_dining: {
    basePriceMinor: 15_000, // $150.00 — 2-hour visit at $75/hr.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Companion dining',
    description: 'A chef prepares and shares a meal with your loved one.',
  },
  personal_chef_visit: {
    basePriceMinor: 20_000, // $200.00 — 3-hour visit at ~$67/hr.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Personal chef visit',
    description: 'A chef visits to cook a meal (or stock the fridge for the week).',
  },
  grocery_coordination: {
    basePriceMinor: 8_000, // $80.00 — 1-hour visit at $80/hr.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Grocery coordination',
    description: 'Shopping, pantry stocking, and meal prep for the week.',
  },
  transportation: {
    basePriceMinor: 6_500, // $65.00 — 1.5-hour round-trip companion ride.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Transportation',
    description: 'A companion accompanies your loved one to and from an appointment.',
  },
  social_outing: {
    basePriceMinor: 12_000, // $120.00 — 2-hour outing at $60/hr.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Social outing',
    description: 'A walk, a coffee, a museum visit — companionship out of the house.',
  },
  event_dining: {
    basePriceMinor: 35_000, // $350.00 — 4-hour event with full meal.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Event dining',
    description: 'Birthday dinners, anniversaries, holiday meals catered at home.',
  },
  emergency_concierge: {
    basePriceMinor: 25_000, // $250.00 — short-notice premium.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Emergency concierge',
    description: 'Same-day or next-day support after a hospital discharge or fall.',
  },
  // Tier-3 concierge experiences (PRD §6.6, TS-220). The base price
  // anchors on the catalog band floor (`seed-catalog.ts`); commission
  // stays the platform default until TS-125-followup-8 makes it
  // tier-aware. These kinds require an Elite provider — the gate lives
  // on `service_catalog.required_provider_tier` (CLAUDE.md §12).
  holiday_dinner: {
    basePriceMinor: 40_000, // $400.00 — curated multi-course holiday dinner.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Holiday dinner',
    description: 'A curated multi-course holiday dinner prepared and served at home.',
  },
  birthday_experience: {
    basePriceMinor: 35_000, // $350.00 — personalised birthday celebration.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Birthday experience',
    description: 'A concierge-arranged birthday celebration with a personalised menu.',
  },
  tea_social: {
    basePriceMinor: 15_000, // $150.00 — afternoon tea social at home.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Tea social',
    description: 'An afternoon tea social at home — pastries, conversation, and company.',
  },
  museum_outing: {
    basePriceMinor: 18_000, // $180.00 — curated cultural outing.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Museum outing',
    description: 'A curated museum or cultural outing accompanied by an Elite companion.',
  },
  memory_meal: {
    basePriceMinor: 25_000, // $250.00 — biographically-meaningful memory meal.
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Memory meal',
    description: 'A biographically-meaningful dish recreated to evoke a cherished memory.',
  },
  custom_request: {
    basePriceMinor: 20_000, // $200.00 — bespoke concierge experience (wide band).
    commissionRateBps: DEFAULT_COMMISSION_RATE_BPS,
    currency: DEFAULT_CURRENCY,
    label: 'Custom request',
    description: 'A bespoke experience designed with your household’s dedicated concierge.',
  },
};

/**
 * Lookup the platform default for a given service kind. The argument
 * is type-narrowed to `BookingServiceKind` so callers can't pass an
 * arbitrary string — TypeScript exhaustiveness on the union guarantees
 * every kind has an entry in DEFAULTS.
 */
export function getServiceKindDefault(kind: BookingServiceKind): ServiceKindDefault {
  return DEFAULTS[kind];
}

/**
 * The full catalog, in a stable order for UI rendering. Family-portal
 * pickers iterate this array so a newly-added service kind shows up
 * automatically without a portal-side change.
 */
export const SERVICE_KIND_CATALOG: ReadonlyArray<
  ServiceKindDefault & { readonly kind: BookingServiceKind }
> = [
  { kind: 'companion_dining', ...DEFAULTS.companion_dining },
  { kind: 'personal_chef_visit', ...DEFAULTS.personal_chef_visit },
  { kind: 'grocery_coordination', ...DEFAULTS.grocery_coordination },
  { kind: 'transportation', ...DEFAULTS.transportation },
  { kind: 'social_outing', ...DEFAULTS.social_outing },
  { kind: 'event_dining', ...DEFAULTS.event_dining },
  { kind: 'emergency_concierge', ...DEFAULTS.emergency_concierge },
  { kind: 'holiday_dinner', ...DEFAULTS.holiday_dinner },
  { kind: 'birthday_experience', ...DEFAULTS.birthday_experience },
  { kind: 'tea_social', ...DEFAULTS.tea_social },
  { kind: 'museum_outing', ...DEFAULTS.museum_outing },
  { kind: 'memory_meal', ...DEFAULTS.memory_meal },
  { kind: 'custom_request', ...DEFAULTS.custom_request },
];
