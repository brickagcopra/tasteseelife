import { z } from 'zod';

import { AdCreativeRecordSchema, type AdCreativeKind } from './ads-campaign.schema';

/**
 * Ad-creative approval-workflow + accessibility-check DTOs (TS-277; PRD §10.9;
 * PDD §18.3 — "Compliance & Approval").
 *
 * The marketing-admin surface that reviews partner-submitted creatives before
 * they become deliverable. Two trust tiers gate it:
 *
 *   - `ads:write`                 — the campaign author edits a creative's
 *                                    accessibility metadata + submits it for
 *                                    review (the draft → pending_review move
 *                                    already lives on the TS-271a creative-status
 *                                    PATCH).
 *   - `marketing:approve_creative` — the reviewer works the queue and approves /
 *                                    rejects / requests-changes. A SEPARATE,
 *                                    higher-trust gate (PDD Appendix B) so the
 *                                    author cannot self-approve their own creative.
 *
 * **Accessibility checks (PDD §18.3 — "Accessibility checks on creative assets:
 * alt text, contrast").** Each creative carries declared accessibility metadata
 * (`altText`, `textColor`, `backgroundColor`, `motionSafe`, `disclosureAcknowledged`).
 * `evaluateCreativeAccessibility` is a PURE function over that metadata — it runs
 * the four checks (alt-text presence, WCAG contrast ratio, motion sensitivity,
 * mandatory-disclosure acknowledgement) and returns a structured report. The
 * service runs it at decision time and SNAPSHOTS the report onto the immutable
 * review record. A failing report does not hard-block approval, but the reviewer
 * must explicitly acknowledge the failures (audited override + reason) — the more
 * correct real-world model than a silent gate (CLAUDE.md §16).
 *
 * The contrast computation follows WCAG 2.1 relative-luminance — a deterministic
 * function of two declared hex colours, unit-tested to the spec. Image bytes are
 * NOT analysed here (the media pipeline — TS-110 — is a separate concern); the
 * checks operate on the submitter's DECLARED metadata, which is what a human
 * reviewer cross-checks against the rendered asset.
 *
 * `.strict()` everywhere — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/** CUID-shaped row id cap (matches `AD_CAMPAIGN_ID_MAX_LENGTH`). */
export const AD_CREATIVE_REVIEW_ID_MAX_LENGTH = 36;

/** Acting reviewer / author user id (a CUID from the verified token). */
export const AD_CREATIVE_REVIEW_REVIEWER_ID_MAX_LENGTH = 64;

/** Alt text for the creative's primary asset (screen-reader description). */
export const AD_CREATIVE_ALT_TEXT_MAX_LENGTH = 500;

/** Reviewer notes / rejection reason. Required for reject + request-changes. */
export const AD_CREATIVE_REVIEW_NOTES_MAX_LENGTH = 2_000;

/** Review-queue list cap. Bounded, no cursor at Phase-1 review volume. */
export const AD_CREATIVE_REVIEW_QUEUE_LIMIT_DEFAULT = 50;
export const AD_CREATIVE_REVIEW_QUEUE_LIMIT_MAX = 200;

/**
 * WCAG 2.1 AA contrast ratio for normal-size text (1.4.3). The creative's
 * declared text colour over its declared background must clear this to pass the
 * contrast check. Stored as a constant so the threshold is single-sourced and
 * the web-admin surface can explain it.
 */
export const AD_CREATIVE_CONTRAST_AA_NORMAL = 4.5;

/**
 * Creative kinds that render a bespoke image / styled card and therefore OWN
 * their alt-text + contrast obligation. `sponsored_listing` is the data-driven
 * sponsored provider result rendered by the app's own accessible components
 * (TS-218b) — its alt-text / contrast is the app's responsibility, so those two
 * checks report `not_applicable` for it.
 */
export const AD_IMAGE_BEARING_CREATIVE_KINDS = [
  'banner',
  'sponsored_content',
  'partner_card',
] as const satisfies readonly AdCreativeKind[];

