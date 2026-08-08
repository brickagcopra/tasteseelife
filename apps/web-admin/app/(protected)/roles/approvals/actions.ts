'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the sensitive-role approvals queue (TS-294).
 *
 *   - `approveRoleApprovalAction` → POST /api/v1/admin/role-approvals/:id/approve
 *   - `rejectRoleApprovalAction`  → POST /api/v1/admin/role-approvals/:id/reject
 *
 * Filing a request lives on the user detail page
 * (`requestRoleApprovalAction`). Both decisions take an optional note
 * that lands on the row as `decisionNote` + the audit trail. The
 * server re-enforces every invariant the UI hints at (second-admin,
 * super_admin approver) — these actions just relay outcomes into the
 * `?action=` banner. Fresh Idempotency-Key per submission, same as the
 * sibling admin actions.
 */

export async function approveRoleApprovalAction(formData: FormData): Promise<void> {
  return decide('approve', formData);
}

export async function rejectRoleApprovalAction(formData: FormData): Promise<void> {
  return decide('reject', formData);
}

async function decide(action: 'approve' | 'reject', formData: FormData): Promise<void> {
  const approvalId = formData.get('approvalId');
  if (typeof approvalId !== 'string' || approvalId.length === 0) {
    return redirectWith({ kind: 'err', code: 'bad-request' });
  }
  const body: Record<string, string> = {};
  const note = formData.get('note');
  if (typeof note === 'string' && note.trim().length > 0) {
    body.note = note.trim();
  }

  const result = await callGateway<unknown>(
    `/api/v1/admin/role-approvals/${encodeURIComponent(approvalId)}/${action}`,
    {
      method: 'POST',
      body,
      headers: { 'idempotency-key': `admin-role-approval-${action}-${approvalId}-${randomUUID()}` },
    },
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath('/roles/approvals');
    return redirectWith({ kind: 'ok' });
  }
  if (result.kind === 'client_error') {
    if (result.status === 403) return redirectWith({ kind: 'err', code: 'forbidden' });
    if (result.status === 409) return redirectWith({ kind: 'err', code: 'conflict' });
    if (result.status === 404) return redirectWith({ kind: 'err', code: 'not-found' });
    return redirectWith({ kind: 'err', code: 'bad-request' });
  }
  return redirectWith({ kind: 'err', code: 'service-warning' });
}

type Outcome = { readonly kind: 'ok' } | { readonly kind: 'err'; readonly code: string };

function redirectWith(outcome: Outcome): never {
  const target =
    outcome.kind === 'ok'
      ? '/roles/approvals?action=ok'
      : `/roles/approvals?action=err&code=${outcome.code}`;
  redirect(target);
}
