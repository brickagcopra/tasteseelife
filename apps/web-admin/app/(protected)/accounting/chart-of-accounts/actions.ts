'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  ADMIN_ACCOUNTS_ACTIVE_REASONS,
  type AdminAccountActiveReason,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server action for the admin chart-of-accounts retire / activate
 * toggle (TS-129-followup-1; PRD §10.8, CLAUDE.md §6).
 *
 * One action calls `PATCH /api/v1/admin/accounts/:id` via the gateway,
 * with a fresh `Idempotency-Key` per submission so a server-action
 * retry collapses on the downstream's `@Idempotent()` cache. The key
 * is short-lived (one form submission); we deliberately do NOT embed
 * it as a hidden input the user can manipulate.
 *
 * On success the action revalidates the chart-of-accounts browser
 * path so the post-action state renders immediately, then redirects
 * back with a `?ok=...` query for the inline banner.
 */

type ActionOutcome = { readonly kind: 'ok' } | { readonly kind: 'err'; readonly detail: string };

type AccountActiveTarget = 'retire' | 'activate';

export async function setAccountActiveAction(accountId: string, formData: FormData): Promise<void> {
  const target = formData.get('target');
  const reason = formData.get('reason');
  const note = formData.get('note');

  if (target !== 'retire' && target !== 'activate') {
    return redirectWith({ kind: 'err', detail: 'target-invalid' });
  }
  if (typeof reason !== 'string' || !isAdminAccountActiveReason(reason)) {
    return redirectWith({ kind: 'err', detail: 'reason-required' });
  }

  const active = target === 'activate';
  const body: Record<string, unknown> = { active, reason };
  if (typeof note === 'string' && note.trim().length > 0) {
    body['note'] = note.trim();
  }

  const idempotencyKey = `admin-coa-${target}-${accountId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`,
    {
      method: 'PATCH',
      body,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    revalidatePath('/accounting/chart-of-accounts');
    return redirectWith({ kind: 'ok' });
  }

  // Surface a coarse-grained error code in the banner. Detailed
  // failure messages live in the downstream's problem-details body;
  // the inline banner just signals success / categorical failure.
  if (result.kind === 'client_error') {
    if (result.status === 404) {
      return redirectWith({ kind: 'err', detail: 'not-found' });
    }
    return redirectWith({ kind: 'err', detail: 'bad-request' });
  }
  return redirectWith({ kind: 'err', detail: 'service-warning' });
}

function isAdminAccountActiveReason(value: string): value is AdminAccountActiveReason {
  return (ADMIN_ACCOUNTS_ACTIVE_REASONS as readonly string[]).includes(value);
}

function redirectWith(outcome: ActionOutcome): never {
  const target =
    outcome.kind === 'ok'
      ? '/accounting/chart-of-accounts?action=ok'
      : `/accounting/chart-of-accounts?action=err&code=${outcome.detail}`;
  redirect(target);
}

// The type below is exported so the page can type its form's `target`
// field without re-deriving the union locally. Kept in this file (not
// `page.tsx`) so adding new action variants here also surfaces them
// to consumers without a cross-file refactor.
export type { AccountActiveTarget };
