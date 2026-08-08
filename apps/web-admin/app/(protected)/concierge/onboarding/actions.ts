'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { CreateConciergeOnboardingRequestSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server action for the Tier-3 onboarding LIST surface (TS-228) — opening a
 * new kickoff checklist for a household.
 *
 * Re-validates the payload via the contract schema (defence-in-depth), mints a
 * fresh `Idempotency-Key` (CLAUDE.md §3.3), forwards through the gateway BFF
 * (which gates on `concierge:write` + re-validates), then redirects to the new
 * onboarding's detail page on success — or back to the list with
 * `?action=err&code=…` for the inline banner.
 */

const LIST_PATH = '/concierge/onboarding';

type ActionErrorCode = 'invalid-input' | 'conflict' | 'bad-request' | 'service-warning';

export async function createOnboardingAction(formData: FormData): Promise<void> {
  const householdId = stringField(formData, 'householdId');
  if (householdId === null) return redirectWithError('invalid-input');

  const body: Record<string, unknown> = { householdId };
  const kickoffLocal = stringField(formData, 'kickoffScheduledAt');
  if (kickoffLocal !== null) {
    const iso = localToIso(kickoffLocal);
    if (iso === null) return redirectWithError('invalid-input');
    body['kickoffScheduledAt'] = iso;
  }
  const notes = stringField(formData, 'notes');
  if (notes !== null) body['notes'] = notes;

  const validated = CreateConciergeOnboardingRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError('invalid-input');

  const idempotencyKey = `admin-concierge-onboarding-create-${randomUUID()}`;
  const result = await callGateway<{ onboarding?: { id?: string } }>(
    '/api/v1/admin/concierge/onboardings',
    {
      method: 'POST',
      body: validated.data,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(LIST_PATH);
    const id = result.body?.onboarding?.id;
    if (typeof id === 'string' && id.length > 0) {
      redirect(`${LIST_PATH}/${encodeURIComponent(id)}?action=ok`);
    }
    redirect(`${LIST_PATH}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError('conflict');
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

/** datetime-local (`YYYY-MM-DDTHH:MM(:SS)?`) → ISO UTC string. */
function localToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(local);
  if (m === null) return null;
  return `${m[1]}${m[2] ?? ':00'}Z`;
}

function redirectWithError(code: ActionErrorCode): never {
  redirect(`${LIST_PATH}?action=err&code=${code}`);
}
