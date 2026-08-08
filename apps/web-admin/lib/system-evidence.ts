import type {
  TrustSafetyIncidentDetector,
  TrustSafetySystemEvidence,
} from '@taste-and-see/contracts';

/**
 * Rendering rules for the evidence a detector recorded when it opened an
 * incident (TS-308c-followup-2).
 *
 * **Why this is a `.ts` module and not inline in the page.** web-admin's
 * test lane deliberately excludes `.tsx` (TS-303c2b-followup-1) — server
 * components are `await fetch` plus JSX and belong to Playwright. But the
 * decisions below are not rendering: which detector produced what, what a
 * number means, and what to say when a stored blob no longer parses. Those
 * are worth asserting, so they live here.
 *
 * **These labels are the operator's only explanation of the incident.** Every
 * system-opened incident has a null `description` by design (the source
 * events refuse to carry free text about a named senior), so before this
 * existed the detail page showed a category, a severity, a subject and
 * nothing else. The wording therefore has to state what was measured without
 * asserting what it means — "implied speed 749.5 km/h against a 1,000 km/h
 * ceiling" is a fact; "the provider faked their location" is a conclusion the
 * reviewer is there to reach.
 */

export interface EvidenceRow {
  readonly label: string;
  readonly value: string;
  /** Rendered as a `<code>` handle rather than prose — ids only. */
  readonly isId?: boolean;
}

export interface EvidenceView {
  /** One line naming what the detector observed. Never a verdict. */
  readonly headline: string;
  readonly rows: readonly EvidenceRow[];
}

/** Human-readable detector names, for the "Detected by" line. */
const DETECTOR_LABELS: Record<TrustSafetyIncidentDetector, string> = {
  background_check: 'Background-check monitoring',
  impossible_travel: 'Impossible-travel detection',
  mass_cancellation: 'Mass-cancellation detection',
};

/**
 * Name a detector for display.
 *
 * `null` covers two cases the page must keep apart from each other but can
 * describe the same way: a human-filed report (no detector) and a stored
 * detector name this build does not recognise. The caller knows which it is
 * from whether the incident's source is `system`.
 */
export function detectorLabel(detector: TrustSafetyIncidentDetector | null): string | null {
  return detector === null ? null : DETECTOR_LABELS[detector];
}

/**
 * Turn stored evidence into labelled rows.
 *
 * Exhaustive over the union — a fourth detector added to the contract is a
 * compile error here, which is the point: the alternative is a new detector
 * silently rendering as a blank panel, which is the exact failure this whole
 * slice fixes.
 */
export function describeSystemEvidence(evidence: TrustSafetySystemEvidence): EvidenceView {
  switch (evidence.detector) {
    case 'background_check':
      return {
        headline: `A background check on this provider returned "${formatWords(evidence.status)}".`,
        rows: [
          { label: 'Current status', value: formatWords(evidence.status) },
          {
            label: 'Previous status',
            value:
              evidence.previousStatus === null
                ? 'none recorded'
                : formatWords(evidence.previousStatus),
          },
          { label: 'Background check', value: evidence.backgroundCheckId, isId: true },
        ],
      };

    case 'impossible_travel':
      return {
        headline:
          `Two check-ins ${formatDistance(evidence.distanceMeters)} apart, ` +
          `${formatDuration(evidence.elapsedSeconds)} apart in time.`,
        rows: [
          {
            label: 'Implied speed',
            // Both numbers together, always: the threshold in force at
            // detection time is what makes the speed mean anything, and it
            // may have been retuned since.
            value: `${formatNumber(evidence.impliedSpeedKph)} km/h (ceiling ${formatNumber(evidence.thresholdKph)} km/h)`,
          },
          { label: 'Distance', value: formatDistance(evidence.distanceMeters) },
          { label: 'Time between', value: formatDuration(evidence.elapsedSeconds) },
          { label: 'Earlier check-in', value: evidence.previousCheckInId, isId: true },
          { label: 'Later check-in', value: evidence.checkInId, isId: true },
          { label: 'Earlier visit', value: evidence.previousBookingId, isId: true },
          { label: 'Later visit', value: evidence.bookingId, isId: true },
        ],
      };

    case 'mass_cancellation': {
      const subject = evidence.subjectKind === 'provider' ? 'provider' : 'household';
      return {
        headline:
          `${evidence.distinctCancellationCount} separate cancellation decisions against this ` +
          `${subject} (threshold ${evidence.threshold}), covering ` +
          `${evidence.canceledBookingCount} ${evidence.canceledBookingCount === 1 ? 'visit' : 'visits'}.`,
        rows: [
          {
            label: 'Cancellation decisions',
            value: `${evidence.distinctCancellationCount} (threshold ${evidence.threshold})`,
          },
          {
            label: 'Visits affected',
            // Named separately from the decision count because a cancelled
            // recurring series is ONE decision covering many visits — the
            // gap between these two numbers is usually the explanation.
            value: `${evidence.canceledBookingCount}`,
          },
          { label: 'Distinct people cancelling', value: formatActors(evidence) },
          // Only when non-zero. A row reading "0 cancelled by our own
          // team" on every incident is noise that trains an operator to
          // skip the panel; a row reading "8" is the answer.
          ...(evidence.staffExcludedCount > 0
            ? [
                {
                  label: 'Excluded — cancelled by our team',
                  value:
                    `${evidence.staffExcludedCount} more ` +
                    `${evidence.staffExcludedCount === 1 ? 'visit was' : 'visits were'} cancelled by ` +
                    `platform staff and ${evidence.staffExcludedCount === 1 ? 'is' : 'are'} not counted above`,
                },
              ]
            : []),
          {
            label: 'Window',
            value: `${formatTimestamp(evidence.windowStart)} → ${formatTimestamp(evidence.windowEnd)}`,
          },
        ],
      };
    }
  }
}

/**
 * The actor count, with the unattributed rows stated rather than folded in.
 *
 * A bare "1" would read as certainty. Cancellations made before the platform
 * recorded who made them carry no actor at all, so the count is a floor, and
 * the operator has to be able to see that — otherwise "1 person" invites a
 * conclusion the data does not support.
 */
function formatActors(evidence: {
  readonly distinctActorCount: number;
  readonly unattributedCount: number;
}): string {
  const base = `${evidence.distinctActorCount}`;
  if (evidence.unattributedCount === 0) return base;
  return `${base} (plus ${evidence.unattributedCount} with no recorded actor — this is a minimum)`;
}

function formatDistance(meters: number): string {
  return meters >= 1_000 ? `${formatNumber(meters / 1_000)} km` : `${meters} m`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function formatNumber(value: number): string {
  // One decimal at most, and no trailing `.0` — these are read, not summed.
  return `${Math.round(value * 10) / 10}`;
}

function formatWords(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${parsed.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
