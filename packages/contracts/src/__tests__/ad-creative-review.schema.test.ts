import { describe, expect, it } from 'vitest';

import {
  AD_CREATIVE_CONTRAST_AA_NORMAL,
  contrastRatio,
  creativeStatusForReviewAction,
  evaluateCreativeAccessibility,
  HexColorSchema,
  isImageBearingCreativeKind,
  ListCreativeReviewQueueQuerySchema,
  parseHexColor,
  relativeLuminance,
  ReviewAdCreativeRequestSchema,
  reviewDecisionForAction,
  UpdateAdCreativeAccessibilityRequestSchema,
  type AdCreativeReviewAction,
  type CreativeAccessibilityInput,
} from '../http/ad-creative-review.schema';

function baseCreative(
  overrides: Partial<CreativeAccessibilityInput> = {},
): CreativeAccessibilityInput {
  return {
    kind: 'banner',
    assetKeys: ['ads/creatives/c1.webp'],
    altText: 'A warm chef-prepared meal served at a kitchen table',
    textColor: '#000000',
    backgroundColor: '#ffffff',
    motionSafe: true,
    disclosureAcknowledged: true,
    ...overrides,
  };
}

function checkFor(report: ReturnType<typeof evaluateCreativeAccessibility>, id: string) {
  const check = report.checks.find((c) => c.id === id);
  if (check === undefined) throw new Error(`missing check ${id}`);
  return check;
}