/** `true` when a creative kind owns an image / styled-card a11y obligation. */
export function isImageBearingCreativeKind(kind: AdCreativeKind): boolean {
  return (AD_IMAGE_BEARING_CREATIVE_KINDS as readonly AdCreativeKind[]).includes(kind);
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(AD_CREATIVE_REVIEW_ID_MAX_LENGTH);
const ReviewerIdSchema = z.string().min(1).max(AD_CREATIVE_REVIEW_REVIEWER_ID_MAX_LENGTH);
const TimestampSchema = z.string().datetime({ offset: true });

/**
 * A 3- or 6-digit hex colour (`#abc` / `#aabbcc`). Case-insensitive. The wire
 * shape for the declared text / background colours the contrast check consumes.
 */
export const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const HexColorSchema = z
  .string()
  .trim()
  .regex(HEX_COLOR_REGEX, 'must be a 3- or 6-digit hex colour, e.g. #1a2b3c');

const AltTextSchema = z.string().trim().min(1).max(AD_CREATIVE_ALT_TEXT_MAX_LENGTH);
const NotesSchema = z.string().trim().min(1).max(AD_CREATIVE_REVIEW_NOTES_MAX_LENGTH);

// ─── Accessibility metadata ─────────────────────────────────────────────

/**
 * The accessibility metadata declared on a creative — the inputs the checks
 * evaluate. All optional / defaulted: a creative starts with no alt text or
 * colours (added before review), `motionSafe` true (a still asset is the
 * default), and `disclosureAcknowledged` false (the author must affirm it).
 */
export const AdCreativeAccessibilityMetadataSchema = z
  .object({
    altText: AltTextSchema.nullable(),
    textColor: HexColorSchema.nullable(),
    backgroundColor: HexColorSchema.nullable(),
    motionSafe: z.boolean(),
    disclosureAcknowledged: z.boolean(),
  })
  .strict();
export type AdCreativeAccessibilityMetadata = z.infer<typeof AdCreativeAccessibilityMetadataSchema>;

/**
 * `PATCH /api/v1/admin/ads/creatives/:creativeId/accessibility` body — set / edit
 * a creative's accessibility metadata before it is reviewed. Gated on `ads:write`
 * (the author's edit). At least one field must be present. Nullable fields accept
 * `null` to CLEAR. Mirrors the campaign-update PATCH shape.
 */
export const UpdateAdCreativeAccessibilityRequestSchema = z
  .object({
    altText: AltTextSchema.nullable().optional(),
    textColor: HexColorSchema.nullable().optional(),
    backgroundColor: HexColorSchema.nullable().optional(),
    motionSafe: z.boolean().optional(),
    disclosureAcknowledged: z.boolean().optional(),
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
export type UpdateAdCreativeAccessibilityRequest = z.infer<
  typeof UpdateAdCreativeAccessibilityRequestSchema
>;

// ─── Accessibility check engine (pure) ──────────────────────────────────

/** The four accessibility checks a creative is evaluated against (PDD §18.3). */
export const AdAccessibilityCheckIdSchema = z.enum([
  'alt_text_present',
  'contrast_ratio',
  'motion_safe',
  'disclosure_acknowledged',
]);
export type AdAccessibilityCheckId = z.infer<typeof AdAccessibilityCheckIdSchema>;

/** A check is `pass`, `fail`, or `not_applicable` (kind doesn't carry the obligation). */
export const AdAccessibilityCheckStatusSchema = z.enum(['pass', 'fail', 'not_applicable']);
export type AdAccessibilityCheckStatus = z.infer<typeof AdAccessibilityCheckStatusSchema>;

/** A single check outcome with a human-readable detail (and a ratio on contrast). */
export const AdAccessibilityCheckSchema = z
  .object({
    id: AdAccessibilityCheckIdSchema,
    status: AdAccessibilityCheckStatusSchema,
    detail: z.string(),
    /** The computed WCAG contrast ratio (contrast check only); null otherwise. */
    contrastRatio: z.number().nullable(),
  })
  .strict();
export type AdAccessibilityCheck = z.infer<typeof AdAccessibilityCheckSchema>;

/** The full accessibility report for one creative. `passed` = no check failed. */
export const AdAccessibilityReportSchema = z
  .object({
    passed: z.boolean(),
    checks: z.array(AdAccessibilityCheckSchema),
  })
  .strict();
export type AdAccessibilityReport = z.infer<typeof AdAccessibilityReportSchema>;

/**
 * Parse `#rgb` / `#rrggbb` into 8-bit channel values, or `null` if malformed.
 * Exported for unit coverage of the colour-math boundary.
 */
export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const trimmed = hex.trim();
  if (!HEX_COLOR_REGEX.test(trimmed)) return null;
  const body = trimmed.slice(1);
  const full =
    body.length === 3 ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}` : body;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return { r, g, b };
}

/** WCAG 2.1 relative luminance of an 8-bit sRGB colour (0 = black, 1 = white). */
export function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channel = (eightBit: number): number => {
    const c = eightBit / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * WCAG 2.1 contrast ratio between two hex colours (1.0 … 21.0), or `null` if
 * either colour is malformed. Symmetric in its arguments (lighter / darker is
 * resolved internally).
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (fg === null || bg === null) return null;
  const lf = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  const lighter = Math.max(lf, lb);
  const darker = Math.min(lf, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Round a contrast ratio to 2dp for stable reporting / snapshots. */
function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}

/**
 * The creative facts the accessibility engine reads. A structural subset of the
 * creative record + its accessibility metadata — so callers can pass either a
 * persisted row or an in-flight creative.
 */
export interface CreativeAccessibilityInput {
  readonly kind: AdCreativeKind;
  readonly assetKeys: readonly string[];
  readonly altText: string | null;
  readonly textColor: string | null;
  readonly backgroundColor: string | null;
  readonly motionSafe: boolean;
  readonly disclosureAcknowledged: boolean;
}

/**
 * Run the four PDD §18.3 accessibility checks against a creative's declared
 * metadata. PURE — no I/O, deterministic. `passed` is true iff no check `fail`s
 * (`not_applicable` checks never block).
 *
 *   - `alt_text_present`        — image-bearing kinds must declare non-empty alt
 *                                  text; `sponsored_listing` → not_applicable.
 *   - `contrast_ratio`          — image-bearing kinds must declare text +
 *                                  background colours clearing WCAG AA (4.5:1);
 *                                  `sponsored_listing` → not_applicable.
 *   - `motion_safe`             — every kind must affirm reduced-motion safety
 *                                  (no autoplay / flashing).
 *   - `disclosure_acknowledged` — every placement must acknowledge the mandatory
 *                                  "Sponsored" disclosure (PDD §18.3; TS-278).
 */
export function evaluateCreativeAccessibility(
  creative: CreativeAccessibilityInput,
): AdAccessibilityReport {
  const imageBearing = isImageBearingCreativeKind(creative.kind);
  const checks: AdAccessibilityCheck[] = [];

  // alt_text_present
  if (!imageBearing) {
    checks.push({
      id: 'alt_text_present',
      status: 'not_applicable',
      detail: `Creative kind '${creative.kind}' renders no bespoke image — alt text is the app's responsibility.`,
      contrastRatio: null,
    });
  } else if (creative.altText === null || creative.altText.trim().length === 0) {
    checks.push({
      id: 'alt_text_present',
      status: 'fail',
      detail: 'An image-bearing creative must declare non-empty alt text for screen readers.',
      contrastRatio: null,
    });
  } else {
    checks.push({
      id: 'alt_text_present',
      status: 'pass',
      detail: 'Alt text is present.',
      contrastRatio: null,
    });
  }

  // contrast_ratio
  if (!imageBearing) {
    checks.push({
      id: 'contrast_ratio',
      status: 'not_applicable',
      detail: `Creative kind '${creative.kind}' is rendered by the app's own styled components — contrast is the app's responsibility.`,
      contrastRatio: null,
    });
  } else if (creative.textColor === null || creative.backgroundColor === null) {
    checks.push({
      id: 'contrast_ratio',
      status: 'fail',
      detail: 'Declare both text and background colours so contrast can be verified.',
      contrastRatio: null,
    });
  } else {
    const ratio = contrastRatio(creative.textColor, creative.backgroundColor);
    if (ratio === null) {
      checks.push({
        id: 'contrast_ratio',
        status: 'fail',
        detail: 'Text / background colour could not be parsed as a hex colour.',
        contrastRatio: null,
      });
    } else {
      const rounded = roundRatio(ratio);
      const ok = rounded >= AD_CREATIVE_CONTRAST_AA_NORMAL;
      checks.push({
        id: 'contrast_ratio',
        status: ok ? 'pass' : 'fail',
        detail: ok
          ? `Contrast ${rounded}:1 clears WCAG AA (${AD_CREATIVE_CONTRAST_AA_NORMAL}:1).`
          : `Contrast ${rounded}:1 is below WCAG AA (${AD_CREATIVE_CONTRAST_AA_NORMAL}:1).`,
        contrastRatio: rounded,
      });
    }
  }

  // motion_safe
  checks.push(
    creative.motionSafe
      ? {
          id: 'motion_safe',
          status: 'pass',
          detail: 'Creative affirms reduced-motion safety (no autoplay / flashing).',
          contrastRatio: null,
        }
      : {
          id: 'motion_safe',
          status: 'fail',
          detail: 'Creative must respect reduced-motion: no autoplay or flashing content.',
          contrastRatio: null,
        },
  );

  // disclosure_acknowledged
  checks.push(
    creative.disclosureAcknowledged
      ? {
          id: 'disclosure_acknowledged',
          status: 'pass',
          detail: 'The mandatory "Sponsored" disclosure is acknowledged.',
          contrastRatio: null,
        }
      : {
          id: 'disclosure_acknowledged',
          status: 'fail',
          detail: 'The mandatory "Sponsored" disclosure (PDD §18.3) must be acknowledged.',
          contrastRatio: null,
        },
  );

  return {
    passed: checks.every((check) => check.status !== 'fail'),
    checks,
  };
}

