'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { ImpersonateUserResponseSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { writeImpersonationCookies } from '@/lib/session';

/**
 * Server actions for the admin user detail page
 * (TS-126-followup-1; PRD §10.2; closes TS-025-followup-2).
 *
 * Three actions corresponding to the three POST endpoints on
 * `service-identity` (via the api-gateway proxy):
 *
 *   - `suspendUserAction`   → POST /api/v1/admin/users/:id/suspend
 *   - `reinstateUserAction` → POST /api/v1/admin/users/:id/reinstate
 *   - `unlockUserAction`    → POST /api/v1/admin/users/:id/unlock
 *
 * Each action:
 *   1. Generates a fresh `Idempotency-Key` per submission (UUID v4)
 *      so a server-action retry surfaces as the same key + body and
 *      collapses on the downstream's `@Idempotent()` cache. The key
 *      is short-lived (one form submission); we deliberately do NOT
 *      embed it as a hidden input the user can manipulate.
 *   2. Calls the gateway with the validated payload.
 *   3. Revalidates the detail page so the post-action state renders
 *      immediately.
 *   4. Redirects back to the detail page with a `?ok=...` /
 *      `?err=...` query for the inline banner. (Plain string
 *      redirect avoids needing a client component to surface state
 *      and stays CSP-friendly.)
 */

type ActionOutcome = { readonly kind: 'ok' } | { readonly kind: 'err'; readonly detail: string };

export async function suspendUserAction(userId: string, formData: FormData): Promise<void> {
  const reason = formData.get('reason');
  const note = formData.get('note');
  if (typeof reason !== 'string' || reason.length === 0) {
    return redirectWith(userId, { kind: 'err', detail: 'reason-required' });
  }
  const body: Record<string, string> = { reason };
  if (typeof note === 'string' && note.trim().length > 0) {
    body.note = note.trim();
  }
  const outcome = await postAction(userId, 'suspend', body);
  return redirectWith(userId, outcome);
}

export async function reinstateUserAction(userId: string, formData: FormData): Promise<void> {
  const reason = formData.get('reason');
  const note = formData.get('note');
  if (typeof reason !== 'string' || reason.length === 0) {
    return redirectWith(userId, { kind: 'err', detail: 'reason-required' });
  }
  const body: Record<string, string> = { reason };
  if (typeof note === 'string' && note.trim().length > 0) {
    body.note = note.trim();
  }
  const outcome = await postAction(userId, 'reinstate', body);
  return redirectWith(userId, outcome);
}

export async function unlockUserAction(userId: string, formData: FormData): Promise<void> {
  const note = formData.get('note');
  const body: Record<string, string> = {};
  if (typeof note === 'string' && note.trim().length > 0) {
    body.note = note.trim();
  }
  const outcome = await postAction(userId, 'unlock', body);
  return redirectWith(userId, outcome);
}

/**
 * Start an impersonation session for this user (TS-297; PRD §10.2).
 *
 * On success the impersonation access token + session family id land
 * in web-admin's own HttpOnly cookie pair (`writeImpersonationCookies`)
 * — the operator's admin session cookies are NOT touched, so the
 * console keeps working as the operator while the layout banner
 * renders "Impersonating …" through the impersonated token's `/me`.
 * The raw tokens never reach the browser as readable values and are
 * never logged. Refusals (self / admin-staff target / deactivated)
 * surface through the banner error codes.
 */
export async function impersonateUserAction(userId: string, formData: FormData): Promise<void> {
  const reason = formData.get('reason');
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return redirectWith(userId, { kind: 'err', detail: 'reason-required' });
  }

  const idempotencyKey = `admin-impersonate-${userId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/impersonate`,
    {
      method: 'POST',
      body: { reason: reason.trim() },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    const parsed = ImpersonateUserResponseSchema.safeParse(result.body);
    if (!parsed.success) {
      return redirectWith(userId, { kind: 'err', detail: 'service-warning' });
    }
    const familyMaxAgeSeconds = Math.max(
      60,
      Math.floor((Date.parse(parsed.data.sessionExpiresAt) - Date.now()) / 1000),
    );
    await writeImpersonationCookies({
      accessToken: parsed.data.accessToken,
      accessTokenMaxAgeSeconds: parsed.data.expiresIn,
      sessionFamilyId: parsed.data.sessionFamilyId,
      familyMaxAgeSeconds,
    });
    revalidatePath('/', 'layout');
    return redirectWith(userId, { kind: 'ok' });
  }
  if (result.kind === 'client_error') {
    if (result.status === 403)
      return redirectWith(userId, { kind: 'err', detail: 'impersonation-refused' });
    if (result.status === 404) return redirectWith(userId, { kind: 'err', detail: 'not-found' });
    if (result.status === 409)
      return redirectWith(userId, { kind: 'err', detail: 'illegal-transition' });
    return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
  }
  return redirectWith(userId, { kind: 'err', detail: 'service-warning' });
}

