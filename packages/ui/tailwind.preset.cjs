/**
 * Taste & See — Tailwind preset (consumed by every Tailwind-using app).
 *
 * Maps the canonical CSS custom properties from
 * `@taste-and-see/design-tokens/styles/tokens.css` onto Tailwind's theme.
 * Apps wire this via:
 *
 *   // tailwind.config.cjs
 *   module.exports = {
 *     presets: [require('@taste-and-see/ui/tailwind-preset')],
 *     content: ['./src/**\/*.{ts,tsx}', '../../packages/ui/src/**\/*.{ts,tsx}'],
 *   };
 *
 * Why CSS-variable references rather than hex literals:
 *   - Senior-mode flips the variables on `[data-senior-mode='on']` — Tailwind
 *     classes pick up the new values without a re-render or alternate theme.
 *   - The design's three alternate palettes (Indigo / Saffron / Slate) flip
 *     via JS-side variable assignment (see palettes export); same Tailwind
 *     classes resolve to the new swatches.
 *
 * Alpha modifiers (e.g. `bg-clay/40`) won't work against `var()` colors here
 * because Tailwind's `<alpha-value>` pipeline expects a space-separated rgb
 * triple. The design uses rgba literals where transparency is needed, so
 * this is a deliberate non-feature of the preset; revisit if alpha-on-token
 * becomes a recurring need.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    screens: {
      sm: '640px',
      md: '768px',
      lg: '900px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        paper: 'var(--paper)',
        linen: 'var(--linen)',
        'linen-2': 'var(--linen-2)',
        clay: 'var(--clay)',
        'clay-deep': 'var(--clay-deep)',
        sage: 'var(--sage)',
        'sage-deep': 'var(--sage-deep)',
        espresso: 'var(--espresso)',
        ink: 'var(--ink)',
        'ink-soft': 'var(--ink-soft)',
        rule: 'var(--rule)',
      },
      fontFamily: {
        serif: 'var(--serif)',
        sans: 'var(--sans)',
        mono: 'var(--mono)',
      },
      spacing: {
        0: 'var(--space-0)',
        1: 'var(--space-1)',
        2: 'var(--space-2)',
        3: 'var(--space-3)',
        4: 'var(--space-4)',
        5: 'var(--space-5)',
        6: 'var(--space-6)',
        8: 'var(--space-8)',
        10: 'var(--space-10)',
        12: 'var(--space-12)',
        16: 'var(--space-16)',
        20: 'var(--space-20)',
        24: 'var(--space-24)',
        'tap-min': 'var(--tap-target-min)',
      },
      borderRadius: {
        none: 'var(--radius-none)',
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-base)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        '3xl': 'var(--radius-3xl)',
        full: 'var(--radius-full)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-base)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        card: 'var(--shadow-card)',
        'card-lift': 'var(--shadow-card-lift)',
      },
      transitionDuration: {
        instant: '0ms',
        fast: 'var(--duration-fast)',
        DEFAULT: 'var(--duration-base)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
        rise: 'var(--duration-rise)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        rise: 'var(--ease-rise)',
      },
      maxWidth: {
        container: 'var(--container-max)',
      },
      minHeight: {
        'tap-min': 'var(--tap-target-min)',
      },
      minWidth: {
        'tap-min': 'var(--tap-target-min)',
      },
      ringWidth: {
        focus: 'var(--focus-ring-width)',
      },
      ringOffsetWidth: {
        focus: 'var(--focus-ring-offset)',
      },
    },
  },
  corePlugins: {
    preflight: true,
  },
};
