import { z } from 'zod';

import {
  AD_TARGETING_RULES_MAX,
  AdTargetingPredicateSchema,
  AdTargetingRuleKindSchema,
} from './ad-targeting.schema';
import { MediaAssetKeySchema, StoredMediaAssetKeySchema } from './media.schema';

/**
 * Ad-campaign admin HTTP DTOs (TS-271a; PRD §10.9; PDD §18.1, §8.2).
 *
 * The authenticated marketing-admin surface over the `service-ads` campaign
 * aggregate — a campaign, its renderable creatives, and its targeting rules
 * (the three `ads`-schema tables `ad_campaigns` / `ad_creatives` /
 * `ad_targeting_rules`). Every endpoint consuming these DTOs is gated on
 * `ads:read` / `ads:write` via `@RequirePermissions(...)` + `PermissionGuard`
 * (CLAUDE.md §3.2); the gateway BFF (TS-271b) enforces the same gate at the
 * edge (defence-in-depth).
 *
 * **Platform-wide inventory.** A campaign carries no per-household tenant axis
 * — it is marketing-admin-managed inventory (the `AdCampaign` Prisma model is
 * in service-ads's `unscopedModels`, mirroring `Plan` in service-subscription).
 * The advertiser axis (`advertiserId`) is a soft FK (CLAUDE.md §2.3 — id only),
 * NOT a request-context tenant scope.
 *
 * **Money discipline.** `budgetMinor` is the optional spend cap in integer
 * **minor units** (USD cents) + an explicit `currency` code — the universal
 * platform wire convention (booking `basePriceMinor`, payouts `amountMinor`,
 * provider-pricing `hourlyRateMinor`). NEVER a float (CLAUDE.md §4.1, §17.6).
 * The persistence layer stores `Decimal(12,2)` + `currency`; the service
 * crosses that boundary exactly once per row per request. `null` = uncapped.
 * Phase-1 is USD-only (enforced server-side → 422 on any other code, so the
 * wire shape survives the Phase-3 multi-currency rollout without a v1 break).
 *
 * **Targeting seam.** A campaign's targeting rules reuse the shared TS-273
 * grammar (`ad-targeting.schema.ts`): each rule is `{ kind, predicate }` on the
 * wire, serialised to the `ad_targeting_rules.value` TEXT column via
 * `JSON.stringify(predicate)` on write and decoded via `parseAdTargetingPredicate`
 * on read. The delivery evaluator (TS-218 / TS-275) AND-combines them.
 *
 * **Creative media seam.** `assetKeys` reference `media-svc` (TS-110) S3 assets
 * by key — never a URL or a Prisma relation (CLAUDE.md §2.3, §3.4).
 *
 * **`.strict()` everywhere** — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped campaign / creative / rule row id cap. */
export const AD_CAMPAIGN_ID_MAX_LENGTH = 36;

/** Operator-facing campaign name (admin UI / reporting label). */
export const AD_CAMPAIGN_NAME_MAX_LENGTH = 200;

/** Soft-FK advertiser id (service-partner / service-provider row id). */
export const AD_CAMPAIGN_ADVERTISER_ID_MAX_LENGTH = 64;

/** ISO-4217 currency code length. Phase-1 USD-only (enforced server-side). */
export const AD_CAMPAIGN_CURRENCY_CODE_LENGTH = 3;
export const AD_CAMPAIGN_DEFAULT_CURRENCY = 'USD' as const;

/**
 * Budget spend cap, in minor units (USD cents). `Decimal(12,2)` stores up to
 * 10 integer digits, so the absolute envelope is far larger — this cap
 * ($999,999.99) is a fat-finger / overflow rail at the wire boundary, well
 * above any realistic single-campaign budget. `null` = uncapped.
 */
export const AD_CAMPAIGN_BUDGET_MINOR_MAX = 99_999_999;

/** Creative headline shown on the rendered ad. */
export const AD_CREATIVE_HEADLINE_MAX_LENGTH = 200;

/** Optional supporting copy on the creative. */
export const AD_CREATIVE_BODY_MAX_LENGTH = 2_000;

/** Click-through destination URL. */
export const AD_CREATIVE_CTA_URL_MAX_LENGTH = 2_048;

