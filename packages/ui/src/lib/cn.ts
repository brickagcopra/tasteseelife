import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The Taste & See Tailwind preset adds palette tokens (paper / linen / clay /
 * sage / espresso / ink / rule) and width tokens (`ring-focus`,
 * `ring-offset-focus`) that aren't part of stock Tailwind. tailwind-merge
 * needs to know which group each lives in so a width-vs-color override on
 * the same prefix doesn't drop one or the other.
 *
 * Without this extension, e.g. `cn('focus-visible:ring-focus',
 * 'focus-visible:ring-paper')` collapses to a single class — both fall into
 * the same default `ring-w` group and last-wins kills the width.
 */
const PALETTE_TOKENS = [
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

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'ring-w': [{ ring: ['focus'] }],
      'ring-color': [{ ring: [...PALETTE_TOKENS] }],
      'ring-offset-w': [{ 'ring-offset': ['focus'] }],
      'ring-offset-color': [{ 'ring-offset': [...PALETTE_TOKENS] }],
    },
  },
});

export function cn(...inputs: readonly ClassValue[]): string {
  return customTwMerge(clsx(inputs));
}
