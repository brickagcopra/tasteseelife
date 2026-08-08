import type { BookingHoldRow, MandatedReporterCaseStatus } from '@taste-and-see/contracts';

/**
 * Presentation logic for the trust & safety console, extracted from page
 * bodies so the `.ts`-only unit lane can reach it (TS-303c2b-followup-1a).
 *
 * These three are not cosmetic. One decides whether an operator is
 * offered a statutory signoff they are not permitted to give, one decides
 * how a missing legal deadline is described, and one decides how a set of
 * suspensions is grouped so a shared number is not read as a per-row one.
 * All three were reachable only through a server component.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether the four-eyes rule blocks THIS operator from THIS transition.
 *
 * A mandated-reporter signoff is a determination about suspected elder
 * abuse, and the service and a DB CHECK both refuse a signoff by the
 * operator who opened the case (TS-303b). The console hides the control
 * rather than offering one that 409s: a rejected statutory action reads
 * as a system fault at exactly the moment somebody needs to trust the
 * system.
 *
 * **Only `signed_off` is gated.** Every other transition is one operator's
 * to make, and gating them all would stall a case whenever its opener is
 * the only person on shift — which on a filing deadline is the opposite
 * of safe.
 */
export function isSignoffBlockedByFourEyes(input: {
  readonly to: MandatedReporterCaseStatus;
  readonly openedByUserId: string;
  readonly actorUserId: string;
}): boolean {
  return input.to === 'signed_off' && input.openedByUserId === input.actorUserId;
}

/**
 * Statutory-deadline countdown, null-safe.
 *
 * A null `statutoryDueAt` renders as an explicit compliance gap, never as
 * "no deadline" and never blank: the state's reporting window has not
 * been established in the jurisdiction kit, so the platform genuinely
 * does not know when this filing is due — which is a reason to act, not a
 * reason to relax. It carries the overdue styling for the same reason.
 *
 * An unparseable timestamp is treated the same way rather than being
 * rendered as `Invalid Date` or silently omitted.
 */
export function deadlineLabel(
  statutoryDueAt: string | null,
  now: number,
): { readonly text: string; readonly className: string } {
  if (statutoryDueAt === null) {
    return {
      text: 'state window not established',
      className: 'concierge-sla concierge-sla--overdue',
    };
  }
  const due = new Date(statutoryDueAt).getTime();
  if (Number.isNaN(due)) {
    return { text: 'deadline unreadable', className: 'concierge-sla concierge-sla--overdue' };
  }
  const diffMs = due - now;
  const overdue = diffMs < 0;
  const hours = Math.round(Math.abs(diffMs) / HOUR_MS);
  const label = hours >= 48 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  return {
    text: overdue ? `deadline passed ${label} ago` : `due in ${label}`,
    className: overdue ? 'concierge-sla concierge-sla--overdue' : 'concierge-sla',
  };
}

/** One incident's hold rows, plus the shared figures the group header states once. */
export interface HoldGroup {
  readonly incidentId: string;
  readonly severity: string;
  readonly category: string;
  readonly suspendedBookingCount: number;
  readonly rows: readonly BookingHoldRow[];
}

/**
 * Group consecutive booking-hold rows by incident.
 *
 * The API orders `heldAt DESC, incidentId ASC, subjectKind ASC`, so one
 * incident's rows are already adjacent — this walks them in order rather
 * than bucketing into a map, which keeps the page's group order identical
 * to the API's row order instead of silently re-sorting by insertion.
 *
 * The group's `severity` / `category` / count come from its first row.
 * They are snapshots of the same event on every row of one incident, so
 * any row would do; taking the first keeps the choice explicit. Grouping
 * exists at all because `incidentSuspendedBookingCount` is a PER-INCIDENT
 * figure (TS-304-followup-3): repeated once per row it would be summed by
 * eye into a number several times too large.
 */
export function groupByIncident(rows: readonly BookingHoldRow[]): readonly HoldGroup[] {
  const groups: HoldGroup[] = [];
  let current: { incidentId: string; rows: BookingHoldRow[] } | null = null;

  for (const row of rows) {
    if (current === null || current.incidentId !== row.incidentId) {
      current = { incidentId: row.incidentId, rows: [] };
      groups.push({
        incidentId: row.incidentId,
        severity: row.severity,
        category: row.category,
        suspendedBookingCount: row.incidentSuspendedBookingCount,
        rows: current.rows,
      });
    }
    current.rows.push(row);
  }

  return groups;
}
