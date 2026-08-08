/**
 * Taste & See design tokens — earthy-textile system.
 *
 * Source of truth for palette, typography, spacing, motion, and the four
 * curated palette swaps (Clay & Linen, Indigo Madder, Saffron Loom, Slate
 * Hemp). The default ships Clay & Linen; the alternates are exported for
 * future theming work but are not surfaced as a user-facing picker (the
 * design's "tweaks panel" was prototype machinery).
 *
 * Names are kebab-case so the TS keys match the CSS custom-property names
 * one-to-one — `palette['linen-2']` ↔ `var(--linen-2)`. Components reach
 * for the CSS variables directly; the TS values are for when JS needs the
 * literal hex (canvas drawing, inline-style fallback, theme switching).
 */

export const palette = {
  paper: '#F6F1E7',
  linen: '#E8DCC4',
  'linen-2': '#D9CBAE',
  clay: '#C4856B',
  'clay-deep': '#A86A52',
  sage: '#7A8471',
  'sage-deep': '#5E6A57',
  espresso: '#3D2E1F',
  ink: '#2A2118',
  'ink-soft': '#4F4032',
  rule: '#C9B999',
} as const;

export type PaletteKey = keyof typeof palette;

/**
 * Curated palette swaps from the design. `clay` is the default; the others
 * stay here so a future debug-mode picker or A/B test can flip the `:root`
 * CSS variables without re-deriving values.
 */
export const palettes = {
  clay: { label: 'Clay & Linen', ...palette },
  indigo: {
    label: 'Indigo Madder',
    paper: '#F2EEE5',
    linen: '#DDD3BD',
    'linen-2': '#C8BCA3',
    clay: '#8C3B3B',
    'clay-deep': '#6F2C2C',
    sage: '#3E5970',
    'sage-deep': '#2C415A',
    espresso: '#2A2740',
    ink: '#1F1D33',
    'ink-soft': '#473F4F',
    rule: '#B8A98E',
  },
  saffron: {
    label: 'Saffron Loom',
    paper: '#F8F2E2',
    linen: '#EFE0B5',
    'linen-2': '#DCC98E',
    clay: '#D89A3F',
    'clay-deep': '#B27C26',
    sage: '#6E7A3B',
    'sage-deep': '#525C28',
    espresso: '#3A2A12',
    ink: '#2A1E0C',
    'ink-soft': '#544023',
    rule: '#CFB783',
  },
  slate: {
    label: 'Slate Hemp',
    paper: '#EEEBE2',
    linen: '#D6D2C4',
    'linen-2': '#BFBAA9',
    clay: '#8E5C4A',
    'clay-deep': '#6F4538',
    sage: '#5C6A5F',
    'sage-deep': '#445047',
    espresso: '#26282A',
    ink: '#1A1B1D',
    'ink-soft': '#3F4244',
    rule: '#A8A293',
  },
} as const;

export type PaletteVariant = keyof typeof palettes;

export const fontFamilies = {
  serif: "'Cormorant Garamond', 'Cormorant', Georgia, serif",
  sans: "'DM Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, Menlo, monospace",
} as const;

export const spacingRem = {
  0: 0,
  1: 0.25,
  2: 0.5,
  3: 0.75,
  4: 1,
  5: 1.25,
  6: 1.5,
  8: 2,
  10: 2.5,
  12: 3,
  16: 4,
  20: 5,
  24: 6,
} as const;

export const radiiRem = {
  none: 0,
  sm: 0.125,
  base: 0.25,
  md: 0.375,
  lg: 0.5,
  xl: 0.75,
  '2xl': 1,
  '3xl': 1.5,
  full: 999,
} as const;

export const shadows = {
  sm: '0 1px 2px 0 rgba(61, 46, 31, 0.05)',
  base: '0 1px 3px 0 rgba(61, 46, 31, 0.10), 0 1px 2px -1px rgba(61, 46, 31, 0.06)',
  md: '0 4px 6px -1px rgba(61, 46, 31, 0.10), 0 2px 4px -2px rgba(61, 46, 31, 0.06)',
  lg: '0 10px 15px -3px rgba(61, 46, 31, 0.10), 0 4px 6px -4px rgba(61, 46, 31, 0.06)',
  xl: '0 20px 25px -5px rgba(61, 46, 31, 0.12), 0 8px 10px -6px rgba(61, 46, 31, 0.06)',
  card: '0 30px 60px -30px rgba(61, 46, 31, 0.25)',
  'card-lift': '0 20px 40px -24px rgba(61, 46, 31, 0.30)',
} as const;

export const motion = {
  durationMs: {
    instant: 0,
    fast: 180,
    base: 240,
    slow: 360,
    rise: 900,
  },
  easing: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    rise: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
  },
} as const;

export const breakpointsPx = {
  sm: 640,
  md: 768,
  lg: 900,
  xl: 1280,
  '2xl': 1536,
} as const;

/** Container max-width — design uses 1320px. */
export const containerMaxPx = 1320;

export const interactive = {
  tapTargetMinRem: 2.75,
  focusRingWidthRem: 0.1875,
  focusRingOffsetRem: 0.125,
} as const;