/** A single media-svc S3 asset key + the per-creative key-list cap. */
/**
 * @deprecated TS-282-followup-5a — kept only so any external reference still
 * resolves. An assetKey is a media asset id and is bounded by
 * `MEDIA_ID_MAX_LENGTH` (64); this 512 was a local invention that never
 * matched anything on the media side.
 */
export const AD_CREATIVE_ASSET_KEY_MAX_LENGTH = 512;
export const AD_CREATIVE_ASSET_KEYS_MAX = 10;

/** Max creatives / targeting rules accepted in one nested campaign-create. */
export const AD_CAMPAIGN_CREATIVES_MAX = 20;
export const AD_CAMPAIGN_TARGETING_RULES_MAX = AD_TARGETING_RULES_MAX;

/** Admin campaigns-list caps. Bounded, no cursor at Phase-1 catalog volume. */
export const AD_CAMPAIGNS_LIST_LIMIT_DEFAULT = 50;
export const AD_CAMPAIGNS_LIST_LIMIT_MAX = 200;

// ─── Enums (mirror the Prisma enums 1:1) ─────────────────────────────────

/**
 * Who an ad campaign belongs to — mirrors the `AdvertiserKind` Prisma enum
 * (PDD §8.2). `partner` (co-marketing slot) · `provider` (sponsored listing) ·
 * `internal` (house ad; `advertiserId` null). Additive only.
 */
export const AdvertiserKindSchema = z.enum(['partner', 'provider', 'internal']);
export type AdvertiserKind = z.infer<typeof AdvertiserKindSchema>;

/**
 * Campaign lifecycle — mirrors the `AdCampaignStatus` Prisma enum (PDD §18.1).
 * `draft` · `scheduled` · `active` · `paused` · `completed` · `archived`.
 */
export const AdCampaignStatusSchema = z.enum([
  'draft',
  'scheduled',
  'active',
  'paused',
  'completed',
  'archived',
]);
export type AdCampaignStatus = z.infer<typeof AdCampaignStatusSchema>;

/**
 * The status a campaign may be CREATED in. A campaign cannot be created
 * straight into `paused` / `completed` / `archived` (those are transitions off
 * a live campaign). `draft` (default, the compose buffer), `scheduled`
 * (approved + dated), or `active` (create-and-go-live).
 */
export const InitialAdCampaignStatusSchema = z.enum(['draft', 'scheduled', 'active']);
export type InitialAdCampaignStatus = z.infer<typeof InitialAdCampaignStatusSchema>;

/**
 * Creative rendered form — mirrors the `AdCreativeKind` Prisma enum (PDD §18.1).
 * `banner` · `sponsored_listing` · `sponsored_content` · `partner_card`.
 */
export const AdCreativeKindSchema = z.enum([
  'banner',
  'sponsored_listing',
  'sponsored_content',
  'partner_card',
]);
export type AdCreativeKind = z.infer<typeof AdCreativeKindSchema>;

/**
 * Creative review lifecycle — mirrors the `AdCreativeStatus` Prisma enum (PDD
 * §18.3). `draft` · `pending_review` · `approved` · `rejected` · `archived`.
 * Only an `approved` creative carries deliverability.
 */
export const AdCreativeStatusSchema = z.enum([
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'archived',
]);
export type AdCreativeStatus = z.infer<typeof AdCreativeStatusSchema>;

/**
 * The status a creative may be CREATED in (nested under a campaign-create).
 * `draft` (default) or `pending_review` (submit-on-create). Approval / rejection
 * is a transition driven by the creative-status PATCH (the deliverability lever;
 * the full TS-277 approval + accessibility workflow gates `approved`).
 */
export const InitialAdCreativeStatusSchema = z.enum(['draft', 'pending_review']);
export type InitialAdCreativeStatus = z.infer<typeof InitialAdCreativeStatusSchema>;

// ─── Status-transition policy ───────────────────────────────────────────

/**
 * Allowed campaign status transitions, keyed by the current status. Shared
 * between the service (which enforces the matrix) and the web-admin UI (which
 * renders only the valid actions) so the two never drift. A no-op same-status
 * PATCH is allowed (handled before the matrix is consulted).
 *
 *   - `draft`     → scheduled / active / archived
 *   - `scheduled` → draft / active / paused / archived
 *   - `active`    → paused / completed / archived
 *   - `paused`    → active / completed / archived
 *   - `completed` → archived (retire to reporting)
 *   - `archived`  → ∅ (terminal)
 */