// ─── Review records ─────────────────────────────────────────────────────

/**
 * The outcome a reviewer recorded — the PERSISTED decision (past tense), distinct
 * from the imperative request `action`. Mirrors the `AdCreativeReviewDecision`
 * Prisma enum 1:1. `approved` / `rejected` / `changes_requested`.
 */
export const AdCreativeReviewDecisionSchema = z.enum(['approved', 'rejected', 'changes_requested']);
export type AdCreativeReviewDecision = z.infer<typeof AdCreativeReviewDecisionSchema>;

/**
 * An immutable, append-only review-decision record (CLAUDE.md §3.6 — review
 * actions are never updated / deleted). Snapshots the accessibility report as it
 * stood at decision time + whether the reviewer overrode a failing report.
 */
export const AdCreativeReviewRecordSchema = z
  .object({
    id: IdSchema,
    creativeId: IdSchema,
    decision: AdCreativeReviewDecisionSchema,
    reviewerUserId: ReviewerIdSchema,
    notes: NotesSchema.nullable(),
    accessibilityPassed: z.boolean(),
    overrodeAccessibility: z.boolean(),
    accessibility: AdAccessibilityReportSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export type AdCreativeReviewRecord = z.infer<typeof AdCreativeReviewRecordSchema>;

/** Minimal campaign context surfaced beside a creative in the review queue. */
export const AdCreativeReviewCampaignContextSchema = z
  .object({
    id: IdSchema,
    name: z.string(),
    advertiserKind: z.enum(['partner', 'provider', 'internal']),
  })
  .strict();
export type AdCreativeReviewCampaignContext = z.infer<typeof AdCreativeReviewCampaignContextSchema>;

/**
 * A creative awaiting (or recently subject to) review — the creative record, its
 * declared accessibility metadata, the LIVE accessibility report (recomputed on
 * read), and its campaign context.
 */
export const AdCreativeReviewItemSchema = z
  .object({
    creative: AdCreativeRecordSchema,
    accessibilityMetadata: AdCreativeAccessibilityMetadataSchema,
    accessibility: AdAccessibilityReportSchema,
    campaign: AdCreativeReviewCampaignContextSchema,
  })
  .strict();
export type AdCreativeReviewItem = z.infer<typeof AdCreativeReviewItemSchema>;

// ─── Review action ──────────────────────────────────────────────────────

/**
 * The imperative review action the reviewer takes. `approve` (→ approved),
 * `reject` (→ rejected), `request_changes` (→ draft, bounced back to the author).
 */
export const AdCreativeReviewActionSchema = z.enum(['approve', 'reject', 'request_changes']);
export type AdCreativeReviewAction = z.infer<typeof AdCreativeReviewActionSchema>;

/**
 * `POST /api/v1/admin/ads/creatives/:creativeId/review` body — gated on
 * `marketing:approve_creative`. `notes` is required for `reject` /
 * `request_changes` (the actionable reason returned to the author).
 * `acknowledgeAccessibilityFailures` lets the reviewer APPROVE a creative whose
 * accessibility report fails — but only as an explicit, audited override that
 * additionally requires `notes` (the justification). Enforced server-side, since
 * the schema cannot know the report outcome.
 */
export const ReviewAdCreativeRequestSchema = z
  .object({
    action: AdCreativeReviewActionSchema,
    notes: NotesSchema.optional(),
    acknowledgeAccessibilityFailures: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.action === 'reject' || value.action === 'request_changes') &&
      value.notes === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `notes is required to ${value.action} a creative`,
        path: ['notes'],
      });
    }
  });
