import { describe, expect, it } from 'vitest';

import { motionDurationMs, palette, seniorModeOverrides, seniorModePalette } from '../index';

/**
 * WCAG-style relative-luminance contrast ratio (W3C TR/WCAG21). Used as a
 * test guard so accidental edits to the senior-mode tokens cannot drop us
 * below the AAA threshold without a visible failure.
 */
function contrastRatio(fg: string, bg: string): number {
  return (
    (Math.max(luminance(fg), luminance(bg)) + 0.05) /
    (Math.min(luminance(fg), luminance(bg)) + 0.05)
  );
}
function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(channel);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
function parseHex(hex: string): readonly number[] {
  const cleaned = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(cleaned.slice(i, i + 2), 16) / 255);
}
function channel(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

describe('default Clay & Linen palette — body-text contrast', () => {
  it('ink on paper meets AAA-normal (≥ 7:1)', () => {
    expect(contrastRatio(palette.ink, palette.paper)).toBeGreaterThanOrEqual(7);
  });

  it('espresso on paper meets AAA-normal (≥ 7:1)', () => {
    expect(contrastRatio(palette.espresso, palette.paper)).toBeGreaterThanOrEqual(7);
  });

  it('paper on espresso (footer / dashboard inverse) meets AAA-normal (≥ 7:1)', () => {
    expect(contrastRatio(palette.paper, palette.espresso)).toBeGreaterThanOrEqual(7);
  });
});

describe('senior-mode AAA contrast (CLAUDE §8.3)', () => {
  it('ink on paper widens past 18:1 (well past AAA)', () => {
    const ratio = contrastRatio(seniorModePalette.ink, seniorModePalette.paper);
    expect(ratio).toBeGreaterThanOrEqual(18);
  });

  it('ink-soft on paper still clears AAA-normal (≥ 7:1)', () => {
    const ratio = contrastRatio(seniorModePalette['ink-soft'], seniorModePalette.paper);
    expect(ratio).toBeGreaterThanOrEqual(7);
  });

  /**
   * Button / CTA surfaces fall under WCAG 1.4.11 (UI components, ≥ 3:1) and
   * 1.4.3 (button text as normal text, ≥ 4.5:1 AA). AAA on action surfaces
   * would force a near-black brand which kills the warm hospitality
   * palette — we keep AAA for *body text* and AA on action surfaces.
   */
  it('paper on clay-deep meets AA-normal (≥ 4.5:1) — buttons / CTAs', () => {
    const ratio = contrastRatio(seniorModePalette.paper, seniorModePalette['clay-deep']);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

describe('senior-mode overrides', () => {
  it('text scale is exactly 1.5× (CLAUDE §8.3)', () => {
    expect(seniorModeOverrides.textScale).toBe(1.5);
  });

  it('tap-target minimum reaches 3rem / 48px', () => {
    expect(seniorModeOverrides.tapTargetMinRem * 16).toBeGreaterThanOrEqual(48);
  });

  it('motion multiplier collapses to 0', () => {
    expect(seniorModeOverrides.motionDurationMultiplier).toBe(0);
  });

  it('focus ring widens', () => {
    expect(seniorModeOverrides.focusRingWidthRem).toBeGreaterThan(0.1875);
  });
});

describe('motionDurationMs', () => {
  it('returns base duration outside senior mode', () => {
    expect(motionDurationMs('fast')).toBe(180);
    expect(motionDurationMs('rise')).toBe(900);
  });

  it('collapses to 0 when seniorMode is true', () => {
    expect(motionDurationMs('fast', { seniorMode: true })).toBe(0);
    expect(motionDurationMs('rise', { seniorMode: true })).toBe(0);
  });
});