export const AD_CAMPAIGN_STATUS_TRANSITIONS = {
  draft: ['scheduled', 'active', 'archived'],
  scheduled: ['draft', 'active', 'paused', 'archived'],
  active: ['paused', 'completed', 'archived'],
  paused: ['active', 'completed', 'archived'],
  completed: ['archived'],
  archived: [],
} as const satisfies Record<AdCampaignStatus, readonly AdCampaignStatus[]>;

/** `true` when `from → to` is an allowed campaign status transition. */
export function canTransitionAdCampaign(from: AdCampaignStatus, to: AdCampaignStatus): boolean {
  return (AD_CAMPAIGN_STATUS_TRANSITIONS[from] as readonly AdCampaignStatus[]).includes(to);
}

/** `true` when `status` is a terminal campaign status (no outgoing transitions). */
export function isAdCampaignTerminal(status: AdCampaignStatus): boolean {
  return AD_CAMPAIGN_STATUS_TRANSITIONS[status].length === 0;
}

/**
 * Allowed creative status transitions, keyed by the current status.
 *
 *   - `draft`          → pending_review / archived
 *   - `pending_review` → draft / approved / rejected / archived
 *   - `approved`       → rejected / archived
 *   - `rejected`       → draft / archived
 *   - `archived`       → ∅ (terminal)
 */
export const AD_CREATIVE_STATUS_TRANSITIONS = {
  draft: ['pending_review', 'archived'],
  pending_review: ['draft', 'approved', 'rejected', 'archived'],
  approved: ['rejected', 'archived'],
  rejected: ['draft', 'archived'],
  archived: [],
} as const satisfies Record<AdCreativeStatus, readonly AdCreativeStatus[]>;

/** `true` when `from → to` is an allowed creative status transition. */
export function canTransitionAdCreative(from: AdCreativeStatus, to: AdCreativeStatus): boolean {
  return (AD_CREATIVE_STATUS_TRANSITIONS[from] as readonly AdCreativeStatus[]).includes(to);
}

