'use server';

import { createHash, randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  AdminReportConcernRequestSchema,
  CreateConciergeAssignmentRequestSchema,
  type AdminReportConcernRequest,
  type CreateConciergeAssignmentRequest,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the admin concierge-assignments surface (TS-222;
 * PRD §5.1 Tier 3, §6.6; PDD §10.6).
 *
 *   - `createConciergeAssignmentAction(formData)` — the "assign / replace"
 *     form submits here. Reads the household + primary (+ optional backup)
 *     fields, re-validates via the contract schema as defence-in-depth,
 *     then POSTs through the gateway BFF. Replacing an existing assignment
 *     is the same call — the service ends the prior active row.
 *
 *   - `endConciergeAssignmentAction(householdId, assignmentId)` — bound to
 *     the per-row "End assignment" button. DELETEs through the gateway; the
 *     downstream is idempotent (an already-ended row returns
 *     `already_ended`).
 *
 * Every mutation generates a fresh `Idempotency-Key` per submission
 * (CLAUDE.md §3.3). On success the action revalidates + redirects back to
 * the same household view with `?action=ok` for the inline banner.
 */

const PAGE_PATH = '/concierge/assignments';

type ActionErrorCode =
  | 'household-required'
  | 'primary-required'
  | 'backup-incomplete'
  | 'backup-equals-primary'
  | 'bad-request'
  | 'conflict'
  | 'not-found'
  | 'concern-incomplete'
  | 'concern-duplicate'
  | 'concern-forbidden'
  | 'service-warning';

export async function createConciergeAssignmentAction(formData: FormData): Promise<void> {
  const householdId = stringField(formData, 'householdId');
  if (householdId === null) {
    return redirectWithError(null, 'household-required');
  }

  const primaryConciergeUserId = stringField(formData, 'primaryConciergeUserId');
  const primaryConciergeDisplayName = stringField(formData, 'primaryConciergeDisplayName');
  if (primaryConciergeUserId === null || primaryConciergeDisplayName === null) {
    return redirectWithError(householdId, 'primary-required');
  }

  const backupConciergeUserId = stringField(formData, 'backupConciergeUserId');
  const backupConciergeDisplayName = stringField(formData, 'backupConciergeDisplayName');
  // Both-or-neither at the form layer — surface a friendly message rather
  // than bouncing off the contract superRefine.
  if ((backupConciergeUserId === null) !== (backupConciergeDisplayName === null)) {
    return redirectWithError(householdId, 'backup-incomplete');
  }
  if (backupConciergeUserId !== null && backupConciergeUserId === primaryConciergeUserId) {
    return redirectWithError(householdId, 'backup-equals-primary');
  }

  const body: Record<string, unknown> = {
    householdId,
    primaryConciergeUserId,
    primaryConciergeDisplayName,
  };
  if (backupConciergeUserId !== null && backupConciergeDisplayName !== null) {
    body['backupConciergeUserId'] = backupConciergeUserId;
    body['backupConciergeDisplayName'] = backupConciergeDisplayName;
  }

  const validated = CreateConciergeAssignmentRequestSchema.safeParse(body);
  if (!validated.success) {
    return redirectWithError(householdId, 'bad-request');
  }

  const idempotencyKey = `admin-concierge-assign-${householdId}-${randomUUID()}`;
  const result = await callGateway<unknown>('/api/v1/admin/concierge/assignments', {
    method: 'POST',
    body: validated.data satisfies CreateConciergeAssignmentRequest,
    headers: { 'idempotency-key': idempotencyKey },
  });

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    revalidatePath(PAGE_PATH);
    return redirectWithSuccess(householdId);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(householdId, 'conflict');
    return redirectWithError(householdId, 'bad-request');
  }
  return redirectWithError(householdId, 'service-warning');
}