describe('parseHexColor', () => {
  it('parses a 6-digit hex colour', () => {
    expect(parseHexColor('#1a2b3c')).toEqual({ r: 0x1a, g: 0x2b, b: 0x3c });
  });

  it('expands a 3-digit hex colour', () => {
    expect(parseHexColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  it('is case-insensitive and trims', () => {
    expect(parseHexColor('  #FFFFFF ')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('returns null for a malformed colour', () => {
    expect(parseHexColor('1a2b3c')).toBeNull();
    expect(parseHexColor('#12')).toBeNull();
    expect(parseHexColor('#xyzxyz')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10);
  });
});

describe('contrastRatio', () => {
  it('is exactly 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
  });

  it('is 1 for identical colours', () => {
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 10);
  });

  it('is symmetric in its arguments', () => {
    const a = contrastRatio('#123456', '#abcdef');
    const b = contrastRatio('#abcdef', '#123456');
    expect(a).not.toBeNull();
    expect(a).toBeCloseTo(b as number, 10);
  });

  it('clears AA at the classic #767676-on-white boundary', () => {
    const ratio = contrastRatio('#767676', '#ffffff');
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThanOrEqual(AD_CREATIVE_CONTRAST_AA_NORMAL);
  });

  it('returns null when either colour is malformed', () => {
    expect(contrastRatio('not-a-colour', '#ffffff')).toBeNull();
    expect(contrastRatio('#ffffff', 'nope')).toBeNull();
  });
});

describe('isImageBearingCreativeKind', () => {
  it('is true for banner / sponsored_content / partner_card', () => {
    expect(isImageBearingCreativeKind('banner')).toBe(true);
    expect(isImageBearingCreativeKind('sponsored_content')).toBe(true);
    expect(isImageBearingCreativeKind('partner_card')).toBe(true);
  });

  it('is false for the data-driven sponsored_listing', () => {
    expect(isImageBearingCreativeKind('sponsored_listing')).toBe(false);
  });
});

describe('evaluateCreativeAccessibility', () => {
  it('passes a fully-specified image-bearing creative', () => {
    const report = evaluateCreativeAccessibility(baseCreative());
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(4);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(checkFor(report, 'contrast_ratio').contrastRatio).toBeCloseTo(21, 1);
  });

  it('fails when an image-bearing creative has no alt text', () => {
    const report = evaluateCreativeAccessibility(baseCreative({ altText: null }));
    expect(report.passed).toBe(false);
    expect(checkFor(report, 'alt_text_present').status).toBe('fail');
  });

  it('treats whitespace-only alt text as missing', () => {
    const report = evaluateCreativeAccessibility(baseCreative({ altText: '   ' }));
    expect(checkFor(report, 'alt_text_present').status).toBe('fail');
  });

  it('fails contrast when colours are not declared', () => {
    const report = evaluateCreativeAccessibility(
      baseCreative({ textColor: null, backgroundColor: null }),
    );
    expect(report.passed).toBe(false);
    expect(checkFor(report, 'contrast_ratio').status).toBe('fail');
    expect(checkFor(report, 'contrast_ratio').contrastRatio).toBeNull();
  });

  it('fails contrast when the declared ratio is below AA', () => {
    const report = evaluateCreativeAccessibility(
      baseCreative({ textColor: '#ffffff', backgroundColor: '#ffffff' }),
    );
    expect(checkFor(report, 'contrast_ratio').status).toBe('fail');
    expect(checkFor(report, 'contrast_ratio').contrastRatio).toBeCloseTo(1, 1);
  });

  it('marks alt-text + contrast not_applicable for sponsored_listing', () => {
    const report = evaluateCreativeAccessibility(
      baseCreative({
        kind: 'sponsored_listing',
        altText: null,
        textColor: null,
        backgroundColor: null,
      }),
    );
    expect(checkFor(report, 'alt_text_present').status).toBe('not_applicable');
    expect(checkFor(report, 'contrast_ratio').status).toBe('not_applicable');
    // motion + disclosure still apply, and pass here, so the report passes.
    expect(report.passed).toBe(true);
  });

  it('fails motion_safe when motion is not affirmed', () => {
    const report = evaluateCreativeAccessibility(baseCreative({ motionSafe: false }));
    expect(report.passed).toBe(false);
    expect(checkFor(report, 'motion_safe').status).toBe('fail');
  });

  it('fails disclosure_acknowledged when the disclosure is not acknowledged', () => {
    const report = evaluateCreativeAccessibility(baseCreative({ disclosureAcknowledged: false }));
    expect(report.passed).toBe(false);
    expect(checkFor(report, 'disclosure_acknowledged').status).toBe('fail');
  });
});

describe('creativeStatusForReviewAction / reviewDecisionForAction', () => {
  it('maps actions to the resulting creative status', () => {
    expect(creativeStatusForReviewAction('approve')).toBe('approved');
    expect(creativeStatusForReviewAction('reject')).toBe('rejected');
    expect(creativeStatusForReviewAction('request_changes')).toBe('draft');
  });

  it('maps actions to the persisted decision', () => {
    expect(reviewDecisionForAction('approve')).toBe('approved');
    expect(reviewDecisionForAction('reject')).toBe('rejected');
    expect(reviewDecisionForAction('request_changes')).toBe('changes_requested');
  });

  it('covers every action in both mappers', () => {
    const actions: readonly AdCreativeReviewAction[] = ['approve', 'reject', 'request_changes'];
    for (const action of actions) {
      expect(creativeStatusForReviewAction(action)).toBeTruthy();
      expect(reviewDecisionForAction(action)).toBeTruthy();
    }
  });
});

describe('HexColorSchema', () => {
  it('accepts 3- and 6-digit hex', () => {
    expect(HexColorSchema.safeParse('#abc').success).toBe(true);
    expect(HexColorSchema.safeParse('#1A2B3C').success).toBe(true);
  });

  it('rejects malformed colours', () => {
    expect(HexColorSchema.safeParse('123456').success).toBe(false);
    expect(HexColorSchema.safeParse('#12').success).toBe(false);
  });
});

describe('ReviewAdCreativeRequestSchema', () => {
  it('accepts approve with no notes and defaults the override flag to false', () => {
    const parsed = ReviewAdCreativeRequestSchema.parse({ action: 'approve' });
    expect(parsed.acknowledgeAccessibilityFailures).toBe(false);
    expect(parsed.notes).toBeUndefined();
  });

  it('requires notes to reject', () => {
    expect(ReviewAdCreativeRequestSchema.safeParse({ action: 'reject' }).success).toBe(false);
    expect(
      ReviewAdCreativeRequestSchema.safeParse({ action: 'reject', notes: 'low contrast' }).success,
    ).toBe(true);
  });

  it('requires notes to request changes', () => {
    expect(ReviewAdCreativeRequestSchema.safeParse({ action: 'request_changes' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields', () => {
    expect(
      ReviewAdCreativeRequestSchema.safeParse({ action: 'approve', extra: true }).success,
    ).toBe(false);
  });
});

describe('UpdateAdCreativeAccessibilityRequestSchema', () => {
  it('rejects an empty patch', () => {
    expect(UpdateAdCreativeAccessibilityRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a single field and allows null to clear', () => {
    expect(UpdateAdCreativeAccessibilityRequestSchema.safeParse({ altText: null }).success).toBe(
      true,
    );
    expect(
      UpdateAdCreativeAccessibilityRequestSchema.safeParse({ motionSafe: false }).success,
    ).toBe(true);
  });

  it('rejects a malformed hex colour', () => {
    expect(UpdateAdCreativeAccessibilityRequestSchema.safeParse({ textColor: 'red' }).success).toBe(
      false,
    );
  });
});

describe('ListCreativeReviewQueueQuerySchema', () => {
  it('defaults the limit and coerces a string', () => {
    expect(ListCreativeReviewQueueQuerySchema.parse({}).limit).toBe(50);
    expect(ListCreativeReviewQueueQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('rejects a limit over the max', () => {
    expect(ListCreativeReviewQueueQuerySchema.safeParse({ limit: 9999 }).success).toBe(false);
  });
});
