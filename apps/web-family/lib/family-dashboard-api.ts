import {
  FamilyVisitsDashboardResponseSchema,
  type DashboardVisitNoteSummary,
  type DashboardWindowDays,
  type FamilyVisitsDashboardResponse,
  type VisitNoteAppetite,
  type VisitNoteHydration,
  type VisitNoteMood,
  type VisitNoteSocialEngagement,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Family peace-of-mind dashboard read client for the family portal
 * (TS-230).
 *
 * Calls `GET /api/v1/bookings/dashboard/me` via the gateway BFF. The
 * household is resolved downstream from the token `tenantScope` — no
 * id crosses the wire. Server-side only: every call originates from a
 * Next.js server component and forwards the portal's HttpOnly access
 * cookie to the gateway via `callGateway`.
 *
 * Returns a discriminated union so the page can branch cleanly:
 *   - `ok`           — render the dashboard.
 *   - `unauthorized` — redirect to login (session expired).
 *   - `unavailable`  — render a soft "couldn't load" state.
 */
export type FamilyVisitsDashboardResult =
  | { readonly kind: 'ok'; readonly dashboard: FamilyVisitsDashboardResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable' };

export async function getFamilyVisitsDashboard(args: {
  readonly windowDays?: DashboardWindowDays;
  readonly seniorId?: string;
  readonly historyCursor?: string;
}): Promise<FamilyVisitsDashboardResult> {
  const params = new URLSearchParams();
  if (args.windowDays !== undefined) params.set('windowDays', String(args.windowDays));
  if (args.seniorId !== undefined) params.set('seniorId', args.seniorId);
  if (args.historyCursor !== undefined) params.set('historyCursor', args.historyCursor);
  const query = params.toString();
  const path = `/api/v1/bookings/dashboard/me${query.length > 0 ? `?${query}` : ''}`;

  const result = await callGateway<unknown>(path);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') return { kind: 'unavailable' };

  const parsed = FamilyVisitsDashboardResponseSchema.safeParse(result.body);
  if (!parsed.success) return { kind: 'unavailable' };
  return { kind: 'ok', dashboard: parsed.data };
}

/**
 * Human-friendly labels for the coarse-grained wellness scales. Kept
 * warm + non-clinical (CLAUDE.md §12 — "hospitality, not clinical"):
 * we describe the senior's day, not a medical reading.
 */
const MOOD_LABELS: Record<VisitNoteMood, string> = {
  low: 'Low spirits',
  subdued: 'Subdued',
  neutral: 'At ease',
  bright: 'Bright',
  joyful: 'Joyful',
};

const APPETITE_LABELS: Record<VisitNoteAppetite, string> = {
  none: 'Ate nothing',
  minimal: 'A few bites',
  moderate: 'Half the plate',
  hearty: 'Hearty appetite',
  robust: 'Cleared the plate',
};

const HYDRATION_LABELS: Record<VisitNoteHydration, string> = {
  poor: 'Drank little',
  light: 'A few sips',
  adequate: 'Well hydrated',
  good: 'Drinking well',
  excellent: 'Plenty of fluids',
};

const SOCIAL_LABELS: Record<VisitNoteSocialEngagement, string> = {
  withdrawn: 'Quiet company',
  reserved: 'Reserved',
  present: 'Present and chatty',
  engaged: 'Engaged',
  vibrant: 'Full of stories',
};

export interface WellnessChip {
  readonly label: string;
  readonly value: string;
}

/**
 * Project a visit-note summary into the chip rows the dashboard
 * renders. Null scales are dropped (a chip is only shown when the
 * provider recorded that signal).
 */
export function toWellnessChips(notes: DashboardVisitNoteSummary): readonly WellnessChip[] {
  const chips: WellnessChip[] = [];
  if (notes.mood !== null) chips.push({ label: 'Spirits', value: MOOD_LABELS[notes.mood] });
  if (notes.appetite !== null) {
    chips.push({ label: 'Appetite', value: APPETITE_LABELS[notes.appetite] });
  }
  if (notes.hydration !== null) {
    chips.push({ label: 'Hydration', value: HYDRATION_LABELS[notes.hydration] });
  }
  if (notes.socialEngagement !== null) {
    chips.push({ label: 'Company', value: SOCIAL_LABELS[notes.socialEngagement] });
  }
  return chips;
}
