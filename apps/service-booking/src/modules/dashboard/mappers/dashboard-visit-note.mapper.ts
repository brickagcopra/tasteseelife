import type {
  DashboardVisitNoteSummary,
  VisitNoteAppetite,
  VisitNoteHydration,
  VisitNoteMood,
  VisitNoteSocialEngagement,
} from '@taste-and-see/contracts';

/**
 * Minimal structural shape of a `booking_visit_notes` row as read by
 * the family dashboard (TS-230). We only `select` the fields the
 * family-facing summary needs — the provider `recordedByUserId` and
 * the raw `photoKeys` array are intentionally NOT projected into the
 * summary (CLAUDE.md §12 family-observability boundary; photo
 * rendering is owned by TS-232 behind the media-svc consent gate).
 */
export interface DashboardVisitNoteRow {
  readonly mood: VisitNoteMood | null;
  readonly appetite: VisitNoteAppetite | null;
  readonly hydration: VisitNoteHydration | null;
  readonly socialEngagement: VisitNoteSocialEngagement | null;
  readonly freeform: string | null;
  readonly photoKeys: readonly string[];
  readonly recordedAt: Date;
}

/**
 * Convert a `booking_visit_notes` row to the family-facing
 * `DashboardVisitNoteSummary` (CLAUDE.md §3.3 — DTO mappers, never
 * return raw Prisma objects).
 *
 * The four coarse-grained wellness scales + the freeform narrative
 * pass through verbatim (the persistence layer already uses the
 * contract enum strings). `photoKeys` collapses to a `photoCount` —
 * the dashboard surfaces only how many photos were shared, never the
 * keys (TS-232 owns the consent-gated signed-URL rendering).
 */
export function toDashboardVisitNoteSummary(row: DashboardVisitNoteRow): DashboardVisitNoteSummary {
  return {
    mood: row.mood,
    appetite: row.appetite,
    hydration: row.hydration,
    socialEngagement: row.socialEngagement,
    freeform: row.freeform,
    photoCount: row.photoKeys.length,
    recordedAt: row.recordedAt.toISOString(),
  };
}