/**
 * Grant a single role assignment from the user detail page (TS-292).
 * The scope pair arrives flat from the form (`scopeType` select +
 * `scopeId` input) and is folded into the contract's discriminated
 * union here; `expiresAt` arrives from a `datetime-local` input and is
 * converted to a UTC ISO instant. Sensitive / archived / duplicate
 * rejections come back from the service as 403 / 409 and surface via
 * the banner.
 */
export async function grantRoleAssignmentAction(userId: string, formData: FormData): Promise<void> {
  const roleName = formData.get('roleName');
  if (typeof roleName !== 'string' || roleName.length === 0) {
    return redirectWith(userId, { kind: 'err', detail: 'reason-required' });
  }
  const scopeType = formData.get('scopeType');
  const scopeIdRaw = formData.get('scopeId');
  const scopeId =
    typeof scopeIdRaw === 'string' && scopeIdRaw.trim().length > 0 ? scopeIdRaw.trim() : null;

  let scope: Record<string, string>;
  if (scopeType === 'global' && scopeId === null) {
    scope = { type: 'global' };
  } else if (scopeType === 'tenant' && scopeId !== null) {
    scope = { type: 'tenant', tenantId: scopeId };
  } else if (scopeType === 'household' && scopeId !== null) {
    scope = { type: 'household', householdId: scopeId };
  } else {
    return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
  }

  const body: Record<string, unknown> = { userId, roleName, scope };

  const expiresRaw = formData.get('expiresAt');
  if (typeof expiresRaw === 'string' && expiresRaw.trim().length > 0) {
    const parsed = new Date(expiresRaw.trim());
    if (Number.isNaN(parsed.getTime())) {
      return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
    }
    body.expiresAt = parsed.toISOString();
  }
  const reason = formData.get('reason');
  if (typeof reason === 'string' && reason.trim().length > 0) {
    body.reason = reason.trim();
  }

  const result = await callGateway<unknown>('/api/v1/admin/role-assignments', {
    method: 'POST',
    body,
    headers: { 'idempotency-key': `admin-role-grant-${userId}-${randomUUID()}` },
  });
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(`/users/${userId}`);
    return redirectWith(userId, { kind: 'ok' });
  }
  if (result.kind === 'client_error') {
    if (result.status === 409)
      return redirectWith(userId, { kind: 'err', detail: 'illegal-transition' });
    if (result.status === 404) return redirectWith(userId, { kind: 'err', detail: 'not-found' });
    return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
  }
  return redirectWith(userId, { kind: 'err', detail: 'service-warning' });
}

/**
 * Request a SENSITIVE-role grant from the user detail page (TS-294).
 * Sensitive roles (super_admin, finance) cannot be granted directly —
 * this action files a pending approval request that a SECOND admin
 * must approve on /roles/approvals. `reason` is required (privilege
 * escalation carries a why).
 */
