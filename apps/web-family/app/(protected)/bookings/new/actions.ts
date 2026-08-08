'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { callGateway } from '@/lib/api';

/**
 * Server action backing the family-portal booking-request form
 * (TS-125).
 *
 * The form posts (a) the provider id (carried as a hidden field from
 * the page query), (b) household + senior ids (Phase-1: both default
 * to the user's `me.userId` because household-svc isn't wired —
 * TS-125-followup-2 captures the upgrade), (c) the requested service
 * kind, (d) start + end times, (e) optional notes.
 *
 * Failure surfaces:
 *   - `validation_failed` — payload malformed (stale tab / tampered field).
 *   - `provider_unavailable` — gateway returned 409 (e.g. tier-gating).
 *   - `service_error`     — gateway / downstream unreachable.
 */

export interface BookingRequestState {
  readonly status: 'idle' | 'error';
  readonly message?: string;
}

export const INITIAL_BOOKING_REQUEST_STATE: BookingRequestState = { status: 'idle' };

const FormSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    householdId: z.string().min(1).max(64),
    seniorId: z.string().min(1).max(64),
    serviceKind: z.enum([
      'companion_dining',
      'personal_chef_visit',
      'grocery_coordination',
      'transportation',
      'social_outing',
      'event_dining',
      'emergency_concierge',
    ]),
    scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    scheduledTime: z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:MM'),
    durationHours: z
      .string()
      .regex(/^\d+(\.\d)?$/, 'duration must be a number')
      .transform((s) => Number(s))
      .refine((n) => n >= 1 && n <= 8, 'duration must be 1–8 hours'),
    bookingNotes: z.string().max(2_000).optional(),
    // TS-217-prep-4c — optional search-correlation token threaded from the
    // provider-discovery search through the request-a-visit link.
    searchId: z.string().min(1).max(128).optional(),
  })
  .superRefine((body, ctx) => {
    const start = parseLocalStart(body.scheduledDate, body.scheduledTime);
    if (start === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'date / time is malformed',
        path: ['scheduledDate'],
      });
      return;
    }
    if (start.getTime() < Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scheduled time must be in the future',
        path: ['scheduledDate'],
      });
    }
  });

/**
 * Parse a `YYYY-MM-DD` + `HH:MM` pair as a local-time Date. Returns
 * null if either piece is malformed.
 */
function parseLocalStart(date: string, time: string): Date | null {
  const [yearStr, monthStr, dayStr] = date.split('-');
  const [hourStr, minuteStr] = time.split(':');
  if (
    yearStr === undefined ||
    monthStr === undefined ||
    dayStr === undefined ||
    hourStr === undefined ||
    minuteStr === undefined
  ) {
    return null;
  }
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const day = Number.parseInt(dayStr, 10);
  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);
  if ([year, month, day, hour, minute].some((n) => Number.isNaN(n))) return null;
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

export async function requestBookingAction(
  _prev: BookingRequestState,
  formData: FormData,
): Promise<BookingRequestState> {
  const parsed = FormSchema.safeParse({
    providerId: formData.get('providerId'),
    householdId: formData.get('householdId'),
    seniorId: formData.get('seniorId'),
    serviceKind: formData.get('serviceKind'),
    scheduledDate: formData.get('scheduledDate'),
    scheduledTime: formData.get('scheduledTime'),
    durationHours: formData.get('durationHours'),
    bookingNotes: formData.get('bookingNotes') ?? undefined,
    searchId: formData.get('searchId') ?? undefined,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message:
        parsed.error.issues[0]?.message ??
        'Some of the request details look off — please double-check and try again.',
    };
  }

  const start = parseLocalStart(parsed.data.scheduledDate, parsed.data.scheduledTime)!;
  const end = new Date(start.getTime() + parsed.data.durationHours * 60 * 60 * 1000);

  const body: Record<string, unknown> = {
    householdId: parsed.data.householdId,
    seniorId: parsed.data.seniorId,
    providerId: parsed.data.providerId,
    serviceKind: parsed.data.serviceKind,
    scheduledStart: start.toISOString(),
    scheduledEnd: end.toISOString(),
  };
  if (parsed.data.bookingNotes !== undefined && parsed.data.bookingNotes.length > 0) {
    body['bookingNotes'] = parsed.data.bookingNotes;
  }
  if (parsed.data.searchId !== undefined) {
    body['searchId'] = parsed.data.searchId;
  }

  const result = await callGateway<{ id: string }>('/api/v1/bookings/concierge-request', {
    method: 'POST',
    body,
  });

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'client_error' && result.status === 409) {
    return {
      status: 'error',
      message:
        "This provider isn't available for your current tier. Pick another chef or upgrade your plan.",
    };
  }
  if (result.kind !== 'ok') {
    return {
      status: 'error',
      message: "We couldn't reach our booking service. Please try again in a moment.",
    };
  }

  redirect(`/bookings/${encodeURIComponent(result.body.id)}?requested=1`);
}