export type ReviewAdCreativeRequest = z.infer<typeof ReviewAdCreativeRequestSchema>;

// ─── List query ─────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/ads/creatives/review-queue` query. Defaults to the
 * `pending_review` creatives ordered by `createdAt` ascending (oldest first —
 * a FIFO queue). `limit` is bounded.
 */
export const ListCreativeReviewQueueQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(AD_CREATIVE_REVIEW_QUEUE_LIMIT_MAX)
      .default(AD_CREATIVE_REVIEW_QUEUE_LIMIT_DEFAULT),
  })
  .strict();
export type ListCreativeReviewQueueQuery = z.infer<typeof ListCreativeReviewQueueQuerySchema>;

// ─── Response envelopes ─────────────────────────────────────────────────

/** `GET .../creatives/review-queue` response — the queued creatives. */
export const CreativeReviewQueueResponseSchema = z
  .object({ items: z.array(AdCreativeReviewItemSchema) })
  .strict();
export type CreativeReviewQueueResponse = z.infer<typeof CreativeReviewQueueResponseSchema>;

/**
 * `GET .../creatives/:creativeId/review` response — the creative under review
 * plus its decision history (most recent first).
 */
export const CreativeReviewDetailResponseSchema = z
  .object({
    item: AdCreativeReviewItemSchema,
    reviews: z.array(AdCreativeReviewRecordSchema),
  })
  .strict();
export type CreativeReviewDetailResponse = z.infer<typeof CreativeReviewDetailResponseSchema>;

/**
 * `PATCH .../creatives/:creativeId/accessibility` + `POST .../review` response —
 * the creative after the mutation, its (recomputed) accessibility report, and the
 * review record that was just appended (null for the accessibility PATCH).
 */
export const CreativeReviewMutationResponseSchema = z
  .object({
    item: AdCreativeReviewItemSchema,
    review: AdCreativeReviewRecordSchema.nullable(),
  })
  .strict();
export type CreativeReviewMutationResponse = z.infer<typeof CreativeReviewMutationResponseSchema>;

/**
 * Resolve a review `action` to the creative status it lands the creative in.
 * Single-sourced so the service + the web-admin surface agree.
 */
export function creativeStatusForReviewAction(
  action: AdCreativeReviewAction,
): 'approved' | 'rejected' | 'draft' {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'request_changes':
      return 'draft';
  }
}

/** Resolve a review `action` to the persisted decision enum value. */
export function reviewDecisionForAction(action: AdCreativeReviewAction): AdCreativeReviewDecision {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'request_changes':
      return 'changes_requested';
  }
}
