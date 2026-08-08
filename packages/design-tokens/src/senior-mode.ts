/**
 * Senior-mode overrides on top of the earthy-textile palette
 * (PDD §6.3, CLAUDE.md §8.3).
 *
 * Engaging `[data-senior-mode='on']` on the root element flips:
 *   - **Body-text contrast to AAA** — pure-near-black ink on
 *     pure-near-white paper. The default Clay & Linen mode runs ~14:1
 *     (paper #F6F1E7 vs ink #2A2118) so senior-mode pushes that to ~19:1.
 *   - **Brand-bg (clay) darkens** so white text on the CTA still clears
 *     AA-normal (≥ 4.5:1). AAA on action surfaces would force a near-black
 *     button which kills the warm hospitality identity (CLAUDE §12).
 *   - **Text scale × 1.5** via `--ts-text-scale`. Single hinge.
 *   - **Tap target ≥ 48px / 3rem** (CLAUDE §8.3).
 *   - **Motion → 0** via `--ts-motion-multiplier`. Independent of OS
 *     `prefers-reduced-motion` — senior-mode is an intentional opt-in.
 */
export const seniorModePalette = {
  paper: '#FFFEFA',
  linen: '#EFE6CE',
  'linen-2': '#D9CBAE',
  clay: '#A86A52',
  'clay-deep': '#8E4922',
  sage: '#5E6A57',
  'sage-deep': '#3F522B',
  espresso: '#1A140B',
  ink: '#0A0700',
  'ink-soft': '#2A2118',
  rule: '#8C7E66',
} as const;

export const seniorModeOverrides = {
  textScale: 1.5,
  tapTargetMinRem: 3,
  motionDurationMultiplier: 0,
  focusRingWidthRem: 0.25,
} as const;
