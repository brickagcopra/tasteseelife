'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  OrgSecurityPolicyResponseSchema,
  OrgSecurityPolicyScopeIdSchema,
  UpsertOrgSecurityPolicyRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server action for the org security-policy surface (TS-296). The
 * upsert re-validates via the contract schemas, mints a fresh
 * `Idempotency-Key` (CLAUDE.md §3.3), and forwards through the
 * gateway BFF — which re-gates `rbac:write` + re-validates, and
 * service-identity enforces both again (defence-in-depth).
 */

const LIST_PATH = '/roles/security-policies';
const GW_POLICIES = '/api/v1/admin/org-security-policies';

export async function upsertPolicyAction(formData: FormData): Promise<void> {
  const rawScopeId = formData.get('scopeId');
  const scopeId = OrgSecurityPolicyScopeIdSchema.safeParse(
    typeof rawScopeId === 'string' ? rawScopeId : '',
  );
  const body = UpsertOrgSecurityPolicyRequestSchema.safeParse({
    ssoRequired: formData.get('ssoRequired') === 'true',
  });
  if (!scopeId.success || !body.success) {
    redirect(`${LIST_PATH}?action=err&code=invalid-input`);
  }

  const result = await callGateway<unknown>(`${GW_POLICIES}/${encodeURIComponent(scopeId.data)}`, {
    method: 'PUT',
    body: body.data,
    headers: { 'idempotency-key': `org-security-policy-upsert-${randomUUID()}` },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    const parsed = OrgSecurityPolicyResponseSchema.safeParse(result.body);
    if (!parsed.success) redirect(`${LIST_PATH}?action=err&code=service-warning`);
    revalidatePath(LIST_PATH);
    redirect(`${LIST_PATH}?action=ok`);
  }
  if (result.kind === 'client_error' && result.status === 403) {
    redirect(`${LIST_PATH}?action=err&code=forbidden`);
  }
  redirect(`${LIST_PATH}?action=err&code=service-warning`);
}
