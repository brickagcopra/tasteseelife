import {
  BookingResponseSchema,
  BookingsListResponseSchema,
  type BookingResponse,
  type BookingServiceKind,
  type BookingStatus,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Bookings client for the family portal (TS-125).
 *
 * Three operations:
 *   - `listBookings` → `GET  /api/v1/bookings?householdId=...`
 *   - `getBooking`   → `GET  /api/v1/bookings/:id`
 *   - `requestBooking` → `POST /api/v1/bookings/concierge-request`
 *
 * Server-side only — every call originates from a Next.js server
 * component or server action and forwards the portal's HttpOnly access
 * cookie to the gateway via `callGateway`.
 */

export interface BookingsListOk {
  readonly kind: 'ok';
  readonly bookings: readonly BookingResponse[];
  readonly nextCursor: string | null;
}
export interface BookingsListUnauthorized {
  readonly kind: 'unauthorized';
}
export interface BookingsListFailure {
  readonly kind: 'failure';
  readonly detail: string;
}
export type BookingsListResult = BookingsListOk | BookingsListUnauthorized | BookingsListFailure;

export async function listBookings(args: {
  readonly householdId: string;
  readonly cursor?: string;
}): Promise<BookingsListResult> {
  const params = new URLSearchParams();
  params.set('householdId', args.householdId);
  if (args.cursor !== undefined) params.set('cursor', args.cursor);
  const result = await callGateway<unknown>(`/api/v1/bookings?${params.toString()}`);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = BookingsListResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed bookings response' };
  }
  return { kind: 'ok', bookings: parsed.data.bookings, nextCursor: parsed.data.nextCursor };
}

export interface BookingGetOk {
  readonly kind: 'ok';
  readonly booking: BookingResponse;
}
export type BookingGetResult =
  | BookingGetOk
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failure'; readonly detail: string };

export async function getBooking(id: string): Promise<BookingGetResult> {
  const result = await callGateway<unknown>(`/api/v1/bookings/${encodeURIComponent(id)}`);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error' && result.status === 404) return { kind: 'not_found' };
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = BookingResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed booking response' };
  }
  return { kind: 'ok', booking: parsed.data };
}

const SERVICE_KIND_LABELS: Record<BookingServiceKind, string> = {
  companion_dining: 'Companion dining',
  personal_chef_visit: 'Personal chef visit',
  grocery_coordination: 'Grocery coordination',
  transportation: 'Transportation',
  social_outing: 'Social outing',
  event_dining: 'Event dining',
  emergency_concierge: 'Emergency concierge',
  holiday_dinner: 'Holiday dinner',
  birthday_experience: 'Birthday experience',
  tea_social: 'Tea social',
  museum_outing: 'Museum outing',
  memory_meal: 'Memory meal',
  custom_request: 'Custom request',
};

export function formatServiceKind(kind: BookingServiceKind): string {
  return SERVICE_KIND_LABELS[kind];
}

const STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Pending — our concierge will confirm shortly',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  completed: 'Completed',
  canceled: 'Canceled',
  declined: 'Declined — re-routing to our concierge',
};

export function formatStatus(status: BookingStatus): string {
  return STATUS_LABELS[status];
}

/**
 * Renders an ISO 8601 timestamp into the family-portal "Sat, Jun 10 at
 * 5:00 PM" shape. Server-side only — `Intl.DateTimeFormat` uses the
 * server's locale (en-US) deterministically.
 */
export function formatVisitTime(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}