/** `true` when `status` is a terminal creative status (no outgoing transitions). */
export function isAdCreativeTerminal(status: AdCreativeStatus): boolean {
  return AD_CREATIVE_STATUS_TRANSITIONS[status].length === 0;
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(AD_CAMPAIGN_ID_MAX_LENGTH);
const NameSchema = z.string().trim().min(1, 'a name is required').max(AD_CAMPAIGN_NAME_MAX_LENGTH);
const AdvertiserIdSchema = z.string().trim().min(1).max(AD_CAMPAIGN_ADVERTISER_ID_MAX_LENGTH);
const CurrencySchema = z.string().length(AD_CAMPAIGN_CURRENCY_CODE_LENGTH);
const BudgetMinorSchema = z.number().int().min(0).max(AD_CAMPAIGN_BUDGET_MINOR_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

const HeadlineSchema = z
  .string()
  .trim()
  .min(1, 'a headline is required')
  .max(AD_CREATIVE_HEADLINE_MAX_LENGTH);
const BodySchema = z.string().trim().min(1).max(AD_CREATIVE_BODY_MAX_LENGTH);
const CtaUrlSchema = z
  .string()
  .trim()
  .url('ctaUrl must be a valid URL')
  .max(AD_CREATIVE_CTA_URL_MAX_LENGTH);
/**
 * TS-282-followup-5a — the WRITE-side key list. An `assetKey` is a
 * `media_assets.id`; the shared schema is the single definition of that,
 * replacing the local unconstrained string this file used to declare.
 */
const AssetKeysSchema = z.array(MediaAssetKeySchema).max(AD_CREATIVE_ASSET_KEYS_MAX);
/**
 * The READ-side list. Deliberately still permissive: creatives written before
 * the convention landed may carry values that were never a media id, and a
 * tightened response schema would turn one of those rows into a gateway 502
 * on a page that renders fine today (see `StoredMediaAssetKeySchema`).
 */
const StoredAssetKeysSchema = z.array(StoredMediaAssetKeySchema).max(AD_CREATIVE_ASSET_KEYS_MAX);

// ─── Record shapes ──────────────────────────────────────────────────────

/** A renderable creative bound to a campaign. */
export const AdCreativeRecordSchema = z
  .object({
    id: IdSchema,
    campaignId: IdSchema,
    kind: AdCreativeKindSchema,
    assetKeys: StoredAssetKeysSchema,
    headline: HeadlineSchema,
    body: BodySchema.nullable(),
    ctaUrl: CtaUrlSchema.nullable(),
    status: AdCreativeStatusSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AdCreativeRecord = z.infer<typeof AdCreativeRecordSchema>;

/**
 * A targeting rule on a campaign, with its predicate DECODED from the persisted
 * `value` TEXT into the shared TS-273 AST. A row whose persisted `value` fails
 * to decode is omitted from the detail read (the same fail-closed posture the
 * delivery evaluator takes) — the admin never sees a half-parsed rule.
 */
export const AdTargetingRuleRecordSchema = z
  .object({
    id: IdSchema,
    campaignId: IdSchema,
    kind: AdTargetingRuleKindSchema,
    predicate: AdTargetingPredicateSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AdTargetingRuleRecord = z.infer<typeof AdTargetingRuleRecordSchema>;

/**
 * Full campaign record (shallow — no nested creatives / rules). Returned by the
 * list + the single-campaign create / update envelopes.
 */
export const AdCampaignRecordSchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    advertiserKind: AdvertiserKindSchema,
    advertiserId: AdvertiserIdSchema.nullable(),
    status: AdCampaignStatusSchema,
    budgetMinor: BudgetMinorSchema.nullable(),
    currency: CurrencySchema,
    startAt: TimestampSchema.nullable(),
    endAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AdCampaignRecord = z.infer<typeof AdCampaignRecordSchema>;

/**
 * Campaign record WITH its creatives + targeting rules. Returned by
 * `GET /api/v1/admin/ads/campaigns/:campaignId` (the campaign-editor hydration).
 */
export const AdCampaignDetailSchema = AdCampaignRecordSchema.extend({
  creatives: z.array(AdCreativeRecordSchema),
  targetingRules: z.array(AdTargetingRuleRecordSchema),
}).strict();
export type AdCampaignDetail = z.infer<typeof AdCampaignDetailSchema>;

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * A creative to create alongside its campaign (nested under campaign-create).
 * `status` defaults to `draft`; `assetKeys` defaults to the empty list (keys
 * are attached as the media-svc upload flow completes).
 */
export const CreateAdCreativeInputSchema = z
  .object({
    kind: AdCreativeKindSchema,
    assetKeys: AssetKeysSchema.default([]),
    headline: HeadlineSchema,
    body: BodySchema.optional(),
    ctaUrl: CtaUrlSchema.optional(),
    status: InitialAdCreativeStatusSchema.default('draft'),
  })
  .strict();
export type CreateAdCreativeInput = z.infer<typeof CreateAdCreativeInputSchema>;

/**
 * A targeting rule to create alongside its campaign. `{ kind, predicate }` — the
 * shared TS-273 grammar. `predicate` is persisted as `JSON.stringify(predicate)`
 * in the `ad_targeting_rules.value` TEXT column.
 */
export const CreateAdTargetingRuleInputSchema = z
  .object({
    kind: AdTargetingRuleKindSchema,
    predicate: AdTargetingPredicateSchema,
  })
  .strict();
export type CreateAdTargetingRuleInput = z.infer<typeof CreateAdTargetingRuleInputSchema>;

/**
 * `POST /api/v1/admin/ads/campaigns` body — create a campaign, optionally with
 * its initial creatives + targeting rules (applied in one transaction). `status`
 * defaults to `draft`. `budgetMinor` / `startAt` / `endAt` are optional (a draft
 * campaign may be incomplete). `advertiserId` is required for a `partner` /
 * `provider` campaign and MUST be null for an `internal` house ad (enforced by
 * the cross-field refine). When both `startAt` + `endAt` are present, `endAt`
 * must be strictly after `startAt`.
 */
export const CreateAdCampaignRequestSchema = z
  .object({
    name: NameSchema,
    advertiserKind: AdvertiserKindSchema,
    advertiserId: AdvertiserIdSchema.nullable().default(null),
    budgetMinor: BudgetMinorSchema.optional(),
    currency: CurrencySchema.default(AD_CAMPAIGN_DEFAULT_CURRENCY),
    startAt: TimestampSchema.optional(),
    endAt: TimestampSchema.optional(),
    status: InitialAdCampaignStatusSchema.default('draft'),
    creatives: z.array(CreateAdCreativeInputSchema).max(AD_CAMPAIGN_CREATIVES_MAX).optional(),
    targetingRules: z
      .array(CreateAdTargetingRuleInputSchema)
      .max(AD_CAMPAIGN_TARGETING_RULES_MAX)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.advertiserKind === 'internal') {
      if (value.advertiserId !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'advertiserId must be null for an internal house ad',
          path: ['advertiserId'],
        });
      }
    } else if (value.advertiserId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `advertiserId is required for a ${value.advertiserKind} campaign`,
        path: ['advertiserId'],
      });
    }
    if (
      value.startAt !== undefined &&
      value.endAt !== undefined &&
      Date.parse(value.endAt) <= Date.parse(value.startAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endAt must be after startAt',
        path: ['endAt'],
      });
    }
  });
