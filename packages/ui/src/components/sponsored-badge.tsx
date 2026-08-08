import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * The canonical advertising-disclosure label text (PDD §18.3 — "Mandatory
 * disclosure ('Sponsored') on relevant placements").
 *
 * Single-sourced here so EVERY consumer — sponsored search results, the home
 * banner, the dashboard sidebar, the blog footer, partner co-marketing cards —
 * renders the identical mandated wording. Centralising the string is the whole
 * point of TS-278: it can never drift to "Ad" / "Promoted" / "Featured", which
 * would be a compliance defect. Non-Tailwind surfaces (e.g. web-family, styled
 * with hand-written CSS + design-token CSS variables) import this constant for
 * the text while keeping their own pill CSS; Tailwind surfaces use the
 * `SponsoredBadge` component below.
 */
export const SPONSORED_LABEL = 'Sponsored' as const;

export type SponsoredBadgeProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>;

/**
 * SponsoredBadge — the mandatory paid-placement disclosure pill (PDD §18.3).
 *
 * Deliberately quiet: an outlined, muted `ink-soft` pill rather than a filled
 * accent, so it reads as a disclosure rather than a promotion and stays visually
 * distinct from the organic "Featured" boost (a row may legitimately carry
 * both). Outlined `ink-soft`-on-`paper` clears WCAG AA contrast; the disclosure
 * text is real DOM text (not a CSS pseudo-element or an `::before`) so screen
 * readers always announce it, and `uppercase` is a visual transform only — the
 * accessible name stays "Sponsored". Tokens come from
 * `@taste-and-see/design-tokens` via the Tailwind preset (CLAUDE §8.2): no
 * hard-coded colours. Senior-mode inherits the global contrast/scale hinges.
 *
 * Callers may pass `className` (merged last-wins via tailwind-merge) and any
 * span attribute (`aria-*`, `data-*`, `title`, ...). The label itself is fixed
 * — `children` is intentionally omitted so a placement can never substitute a
 * different (non-compliant) word.
 */
export const SponsoredBadge = React.forwardRef<HTMLSpanElement, SponsoredBadgeProps>(
  function SponsoredBadge({ className, ...props }, ref) {
    return (
      <span
        ref={ref}
        className={cn(
          'inline-block rounded-full border border-ink-soft bg-transparent px-2.5 py-0.5 ' +
            'font-sans text-xs font-semibold uppercase tracking-wide text-ink-soft',
          className,
        )}
        {...props}
      >
        {SPONSORED_LABEL}
      </span>
    );
  },
);
