import { PROVIDER_ADVERSE_BACKGROUND_CHECK_STATUSES } from '@taste-and-see/contracts';

import type { BackgroundCheckRecordStatus } from './background-check.service';

/**
 * When a background-check result becomes a trust & safety matter
 * (TS-307a).
 *
 * Two questions, kept separate on purpose: *is this result adverse* and
 * *is this provider someone a senior is currently exposed to*. Both must
 * be true.
 */

/** Provider statuses mirrored from the Prisma `ProviderStatus` enum. */
export type ProviderRecordStatus = 'pending' | 'in_review' | 'active' | 'suspended' | 'archived';

const ADVERSE: ReadonlySet<string> = new Set(PROVIDER_ADVERSE_BACKGROUND_CHECK_STATUSES);

/**
 * `true` for the statuses this platform treats as needing a human to
 * look: `consider`, `suspended`, `dispute`, `failed`.
 *
 * The set lives in `packages/contracts` rather than here so the
 * producer and the trust-safety consumer cannot disagree about what
 * "adverse" means — a divergence there would either raise incidents
 * nobody expects or drop ones somebody is relying on.
 */
export function isAdverseBackgroundCheckStatus(status: BackgroundCheckRecordStatus): boolean {
  return ADVERSE.has(status);
}

/**
 * Whether a background-check transition should raise a trust & safety
 * incident.
 *
 * **Only `active` providers.** An adverse result during initial
 * screening belongs to the application flow: that person is not on the
 * platform, holds no bookings, and no senior is exposed — routing it to
 * trust & safety would bury the queue in ordinary onboarding rejections
 * and put a hiring decision in a safety workflow. `suspended` and
 * `archived` providers are excluded for the same reason from the other
 * end: they are already off the platform, and the finding changes
 * nothing about a senior's exposure today. If ops later wants a record
 * against a suspended provider, that is a deliberate widening, not a
 * bug in this predicate.
 *
 * **The previous status does not gate the decision.** A second adverse
 * report on an already-flagged provider is new information, not a
 * duplicate — `consider → consider` raises again. Replay safety comes
 * from the caller's `lastEventId` check and the outbox's deterministic
 * event id, not from suppressing repeat findings, because those are two
 * different things and conflating them would silently swallow a real
 * second report.
 */
export function shouldRaiseAdverseFinding(input: {
  readonly nextStatus: BackgroundCheckRecordStatus;
  readonly providerStatus: ProviderRecordStatus;
}): boolean {
  return input.providerStatus === 'active' && isAdverseBackgroundCheckStatus(input.nextStatus);
}
