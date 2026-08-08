import * as React from 'react';

import { cn } from '../lib/cn';

/**
 * Card — composition primitive (Card / Header / Title / Description / Content / Footer).
 *
 * Visual baseline mirrors the design's `.card` utility from the marketing
 * page: linen-2 border, subtle shadow, paper background. Sub-components
 * compose vertically with consistent padding so callers don't reach for
 * margin overrides.
 */

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('rounded-lg border border-rule bg-paper text-ink shadow-sm', className)}
        {...props}
      />
    );
  },
);

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return <div ref={ref} className={cn('flex flex-col gap-2 p-6 pb-4', className)} {...props} />;
  },
);

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...props }, ref) {
  // jsx-a11y/heading-has-content can't see children that come through
  // {...props}; the lint check is a false positive for forwarded primitives
  // — callers always supply text via children.
  return (
    // eslint-disable-next-line jsx-a11y/heading-has-content
    <h3
      ref={ref}
      className={cn('font-serif text-2xl leading-tight tracking-tight text-ink', className)}
      {...props}
    />
  );
});

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardDescription({ className, ...props }, ref) {
  return (
    <p
      ref={ref}
      className={cn('font-sans text-sm leading-relaxed text-ink-soft', className)}
      {...props}
    />
  );
});

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn('p-6 pt-0 font-sans', className)} {...props} />;
  },
);

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div ref={ref} className={cn('flex items-center gap-3 p-6 pt-0', className)} {...props} />
    );
  },
);
