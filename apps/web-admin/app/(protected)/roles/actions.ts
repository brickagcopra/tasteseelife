'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  AdminRoleResponseSchema,
  ArchiveAdminRoleRequestSchema,
  CreateAdminRoleRequestSchema,
  UpdateAdminRoleRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

import { readMatrixSelection } from './permission-matrix';

/**
 * Server actions for the RBAC role builder (TS-290; PRD §10.12).
 *
 * Each action re-validates via the contract schema, mints a fresh
 * `Idempotency-Key` (CLAUDE.md §3.3), and forwards through the
 * gateway BFF — which re-gates `rbac:write` + re-validates, and
 * service-identity enforces both again (defence-in-depth). System
 * roles are rejected server-side with 409; the UI additionally
 * renders them read-only.
 *
 * TS-291: `updateRoleAction` is only reached from the review step
 * (`[roleId]/review`), whose "Apply changes" form posts the pending
 * set as hidden fields after showing the before/after diff. The
 * editor form itself GETs to the review page instead of posting here.
 */

const LIST_PATH = '/roles';
const GW_ROLES = '/api/v1/admin/roles';

export async function createRoleAction(formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {
    name: stringField(formData, 'name'),
    permissions: readMatrixSelection(formData),
    ...(stringField(formData, 'description') !== null && {
      description: stringField(formData, 'description'),
    }),
  };

  const validated = CreateAdminRoleRequestSchema.safeParse(body);
  if (!validated.success) redirect(`${LIST_PATH}/new?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(GW_ROLES, {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': `admin-role-create-${randomUUID()}` },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    const parsed = AdminRoleResponseSchema.safeParse(result.body);
    if (!parsed.success) redirect(`${LIST_PATH}/new?action=err&code=service-warning`);
    revalidatePath(LIST_PATH);
    redirect(`${LIST_PATH}/${encodeURIComponent(parsed.data.role.id)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) redirect(`${LIST_PATH}/new?action=err&code=conflict`);
    redirect(`${LIST_PATH}/new?action=err&code=bad-request`);
  }
  redirect(`${LIST_PATH}/new?action=err&code=service-warning`);
}

export async function updateRoleAction(formData: FormData): Promise<void> {
  const roleId = stringField(formData, 'roleId');
  if (roleId === null) redirect(`${LIST_PATH}?action=err&code=invalid-input`);
  const editorPath = `${LIST_PATH}/${encodeURIComponent(roleId)}`;

  // Description semantics: blank input clears (explicit null), so an
  // operator can empty the field without a separate "clear" control.
  // A blank name is omitted (name is not clearable — roles always
  // have one), letting the rest of the patch proceed.
  const name = stringField(formData, 'name');
  const body: Record<string, unknown> = {
    ...(name !== null && { name }),
    description: stringField(formData, 'description'),
    permissions: readMatrixSelection(formData),
  };

  const validated = UpdateAdminRoleRequestSchema.safeParse(body);
  if (!validated.success) redirect(`${editorPath}?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(`${GW_ROLES}/${encodeURIComponent(roleId)}`, {
    method: 'PATCH',
    body: validated.data,
    headers: { 'idempotency-key': `admin-role-update-${randomUUID()}` },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(LIST_PATH);
    revalidatePath(editorPath);
    redirect(`${editorPath}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) redirect(`${editorPath}?action=err&code=conflict`);
    if (result.status === 404) redirect(`${LIST_PATH}?action=err&code=not-found`);
    redirect(`${editorPath}?action=err&code=bad-request`);
  }
  redirect(`${editorPath}?action=err&code=service-warning`);
}

export async function archiveRoleAction(formData: FormData): Promise<void> {
  const roleId = stringField(formData, 'roleId');
  if (roleId === null) redirect(`${LIST_PATH}?action=err&code=invalid-input`);
  const editorPath = `${LIST_PATH}/${encodeURIComponent(roleId)}`;

  // Server-rendered confirm: the archive form requires the explicit
  // checkbox — no client JS confirm dialog.
  if (formData.get('confirmArchive') !== 'on') {
    redirect(`${editorPath}?action=err&code=confirm-required`);
  }

  const note = stringField(formData, 'note');
  const body: Record<string, unknown> = {
    ...(note !== null && { note }),
  };

  const validated = ArchiveAdminRoleRequestSchema.safeParse(body);
  if (!validated.success) redirect(`${editorPath}?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(`${GW_ROLES}/${encodeURIComponent(roleId)}/archive`, {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': `admin-role-archive-${randomUUID()}` },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(LIST_PATH);
    revalidatePath(editorPath);
    redirect(`${editorPath}?action=archived`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) redirect(`${editorPath}?action=err&code=conflict`);
    if (result.status === 404) redirect(`${LIST_PATH}?action=err&code=not-found`);
    redirect(`${editorPath}?action=err&code=bad-request`);
  }
  redirect(`${editorPath}?action=err&code=service-warning`);
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}
