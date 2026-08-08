'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  ConciergeOnboardingStepKeySchema,
  UpdateConciergeOnboardingRequestSchema,
  UpdateConciergeOnboardingStepRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the Tier-3 onboarding DETAIL surface (TS-228).
 *
 *   - `updateStepAction(onboardingId, stepKey, formData)` — advance / re-open
 *     one checklist step (status + optional notes).
 *   - `updateOnboardingAction(onboardingId, formData)` — edit the kickoff time
 *     / notes.
 *   - `cancelOnboardingAction(onboardingId, formData)` — cancel the onboarding.
 *
 * Each re-validates via the contract schema, mints a fresh `Idempotency-Key`,
 * forwards through the gateway BFF (which gates on `concierge:write`), then
 * revalidates + redirects back to the detail page with `?action=ok` (or
 * `?action=err&code=…`).
 */

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

function basePath(onboardingId: string): string {
  return `/concierge/onboarding/${encodeURIComponent(onboardingId)}`;
}

export async function updateStepAction(
  onboardingId: string,
  stepKey: string,
  formData: FormData,
): Promise<void> {
  const parsedStepKey = ConciergeOnboardingStepKeySchema.safeParse(stepKey);
  if (!parsedStepKey.success) return redirectWithError(onboardingId, 'invalid-input');

  const status = stringField(formData, 'status');
  if (status === null) return redirectWithError(onboardingId, 'invalid-input');

  const body: Record<string, unknown> = { status };
  // An explicitly-empty notes field clears the note (null); a missing field
  // leaves it untouched (omitted).
  if (formData.has('notes')) {
    const notes = stringField(formData, 'notes');
    body['notes'] = notes; // string or null
  }

  const validated = UpdateConciergeOnboardingStepRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(onboardingId, 'invalid-input');

  const key = `admin-concierge-onboarding-step-${onboardingId}-${parsedStepKey.data}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/onboardings/${encodeURIComponent(onboardingId)}/steps/${encodeURIComponent(parsedStepKey.data)}`,
    {
      method: 'PATCH',
      body: validated.data,
      headers: { 'idempotency-key': key },
    },
  );
  finish(result, onboardingId);
}

export async function updateOnboardingAction(
  onboardingId: string,
  formData: FormData,
): Promise<void> {
  const body: Record<string, unknown> = {};

  if (formData.has('kickoffScheduledAt')) {
    const local = stringField(formData, 'kickoffScheduledAt');
    if (local === null) {
      body['kickoffScheduledAt'] = null;
    } else {
      const iso = localToIso(local);
      if (iso === null) return redirectWithError(onboardingId, 'invalid-input');
      body['kickoffScheduledAt'] = iso;
    }
  }
  if (formData.has('notes')) {
    body['notes'] = stringField(formData, 'notes'); // string or null (clear)
  }

  if (Object.keys(body).length === 0) return redirectWithError(onboardingId, 'invalid-input');

  const validated = UpdateConciergeOnboardingRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(onboardingId, 'invalid-input');

  const key = `admin-concierge-onboarding-update-${onboardingId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/onboardings/${encodeURIComponent(onboardingId)}`,
    {
      method: 'PATCH',
      body: validated.data,
      headers: { 'idempotency-key': key },
    },
  );
  finish(result, onboardingId);
}

export async function cancelOnboardingAction(onboardingId: string): Promise<void> {
  const key = `admin-concierge-onboarding-cancel-${onboardingId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/onboardings/${encodeURIComponent(onboardingId)}`,
    {
      method: 'PATCH',
      body: { status: 'canceled' },
      headers: { 'idempotency-key': key },
    },
  );
  finish(result, onboardingId);
}

function finish(
  result: Awaited<ReturnType<typeof callGateway<unknown>>>,
  onboardingId: string,
): void {
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(basePath(onboardingId));
    redirect(`${basePath(onboardingId)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(onboardingId, 'conflict');
    if (result.status === 404) return redirectWithError(onboardingId, 'not-found');
    return redirectWithError(onboardingId, 'bad-request');
  }
  return redirectWithError(onboardingId, 'service-warning');
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

function redirectWithError(onboardingId: string, code: ActionErrorCode): never {
  redirect(`${basePath(onboardingId)}?action=err&code=${code}`);
}
