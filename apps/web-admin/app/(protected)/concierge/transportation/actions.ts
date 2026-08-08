'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  ScheduleConciergeTransportationRequestSchema,
  UpdateConciergeTransportationRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the concierge transportation surface (TS-226; PRD §5.1
 * Tier 3; PDD §10.6).
 *
 *   - `scheduleRideAction(formData)` — arrange a new ride.
 *   - `updateRideAction(requestId, formData)` — reschedule / change status
 *     (incl. cancel) / edit fields on an existing ride.
 *
 * Each re-validates the payload via the contract schema (defence-in-depth),
 * mints a fresh `Idempotency-Key` per submission (CLAUDE.md §3.3), forwards
 * through the gateway BFF (which gates on `concierge:write` + re-validates),
 * then revalidates + redirects back with `?action=ok` (or `?action=err&code=…`)
 * for the inline banner.
 *
 * The pickup time is entered as UTC via `<input type="datetime-local">` and
 * serialised to an ISO-with-offset string the contract accepts.
 */

const BASE_PATH = '/concierge/transportation';

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

export async function scheduleRideAction(formData: FormData): Promise<void> {
  const householdId = stringField(formData, 'householdId');
  const pickupAddress = stringField(formData, 'pickupAddress');
  const dropoffAddress = stringField(formData, 'dropoffAddress');
  const scheduledPickupLocal = stringField(formData, 'scheduledPickupAt');
  if (
    householdId === null ||
    pickupAddress === null ||
    dropoffAddress === null ||
    scheduledPickupLocal === null
  ) {
    return redirectWithError('invalid-input');
  }
  const scheduledPickupAt = localToIso(scheduledPickupLocal);
  if (scheduledPickupAt === null) return redirectWithError('invalid-input');

  const body: Record<string, unknown> = {
    householdId,
    pickupAddress,
    dropoffAddress,
    scheduledPickupAt,
    status: stringField(formData, 'status') ?? 'requested',
    externalProvider: stringField(formData, 'externalProvider') ?? 'manual',
  };
  setIfPresent(body, 'ticketId', stringField(formData, 'ticketId'));
  setIfPresent(body, 'purpose', stringField(formData, 'purpose'));
  setIfPresent(body, 'riderName', stringField(formData, 'riderName'));
  setIfPresent(body, 'externalReference', stringField(formData, 'externalReference'));
  setIfPresent(body, 'notes', stringField(formData, 'notes'));

  const validated = ScheduleConciergeTransportationRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError('invalid-input');

  const idempotencyKey = `admin-concierge-ride-schedule-${randomUUID()}`;
  const result = await callGateway<unknown>(`/api/v1/admin/concierge/transportation`, {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': idempotencyKey },
  });
  finish(result);
}

export async function updateRideAction(requestId: string, formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {};

  const status = stringField(formData, 'status');
  if (status !== null) body['status'] = status;
  const pickupAddress = stringField(formData, 'pickupAddress');
  if (pickupAddress !== null) body['pickupAddress'] = pickupAddress;
  const dropoffAddress = stringField(formData, 'dropoffAddress');
  if (dropoffAddress !== null) body['dropoffAddress'] = dropoffAddress;
  const externalReference = stringField(formData, 'externalReference');
  if (externalReference !== null) body['externalReference'] = externalReference;
  const notes = stringField(formData, 'notes');
  if (notes !== null) body['notes'] = notes;

  const scheduledPickupLocal = stringField(formData, 'scheduledPickupAt');
  if (scheduledPickupLocal !== null) {
    const iso = localToIso(scheduledPickupLocal);
    if (iso === null) return redirectWithError('invalid-input', requestId);
    body['scheduledPickupAt'] = iso;
  }

  if (Object.keys(body).length === 0) return redirectWithError('invalid-input', requestId);

  const validated = UpdateConciergeTransportationRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError('invalid-input', requestId);

  const idempotencyKey = `admin-concierge-ride-update-${requestId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/transportation/${encodeURIComponent(requestId)}`,
    {
      method: 'PATCH',
      body: validated.data,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
  finish(result, requestId);
}

function finish(
  result: Awaited<ReturnType<typeof callGateway<unknown>>>,
  requestId?: string,
): void {
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(BASE_PATH);
    return redirectWithSuccess();
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError('conflict', requestId);
    if (result.status === 404) return redirectWithError('not-found', requestId);
    return redirectWithError('bad-request', requestId);
  }
  return redirectWithError('service-warning', requestId);
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

/** datetime-local (`YYYY-MM-DDTHH:MM(:SS)?`) → ISO UTC string. */
function localToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(local);
  if (m === null) return null;
  return `${m[1]}${m[2] ?? ':00'}Z`;
}

function redirectWithSuccess(): never {
  redirect(`${BASE_PATH}?action=ok`);
}

function redirectWithError(code: ActionErrorCode, requestId?: string): never {
  const focus = requestId === undefined ? '' : `&request=${encodeURIComponent(requestId)}`;
  redirect(`${BASE_PATH}?action=err&code=${code}${focus}`);
}
