import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * Input — single-line form control.
 *
 * Honors `--tap-target-min` for height (senior-mode promotes to 48px) and
 * `--focus-ring-*` so the focus indicator widens in senior-mode (CLAUDE
 * §8.3). The field stays paper-on-paper outside of focus, picks up a clay
 * ring on focus, and dims to disabled state via opacity rather than a
 * separate color so the disabled control still reads as a field.
 */

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  readonly invalid?: boolean;
}

const baseClasses =
  'flex w-full min-h-tap-min rounded border bg-paper px-4 py-2 text-base text-ink ' +
  'font-sans placeholder:text-ink-soft/70 ' +
  'transition-colors duration-fast ease-standard ' +
  'focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-offset-focus focus-visible:ring-offset-paper ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid = false, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        baseClasses,
        invalid
          ? 'border-clay-deep focus-visible:ring-clay-deep'
          : 'border-rule focus-visible:ring-clay',
        className,
      )}
      {...props}
    />
  );
});
