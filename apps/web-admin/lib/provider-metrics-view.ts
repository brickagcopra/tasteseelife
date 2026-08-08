import type { ProviderMetricsWindow } from '@taste-and-see/contracts';

/**
 * Presentation helpers for the provider performance panel (TS-305d).
 *
 * They live in `lib/` rather than inline in the page because web-admin's
 * test lane is `.ts`-only by design (TS-303c2b-followup-1): a helper in
 * a `.tsx` server component is a helper nothing can test. Everything
 * here decides what a committee reads off a page that can end someone's
 * work on the platform, so it is exactly the code that should be
 * covered.
 */

/**
 * A rate arrives as integer tenths of a percent and is rendered with
 * one decimal place — the same precision it was computed at, so the
 * page never claims more accuracy than the contract carries and never
 * rounds two equal rates to different strings.
 */
export function formatMetricRate(tenths: number): string {
  return `${(tenths / 10).toFixed(1)}%`;
}

/**
 * A response time in words rather than seconds.
 *
 * The unit steps up as the number grows because the useful comparison
 * changes with it: minutes matter when a provider answers within the
 * hour, and once the answer is "about two days" the minutes are noise
 * that makes two providers look different when they are not.
 *
 * Rounds to the nearest unit and says "about", never a false precision
 * like "1.83 hours". Under a minute is reported in seconds, because at
 * that end the difference between 5 and 50 is real.
 */
export function formatResponseTime(seconds: number | null): string {
  if (seconds === null) return 'Not enough answered requests to say';
  if (seconds < 60) return `about ${seconds} second${seconds === 1 ? '' : 's'}`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.round(seconds / 3600);
  if (hours < 36) return `about ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(seconds / 86_400);
  return `about ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The one sentence that heads each window.
 *
 * The `insufficient_data` and `no_activity` wordings are the load-
 * bearing ones and they are deliberately different sentences. "We have
 * not seen a booking" and "we have seen a few, and a percentage off
 * that many would mislead you" are different facts about a provider,
 * and a reviewer who cannot tell them apart will read a brand-new
 * provider as a dormant one. Neither says "0%", and neither implies a
 * problem — the copy states what we hold, not a verdict.
 */
export function metricsWindowHeadline(window: ProviderMetricsWindow, windowDays: number): string {
  const scope = windowDays > 0 ? `the last ${windowDays} days` : 'this provider’s whole record';

  switch (window.state) {
    case 'no_activity':
      return `No bookings on record for ${scope}. This is not a low score — there is nothing to score.`;
    case 'insufficient_data':
      return (
        `${window.counts.decidedBookings} booking${window.counts.decidedBookings === 1 ? '' : 's'} ` +
        `finished in ${scope} — fewer than the ${window.minimumDecidedBookings} needed before a ` +
        `percentage says anything. The counts are below; rates are deliberately not shown.`
      );
    case 'measured':
      return (
        `Based on ${window.counts.decidedBookings} finished booking` +
        `${window.counts.decidedBookings === 1 ? '' : 's'} in ${scope}.`
      );
  }
}

/**
 * Label for the lifetime window, given how far back the record goes.
 *
 * A lifetime figure over three weeks and one over three years wear the
 * same word, so the span goes in the label rather than being left for a
 * reviewer to find in a timestamp further down the page.
 */
export function lifetimeScopeLabel(firstObservedAt: string | null, now: Date): string {
  if (firstObservedAt === null) return 'All time';

  const start = new Date(firstObservedAt);
  if (Number.isNaN(start.getTime())) return 'All time';

  const days = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 86_400_000));
  if (days < 60) return `All time (${days} day${days === 1 ? '' : 's'} of record)`;

  const months = Math.round(days / 30);
  if (months < 24) return `All time (${months} months of record)`;

  const years = Math.floor(days / 365);
  return `All time (${years}+ years of record)`;
}
