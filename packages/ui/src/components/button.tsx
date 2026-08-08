import { Slot } from '@radix-ui/react-slot';
import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * Button — Taste & See primary action surface.
 *
 * Variants follow the design's visual language: `primary` is the clay CTA,
 * `ghost` is paper-on-paper for secondary navigation, `outline` is the
 * espresso outline used on the hero, `link` strips chrome for inline use.
 *
 * Tap target: every variant binds `min-height: var(--tap-target-min)` (and
 * width on icon-only) so engaging senior-mode (which flips the variable to
 * 3rem / 48px) auto-promotes hit area without per-call overrides — CLAUDE
 * §8.3.
 *
 * `asChild` (Radix Slot) lets callers render the button as a Next.js Link
 * or any other element while preserving the styling and accessibility wiring.
 */

const variantClasses = {
  primary:
    'bg-clay text-paper hover:bg-clay-deep focus-visible:ring-paper border border-transparent',
  ghost: 'bg-transparent text-ink hover:bg-linen focus-visible:ring-clay border border-transparent',
  outline: 'bg-transparent text-ink hover:bg-paper focus-visible:ring-clay border border-ink',
  link: 'bg-transparent text-clay-deep hover:text-clay underline-offset-4 hover:underline border border-transparent focus-visible:ring-clay px-0 py-0 min-h-0',
} as const;

const sizeClasses = {
  sm: 'px-3 py-2 text-sm min-h-tap-min',
  md: 'px-5 py-3 text-base min-h-tap-min',
  lg: 'px-8 py-4 text-lg min-h-tap-min',
  icon: 'p-2 min-h-tap-min min-w-tap-min',
} as const;

export type ButtonVariant = keyof typeof variantClasses;
export type ButtonSize = keyof typeof sizeClasses;

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly asChild?: boolean;
  readonly children?: React.ReactNode;
}

const baseClasses =
  'inline-flex items-center justify-center gap-2 font-sans font-medium rounded ' +
  'transition-colors duration-fast ease-standard ' +
  'focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-offset-focus focus-visible:ring-offset-paper ' +
  'disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed';

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', asChild = false, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  const computed = cn(baseClasses, variantClasses[variant], sizeClasses[size], className);
  return (
    <Comp
      ref={ref}
      className={computed}
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  );
});