export async function requestRoleApprovalAction(userId: string, formData: FormData): Promise<void> {
  const roleName = formData.get('roleName');
  if (typeof roleName !== 'string' || roleName.length === 0) {
    return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
  }
  const reason = formData.get('reason');
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return redirectWith(userId, { kind: 'err', detail: 'reason-required' });
  }
  const scopeType = formData.get('scopeType');
  const scopeIdRaw = formData.get('scopeId');
  const scopeId =
    typeof scopeIdRaw === 'string' && scopeIdRaw.trim().length > 0 ? scopeIdRaw.trim() : null;

  let scope: Record<string, string>;
  if (scopeType === 'global' && scopeId === null) {
    scope = { type: 'global' };
  } else if (scopeType === 'tenant' && scopeId !== null) {
    scope = { type: 'tenant', tenantId: scopeId };
  } else if (scopeType === 'household' && scopeId !== null) {
    scope = { type: 'household', householdId: scopeId };
  } else {
    return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
  }

  const body: Record<string, unknown> = { userId, roleName, scope, reason: reason.trim() };
  const expiresRaw = formData.get('expiresAt');
  if (typeof expiresRaw === 'string' && expiresRaw.trim().length > 0) {
    const parsed = new Date(expiresRaw.trim());
    if (Number.isNaN(parsed.getTime())) {
      return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
    }
    body.expiresAt = parsed.toISOString();
  }

  const result = await callGateway<unknown>('/api/v1/admin/role-approvals', {
    method: 'POST',
    body,
    headers: { 'idempotency-key': `admin-role-approval-${userId}-${randomUUID()}` },
  });
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(`/users/${userId}`);
    return redirectWith(userId, { kind: 'ok' });
  }
  if (result.kind === 'client_error') {
    if (result.status === 409)
      return redirectWith(userId, { kind: 'err', detail: 'illegal-transition' });
    if (result.status === 404) return redirectWith(userId, { kind: 'err', detail: 'not-found' });
    return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
  }
  return redirectWith(userId, { kind: 'err', detail: 'service-warning' });
}

/** Revoke one assignment from the user detail page (TS-292). */
export async function revokeRoleAssignmentAction(
  userId: string,
  formData: FormData,
): Promise<void> {
  const assignmentId = formData.get('assignmentId');
  if (typeof assignmentId !== 'string' || assignmentId.length === 0) {
    return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
  }
  const body: Record<string, unknown> = {};
  const reason = formData.get('reason');
  if (typeof reason === 'string' && reason.trim().length > 0) {
    body.reason = reason.trim();
  }

  const result = await callGateway<unknown>(
    `/api/v1/admin/role-assignments/${encodeURIComponent(assignmentId)}/revoke`,
    {
      method: 'POST',
      body,
      headers: { 'idempotency-key': `admin-role-revoke-${assignmentId}-${randomUUID()}` },
    },
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(`/users/${userId}`);
    return redirectWith(userId, { kind: 'ok' });
  }
  if (result.kind === 'client_error') {
    if (result.status === 404) return redirectWith(userId, { kind: 'err', detail: 'not-found' });
    return redirectWith(userId, { kind: 'err', detail: 'bad-request' });
  }
  return redirectWith(userId, { kind: 'err', detail: 'service-warning' });
}

async function postAction(
  userId: string,
  action: 'suspend' | 'reinstate' | 'unlock',
  body: Record<string, unknown>,
): Promise<ActionOutcome> {
  const idempotencyKey = `admin-${action}-${userId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/${action}`,
    {
      method: 'POST',
      body,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    // Invalidate the cached server-rendered detail so the next
    // GET reflects the new state immediately.
    revalidatePath(`/users/${userId}`);
    return { kind: 'ok' };
  }

  // Surface a coarse-grained error code in the banner. Detailed
  // failure messages (e.g. the exact `currentStatus` value from a
  // 409) live in the downstream's problem-details body; the inline
  // banner just signals success / categorical failure. Ops still
  // gets the full picture via the audit-log entry (TS-126-followup-5
  // once wired) and the structured `logger.log` lines today.
  if (result.kind === 'client_error') {
    if (result.status === 409) return { kind: 'err', detail: 'illegal-transition' };
    if (result.status === 404) return { kind: 'err', detail: 'not-found' };
    return { kind: 'err', detail: 'bad-request' };
  }
  return { kind: 'err', detail: 'service-warning' };
}

function redirectWith(userId: string, outcome: ActionOutcome): never {
  const target =
    outcome.kind === 'ok'
      ? `/users/${encodeURIComponent(userId)}?action=ok`
      : `/users/${encodeURIComponent(userId)}?action=err&code=${outcome.detail}`;
  redirect(target);
}
