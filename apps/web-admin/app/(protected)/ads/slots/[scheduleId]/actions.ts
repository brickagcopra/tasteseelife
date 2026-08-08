'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  AdSlotScheduleStatusSchema,
  UpdateAdSlotScheduleRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the slot-schedule EDITOR surface (TS-272b; PRD §10.9; PDD
 * §18.1, §8.2).
 *
 *   - `updateScheduleAction`     — edit the delivery window + priority.
 *   - `transitionScheduleAction` — move the schedule through its status matrix.
 *
 * Each re-validates via the contract schema (defence-in-depth), mints a fresh
 * `Idempotency-Key` (CLAUDE.md §3.3), forwards through the gateway BFF (which
 * gates on `ads:write` + re-validates), then revalidates + redirects back to the
 * editor with `?action=ok` (or `?action=err&code=…`).
 *
 * `placementId` / `campaignId` are NOT editable — rebinding a slot to a
 * different campaign is a new schedule (the backend rejects those fields).
 */

const LIST_PATH = '/ads/slots';
const GW_SCHEDULES = '/api/v1/admin/ads/slot-schedules';

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

function detailPath(scheduleId: string): string {
  return `${LIST_PATH}/${encodeURIComponent(scheduleId)}`;
}

export async function updateScheduleAction(scheduleId: string, formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {};

  if (formData.has('startAt')) {
    const iso = localToIso(stringField(formData, 'startAt'));
    // startAt is non-nullable on the schedule; a cleared value is invalid input.
    if (iso === 'invalid' || iso === null) return redirectWithError(scheduleId, 'invalid-input');
    body['startAt'] = iso;
  }

  if (formData.has('endAt')) {
    const iso = localToIso(stringField(formData, 'endAt'));
    if (iso === 'invalid') return redirectWithError(scheduleId, 'invalid-input');
    // Blank endAt clears it (→ null = open-ended).
    body['endAt'] = iso;
  }

  if (formData.has('priority')) {
    const raw = stringField(formData, 'priority');
    if (raw === null) return redirectWithError(scheduleId, 'invalid-input');
    const priority = parseIntField(raw);
    if (priority === null) return redirectWithError(scheduleId, 'invalid-input');
    body['priority'] = priority;
  }

  if (Object.keys(body).length === 0) return redirectWithError(scheduleId, 'invalid-input');

  const validated = UpdateAdSlotScheduleRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(scheduleId, 'invalid-input');

  const result = await send(validated.data, 'schedule-update', scheduleId);
  finish(result, scheduleId);
}

export async function transitionScheduleAction(
  scheduleId: string,
  status: string,
  _formData: FormData,
): Promise<void> {
  const parsed = AdSlotScheduleStatusSchema.safeParse(status);
  if (!parsed.success) return redirectWithError(scheduleId, 'invalid-input');
  const result = await send({ status: parsed.data }, 'schedule-transition', scheduleId);
  finish(result, scheduleId);
}

// ─── Shared plumbing ────────────────────────────────────────────────────────

async function send(
  body: unknown,
  surface: string,
  scheduleId: string,
): Promise<Awaited<ReturnType<typeof callGateway<unknown>>>> {
  const key = `admin-ads-${surface}-${scheduleId}-${randomUUID()}`;
  return callGateway<unknown>(`${GW_SCHEDULES}/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH',
    body,
    headers: { 'idempotency-key': key },
  });
}

function finish(
  result: Awaited<ReturnType<typeof callGateway<unknown>>>,
  scheduleId: string,
): void {
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(detailPath(scheduleId));
    redirect(`${detailPath(scheduleId)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(scheduleId, 'conflict');
    if (result.status === 404) return redirectWithError(scheduleId, 'not-found');
    return redirectWithError(scheduleId, 'bad-request');
  }
  return redirectWithError(scheduleId, 'service-warning');
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

/** datetime-local → ISO UTC string, null (clear) when empty, or 'invalid'. */
function localToIso(local: string | null): string | null | 'invalid' {
  if (local === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(local);
  if (m === null) return 'invalid';
  return `${m[1]}${m[2] ?? ':00'}Z`;
}

function redirectWithError(scheduleId: string, code: ActionErrorCode): never {
  redirect(`${detailPath(scheduleId)}?action=err&code=${code}`);
}
