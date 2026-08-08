'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  ScheduleConciergeEventRequestSchema,
  UpdateConciergeEventRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the concierge scheduled-events surface (TS-227; PRD §5.1
 * Tier 3; PDD §10.6).
 *
 *   - `scheduleEventAction(formData)` — schedule a new event.
 *   - `updateEventAction(eventId, formData)` — reschedule / change status /
 *     edit fields on an existing event.
 *
 * Each re-validates the payload via the contract schema (defence-in-depth),
 * mints a fresh `Idempotency-Key` per submission (CLAUDE.md §3.3), forwards
 * through the gateway BFF (which gates on `concierge:write` + re-validates),
 * then revalidates + redirects back with `?action=ok` (or `?action=err&code=…`)
 * for the inline banner.
 *
 * Times are entered as UTC via `<input type="datetime-local">` and serialised
 * to an ISO-with-offset string the contract accepts.
 */

const BASE_PATH = '/concierge/scheduled-events';

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

export async function scheduleEventAction(formData: FormData): Promise<void> {
  const householdId = stringField(formData, 'householdId');
  const scheduledStartLocal = stringField(formData, 'scheduledStart');
  if (householdId === null || scheduledStartLocal === null) {
    return redirectWithError('invalid-input');
  }
  const scheduledStart = localToIso(scheduledStartLocal);
  if (scheduledStart === null) return redirectWithError('invalid-input');

  const scheduledEndLocal = stringField(formData, 'scheduledEnd');
  const scheduledEnd = scheduledEndLocal === null ? undefined : localToIso(scheduledEndLocal);
  if (scheduledEndLocal !== null && scheduledEnd === null)
    return redirectWithError('invalid-input');

  const body: Record<string, unknown> = {
    householdId,
    kind: stringField(formData, 'kind'),
    title: stringField(formData, 'title'),
    scheduledStart,
    status: stringField(formData, 'status') ?? 'proposed',
    externalProvider: stringField(formData, 'externalProvider') ?? 'manual',
  };
  setIfPresent(body, 'ticketId', stringField(formData, 'ticketId'));
  setIfPresent(body, 'venueName', stringField(formData, 'venueName'));
  setIfPresent(body, 'venueAddress', stringField(formData, 'venueAddress'));
  if (scheduledEnd !== undefined) body['scheduledEnd'] = scheduledEnd;
  setIfPresent(body, 'externalReference', stringField(formData, 'externalReference'));
  setIfPresent(body, 'notes', stringField(formData, 'notes'));
  const partySize = numberField(formData, 'partySize');
  if (partySize !== null) body['partySize'] = partySize;

  const validated = ScheduleConciergeEventRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError('invalid-input');

  const idempotencyKey = `admin-concierge-event-schedule-${randomUUID()}`;
  const result = await callGateway<unknown>(`/api/v1/admin/concierge/scheduled-events`, {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': idempotencyKey },
  });
  finish(result);
}

export async function updateEventAction(eventId: string, formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {};

  const status = stringField(formData, 'status');
  if (status !== null) body['status'] = status;
  const externalReference = stringField(formData, 'externalReference');
  if (externalReference !== null) body['externalReference'] = externalReference;
  const notes = stringField(formData, 'notes');
  if (notes !== null) body['notes'] = notes;

  const scheduledStartLocal = stringField(formData, 'scheduledStart');
  if (scheduledStartLocal !== null) {
    const iso = localToIso(scheduledStartLocal);
    if (iso === null) return redirectWithError('invalid-input', eventId);
    body['scheduledStart'] = iso;
  }
  const scheduledEndLocal = stringField(formData, 'scheduledEnd');
  if (scheduledEndLocal !== null) {
    const iso = localToIso(scheduledEndLocal);
    if (iso === null) return redirectWithError('invalid-input', eventId);
    body['scheduledEnd'] = iso;
  }

  if (Object.keys(body).length === 0) return redirectWithError('invalid-input', eventId);

  const validated = UpdateConciergeEventRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError('invalid-input', eventId);

  const idempotencyKey = `admin-concierge-event-update-${eventId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/scheduled-events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      body: validated.data,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
  finish(result, eventId);
}

function finish(result: Awaited<ReturnType<typeof callGateway<unknown>>>, eventId?: string): void {
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(BASE_PATH);
    return redirectWithSuccess();
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError('conflict', eventId);
    if (result.status === 404) return redirectWithError('not-found', eventId);
    return redirectWithError('bad-request', eventId);
  }
  return redirectWithError('service-warning', eventId);
}

function setIfPresent(bag: Record<string, unknown>, key: string, value: string | null): void {
  if (value !== null) bag[key] = value;
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function numberField(formData: FormData, key: string): number | null {
  const raw = stringField(formData, key);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** datetime-local (`YYYY-MM-DDTHH:MM(:SS)?`) → ISO UTC string. */
function localToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(local);
  if (m === null) return null;
  return `${m[1]}${m[2] ?? ':00'}Z`;
}

function redirectWithSuccess(): never {
  redirect(`${BASE_PATH}?action=ok`);
}

function redirectWithError(code: ActionErrorCode, eventId?: string): never {
  const focus = eventId === undefined ? '' : `&event=${encodeURIComponent(eventId)}`;
  redirect(`${BASE_PATH}?action=err&code=${code}${focus}`);
}