export type CreateAdCampaignRequest = z.infer<typeof CreateAdCampaignRequestSchema>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/ads/campaigns/:campaignId` body — a partial update. At
 * least one field must be present. Nullable fields (`advertiserId`,
 * `budgetMinor`, `startAt`, `endAt`) accept `null` to CLEAR the value. A
 * `status` change must be an allowed transition (validated server-side; a
 * disallowed move is a 409). `advertiserKind` is NOT editable — a different
 * advertiser kind is a different campaign. Cross-field window / advertiser-id
 * integrity is re-validated server-side against the merged row.
 */
export const UpdateAdCampaignRequestSchema = z
  .object({
    name: NameSchema.optional(),
    advertiserId: AdvertiserIdSchema.nullable().optional(),
    budgetMinor: BudgetMinorSchema.nullable().optional(),
    currency: CurrencySchema.optional(),
    startAt: TimestampSchema.nullable().optional(),
    endAt: TimestampSchema.nullable().optional(),
    status: AdCampaignStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one field must be supplied',
      });
    }
  });
export type UpdateAdCampaignRequest = z.infer<typeof UpdateAdCampaignRequestSchema>;

/**
 * `PATCH /api/v1/admin/ads/campaigns/:campaignId/creatives/:creativeId` body —
 * advance a creative through its review lifecycle (the deliverability lever).
 * The full approval + accessibility workflow lands in TS-277.
 */
export const UpdateAdCreativeStatusRequestSchema = z
  .object({
    status: AdCreativeStatusSchema,
  })
  .strict();
export type UpdateAdCreativeStatusRequest = z.infer<typeof UpdateAdCreativeStatusRequestSchema>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/ads/campaigns` query. With no filters the list returns all
 * campaigns ordered by `createdAt` descending. `status` / `advertiserKind`
 * narrow the result.
 */
export const ListAdCampaignsQuerySchema = z
  .object({
    status: AdCampaignStatusSchema.optional(),
    advertiserKind: AdvertiserKindSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(AD_CAMPAIGNS_LIST_LIMIT_MAX)
      .default(AD_CAMPAIGNS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListAdCampaignsQuery = z.infer<typeof ListAdCampaignsQuerySchema>;

// ─── Response envelopes ─────────────────────────────────────────────────

/** Single-campaign envelope returned by create / update. */
export const AdCampaignResponseSchema = z.object({ campaign: AdCampaignRecordSchema }).strict();
export type AdCampaignResponse = z.infer<typeof AdCampaignResponseSchema>;

/** Campaign-detail envelope returned by `GET .../campaigns/:campaignId`. */
export const AdCampaignDetailResponseSchema = z
  .object({ campaign: AdCampaignDetailSchema })
  .strict();
export type AdCampaignDetailResponse = z.infer<typeof AdCampaignDetailResponseSchema>;

/** `GET /api/v1/admin/ads/campaigns` response — the matching campaigns. */
export const AdCampaignsListResponseSchema = z
  .object({ campaigns: z.array(AdCampaignRecordSchema) })
  .strict();
export type AdCampaignsListResponse = z.infer<typeof AdCampaignsListResponseSchema>;

/** Single-creative envelope returned by the creative-status PATCH. */
export const AdCreativeResponseSchema = z.object({ creative: AdCreativeRecordSchema }).strict();
export type AdCreativeResponse = z.infer<typeof AdCreativeResponseSchema>;
