'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { CreateAdSlotScheduleRequestSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server action for the slot-schedule LIST surface (TS-272b; PRD §10.9; PDD
 * §18.1).
 *
 *   - `createScheduleAction(formData)` — book a campaign into a placement over a
 *     delivery window, then redirect to its editor.
 *
 * Re-validates the payload via the contract schema (defence-in-depth), mints a
 * fresh `Idempotency-Key` per submission (CLAUDE.md §3.3), forwards through the
 * gateway BFF (which gates on `ads:write` + re-validates), then redirects to the
 * new schedule's editor page (or back to the list with `?action=err`).
 *
 * No money crosses here — a schedule is the inventory binding only; budget +
 * targeting live on the campaign aggregate (TS-271a).
 */

const LIST_PATH = '/ads/slots';

type ActionErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'conflict'
  | 'bad-request'
  | 'service-warning';

export async function createScheduleAction(formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {
    placementId: stringField(formData, 'placementId'),
    campaignId: stringField(formData, 'campaignId'),
    status: stringField(formData, 'status') ?? 'scheduled',
  };

  const startAt = localFieldToIso(formData, 'startAt');
  if (startAt === 'invalid' || startAt === null) return redirectWithError('invalid-input');
  body['startAt'] = startAt;

  const endAt = localFieldToIso(formData, 'endAt');
  if (endAt === 'invalid') return redirectWithError('invalid-input');
  if (endAt !== null) body['endAt'] = endAt;

  const priorityRaw = stringField(formData, 'priority');
  if (priorityRaw !== null) {
    const priority = parseIntField(priorityRaw);
    if (priority === null) return redirectWithError('invalid-input');
    body['priority'] = priority;
  }

  const validated = CreateAdSlotScheduleRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError('invalid-input');

  const key = `admin-ads-slot-schedule-create-${randomUUID()}`;
  const result = await callGateway<{ schedule: { id: string } }>(
    '/api/v1/admin/ads/slot-schedules',
    {
      method: 'POST',
      body: validated.data,
      headers: { 'idempotency-key': key },
    },
  );

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(LIST_PATH);
    redirect(`${LIST_PATH}/${encodeURIComponent(result.body.schedule.id)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 404) return redirectWithError('not-found');
    if (result.status === 409) return redirectWithError('conflict');
    if (result.status === 422) return redirectWithError('not-found');
    return redirectWithError('bad-request');
  }
  return redirectWithError('service-warning');
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Bounded non-negative integer (priority); null on a malformed value. */
function parseIntField(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** Read a datetime-local field → ISO UTC, or null if absent, or 'invalid'. */
function localFieldToIso(formData: FormData, key: string): string | null | 'invalid' {
  const local = stringField(formData, key);
  if (local === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(local);
  if (m === null) return 'invalid';
  return `${m[1]}${m[2] ?? ':00'}Z`;
}

function redirectWithError(code: ActionErrorCode): never {
  redirect(`${LIST_PATH}?action=err&code=${code}`);
}
