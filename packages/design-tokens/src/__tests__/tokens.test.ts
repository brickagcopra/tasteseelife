import { describe, expect, it } from 'vitest';

import { containerMaxPx, fontFamilies, interactive, palette, palettes, spacingRem } from '../index';

describe('palette (Clay & Linen — design default)', () => {
  it('exposes every named swatch from the design', () => {
    const required = [
      'paper',
      'linen',
      'linen-2',
      'clay',
      'clay-deep',
      'sage',
      'sage-deep',
      'espresso',
      'ink',
      'ink-soft',
      'rule',
    ] as const;
    for (const k of required) {
      expect(palette[k]).toBeDefined();
    }
  });

  it('palette values are uppercase 6-digit hex strings', () => {
    for (const value of Object.values(palette)) {
      expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("default palette uses the design's exact paper / clay / espresso swatches", () => {
    expect(palette.paper).toBe('#F6F1E7');
    expect(palette.clay).toBe('#C4856B');
    expect(palette.espresso).toBe('#3D2E1F');
  });
});

describe('alternate palettes', () => {
  it('exposes the four design-curated swaps with display labels', () => {
    expect(palettes.clay.label).toBe('Clay & Linen');
    expect(palettes.indigo.label).toBe('Indigo Madder');
    expect(palettes.saffron.label).toBe('Saffron Loom');
    expect(palettes.slate.label).toBe('Slate Hemp');
  });

  it('every alternate palette has the full swatch set', () => {
    const swatches = [
      'paper',
      'linen',
      'linen-2',
      'clay',
      'clay-deep',
      'sage',
      'sage-deep',
      'espresso',
      'ink',
      'ink-soft',
      'rule',
    ] as const;
    for (const variant of ['clay', 'indigo', 'saffron', 'slate'] as const) {
      const p = palettes[variant];
      for (const s of swatches) {
        expect(p[s], `${variant} missing ${s}`).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });
});

describe('typography', () => {
  it('declares Cormorant Garamond / DM Sans / JetBrains Mono per the design', () => {
    expect(fontFamilies.serif).toMatch(/Cormorant Garamond/);
    expect(fontFamilies.sans).toMatch(/DM Sans/);
    expect(fontFamilies.mono).toMatch(/JetBrains Mono/);
  });
});

describe('spacing', () => {
  it('zero spacing is `0`, every other step is positive rem', () => {
    expect(spacingRem[0]).toBe(0);
    expect(spacingRem[4]).toBe(1);
    for (const [k, v] of Object.entries(spacingRem)) {
      if (k === '0') continue;
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('layout', () => {
  it('container max-width matches the design (1320px)', () => {
    expect(containerMaxPx).toBe(1320);
  });
});

describe('interactive defaults', () => {
  it('default tap target meets WCAG 2.5.5 (≥ 1.5rem / 24px)', () => {
    expect(interactive.tapTargetMinRem).toBeGreaterThanOrEqual(1.5);
  });
  it('focus-ring width and offset are non-zero', () => {
    expect(interactive.focusRingWidthRem).toBeGreaterThan(0);
    expect(interactive.focusRingOffsetRem).toBeGreaterThan(0);
  });
});
