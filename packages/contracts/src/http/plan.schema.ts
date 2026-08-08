import { z } from 'zod';

/**
 * Subscription plan customer group. Mirrors PRD §5.
 *
 * - `family` — senior/family memberships (Tier 1 Essential, Tier 2 Companion
 *   Dining, Tier 3 Concierge Lifestyle).
 * - `provider` — chef / caregiver subscriptions (Basic, Certified Culinary
 *   Companion, Elite Concierge Provider).
 * - `academy` — Cooking Academy memberships (online, in-person, monthly).
 */
export const PlanCustomerGroupSchema = z.enum(['family', 'provider', 'academy']);
export type PlanCustomerGroup = z.infer<typeof PlanCustomerGroupSchema>;

/**
 * Currency code. Single-currency at launch (USD); the schema is enum-shaped
 * so adding new currencies (Phase 3) is a breaking-but-explicit contract
 * change rather than silently accepting an unknown ISO code.
 */
export const PlanCurrencySchema = z.enum(['USD']);
export type PlanCurrency = z.infer<typeof PlanCurrencySchema>;

/**
 * Subscription plan DTO.
 *
 * Money is transmitted as **integer minor units** (`monthlyPriceUsdMinor`,
 * `annualPriceUsdMinor`) — no floats over the wire, per CLAUDE.md §4.1 and
 * §17.6. The accounting service stores money as `Decimal(12,2)` internally
 * and presents it via this DTO. Consumers convert to `Decimal` (or, for UI,
 * format via `Intl.NumberFormat`) — they MUST NOT do float math on these
 * values.
 *
 * `.strict()` rejects unknown fields at parse time, matching CLAUDE.md §3.3
 * "Reject unknown fields by default."
 */
export const PlanSchema = z
  .object({
    id: z.string().min(1).max(64),
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9._-]*$/, 'must be lower-case kebab/dot-case (e.g. "family.tier1")'),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    customerGroup: PlanCustomerGroupSchema,
    monthlyPriceUsdMinor: z.number().int().min(0),
    annualPriceUsdMinor: z.number().int().min(0),
    currency: PlanCurrencySchema.default('USD'),
    features: z.array(z.string().max(160)).max(64),
    active: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type Plan = z.infer<typeof PlanSchema>;

/**
 * Response body for `GET /api/v1/plans`.
 *
 * Wrapped in `{ plans: [...] }` (rather than returning a bare array) so the
 * response shape is forward-compatible with future pagination metadata
 * (`nextCursor`, `total`) and provider-side filter facets, neither of which
 * we want to introduce as a breaking v1 change.
 *
 * `.strict()` rejects unknown top-level fields. Service consumers that
 * support a future field set must opt in with a contract change, not by
 * silently accepting drift.
 */
export const PlansListResponseSchema = z
  .object({
    plans: z.array(PlanSchema),
  })
  .strict();
export type PlansListResponse = z.infer<typeof PlansListResponseSchema>;