export async function endConciergeAssignmentAction(
  householdId: string,
  assignmentId: string,
): Promise<void> {
  if (assignmentId.length === 0) {
    return redirectWithError(householdId, 'bad-request');
  }
  const idempotencyKey = `admin-concierge-end-${assignmentId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/assignments/${encodeURIComponent(assignmentId)}`,
    {
      method: 'DELETE',
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    revalidatePath(PAGE_PATH);
    return redirectWithSuccess(householdId);
  }
  if (result.kind === 'client_error') {
    if (result.status === 404) return redirectWithError(householdId, 'not-found');
    return redirectWithError(householdId, 'bad-request');
  }
  return redirectWithError(householdId, 'service-warning');
}

/**
 * File a trust & safety concern ON BEHALF OF a household (TS-301b).
 *
 * This is the one path in the platform where a household id is supplied in
 * the request body rather than derived from the caller's token scope — the
 * concierge is not a member of the household they are filing for. That makes
 * it an authorisation decision, so it goes to its own `concierge:write`-gated
 * route (`POST /api/v1/admin/trust-safety/incidents`) rather than the
 * filer-facing one, and service-trust-safety re-checks the permission.
 *
 * **Semantic idempotency key.** Unlike the sibling actions here (which mint a
 * fresh uuid per submit), the key is derived from the content:
 *
 *     admin-ts-concern:{householdId}:{sha256(category|seniorId|description)}
 *
 * The reason is the failure mode it protects against. A concierge is usually
 * filing while on the phone; a double-submit or a browser retry must not open
 * two incidents for one call. A random key can't collapse those — it makes
 * every retry a new incident. Hashing the content means the same report
 * submitted twice collapses onto one incident, while a genuinely different
 * report for the same household still gets its own (the idempotency store
 * 409s on same-key/different-body, so the body must be in the key).
 *
 * The trade-off, deliberately accepted: two byte-identical reports for the
 * same household are treated as one. For a duplicate phone call about the
 * same incident that is the desired behaviour; if a concierge genuinely needs
 * to file the same text twice, the 409 surfaces as `concern-duplicate` rather
 * than silently doing nothing.
 */
export async function reportConcernOnBehalfAction(formData: FormData): Promise<void> {
  const householdId = stringField(formData, 'householdId');
  if (householdId === null) {
    return redirectWithError(null, 'household-required');
  }

  const category = stringField(formData, 'category');
  const description = stringField(formData, 'description');
  const seniorId = stringField(formData, 'seniorId');

  const validated = AdminReportConcernRequestSchema.safeParse({
    householdId,
    category,
    description,
    ...(seniorId !== null && { seniorId }),
  });
  if (!validated.success) {
    return redirectWithError(householdId, 'concern-incomplete');
  }

  const result = await callGateway<unknown>('/api/v1/admin/trust-safety/incidents', {
    method: 'POST',
    body: validated.data satisfies AdminReportConcernRequest,
    headers: { 'idempotency-key': concernIdempotencyKey(validated.data) },
  });

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    revalidatePath(PAGE_PATH);
    return redirectWithSuccess(householdId);
  }
  if (result.kind === 'client_error') {
    if (result.status === 403) return redirectWithError(householdId, 'concern-forbidden');
    if (result.status === 409) return redirectWithError(householdId, 'concern-duplicate');
    return redirectWithError(householdId, 'bad-request');
  }
  return redirectWithError(householdId, 'service-warning');
}

/** See `reportConcernOnBehalfAction` for why this is content-derived. */
function concernIdempotencyKey(request: AdminReportConcernRequest): string {
  const digest = createHash('sha256')
    .update([request.category, request.seniorId ?? '', request.description].join('|'), 'utf8')
    .digest('hex');
  return `admin-ts-concern:${request.householdId}:${digest}`;
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function householdQuery(householdId: string | null): string {
  return householdId === null ? '' : `&householdId=${encodeURIComponent(householdId)}`;
}

function redirectWithSuccess(householdId: string): never {
  redirect(`${PAGE_PATH}?action=ok${householdQuery(householdId)}`);
}

function redirectWithError(householdId: string | null, code: ActionErrorCode): never {
  redirect(`${PAGE_PATH}?action=err&code=${code}${householdQuery(householdId)}`);
}
