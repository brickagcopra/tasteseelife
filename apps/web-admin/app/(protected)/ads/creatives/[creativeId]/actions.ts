'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  AdCreativeReviewActionSchema,
  ReviewAdCreativeRequestSchema,
  UpdateAdCreativeAccessibilityRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the ad-creative review-detail surface (TS-277b; PRD §10.9;
 * PDD §18.3).
 *
 *   - `updateAccessibilityAction` — edit the creative's declared accessibility
 *     metadata (alt text / colours / motion / disclosure). The author's
 *     `ads:write` affordance.
 *   - `reviewCreativeAction`      — approve / reject / request-changes. The
 *     reviewer's `marketing:approve_creative` decision. A note is required to
 *     reject / request-changes; approving a creative whose accessibility report
 *     fails requires the `acknowledgeAccessibilityFailures` override (the service
 *     enforces both — these are re-validated here for defence-in-depth).
 *
 * Each re-validates via the contract schema, mints a fresh `Idempotency-Key`
 * (CLAUDE.md §3.3), forwards through the gateway BFF (which re-gates +
 * re-validates), then revalidates + redirects back to the detail page with
 * `?action=ok` (or `?action=err&code=…`).
 */

const LIST_PATH = '/ads/creatives';
const GW_CREATIVES = '/api/v1/admin/ads/creatives';

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

function detailPath(creativeId: string): string {
  return `${LIST_PATH}/${encodeURIComponent(creativeId)}`;
}

export async function updateAccessibilityAction(
  creativeId: string,
  formData: FormData,
): Promise<void> {
  // Nullable scalars clear on an empty field; the two booleans are always present
  // (an unchecked box is absent → false), so the ≥1-field requirement always holds.
  const body: Record<string, unknown> = {
    altText: stringField(formData, 'altText'),
    textColor: stringField(formData, 'textColor'),
    backgroundColor: stringField(formData, 'backgroundColor'),
    motionSafe: formData.has('motionSafe'),
    disclosureAcknowledged: formData.has('disclosureAcknowledged'),
  };

  const validated = UpdateAdCreativeAccessibilityRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(creativeId, 'invalid-input');

  const result = await send(
    `${GW_CREATIVES}/${encodeURIComponent(creativeId)}/accessibility`,
    'PATCH',
    validated.data,
    'creative-accessibility',
    creativeId,
  );
  finish(result, creativeId);
}

export async function reviewCreativeAction(creativeId: string, formData: FormData): Promise<void> {
  const action = AdCreativeReviewActionSchema.safeParse(stringField(formData, 'action'));
  if (!action.success) return redirectWithError(creativeId, 'invalid-input');

  const notes = stringField(formData, 'notes');
  const body: Record<string, unknown> = {
    action: action.data,
    acknowledgeAccessibilityFailures: formData.has('acknowledgeAccessibilityFailures'),
    ...(notes !== null && { notes }),
  };

  const validated = ReviewAdCreativeRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(creativeId, 'invalid-input');

  const result = await send(
    `${GW_CREATIVES}/${encodeURIComponent(creativeId)}/review`,
    'POST',
    validated.data,
    'creative-review',
    creativeId,
  );
  finish(result, creativeId);
}

// ─── Shared plumbing ────────────────────────────────────────────────────────

async function send(
  path: string,
  method: 'PATCH' | 'POST',
  body: unknown,
  surface: string,
  creativeId: string,
): Promise<Awaited<ReturnType<typeof callGateway<unknown>>>> {
  const key = `admin-ads-${surface}-${creativeId}-${randomUUID()}`;
  return callGateway<unknown>(path, {
    method,
    body,
    headers: { 'idempotency-key': key },
  });
}

function finish(
  result: Awaited<ReturnType<typeof callGateway<unknown>>>,
  creativeId: string,
): void {
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(detailPath(creativeId));
    redirect(`${detailPath(creativeId)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(creativeId, 'conflict');
    if (result.status === 404) return redirectWithError(creativeId, 'not-found');
    return redirectWithError(creativeId, 'bad-request');
  }
  return redirectWithError(creativeId, 'service-warning');
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function redirectWithError(creativeId: string, code: ActionErrorCode): never {
  redirect(`${detailPath(creativeId)}?action=err&code=${code}`);
}
