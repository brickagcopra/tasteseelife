'use server';

import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';

import { ReportConcernRequestSchema } from '@taste-and-see/contracts';

import { reportConcern } from '@/lib/trust-safety-api';

const PAGE_PATH = '/report-concern';

/** Error codes surfaced back to the page via `?action=err&code=`. */
export type ReportConcernErrorCode = 'invalid' | 'failed';

/**
 * File a trust & safety concern as a provider (TS-301b).
 *
 * Reads the category + description, re-validates against the canonical
 * schema (the page boundary is a security boundary), and files via the same
 * gateway proxy the family portal uses, with a fresh Idempotency-Key.
 * service-trust-safety derives `source: 'provider'` and the reporter id from
 * the token — this action sends no identity of any kind.
 *
 * On success the redirect carries the receipt's reference id so the page
 * renders the confirmation. Errors funnel back through `?action=err&code=`
 * — the provider portal's convention (it has no flash channel, unlike
 * web-family).
 */
export async function reportConcernAction(formData: FormData): Promise<void> {
  const category = readString(formData, 'category');
  const description = readString(formData, 'description');

  const validated = ReportConcernRequestSchema.safeParse({ category, description });
  if (!validated.success) {
    redirectWithError('invalid');
  }

  const result = await reportConcern(validated.data, `report-concern-${randomUUID()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    redirectWithError('failed');
  }

  redirect(`${PAGE_PATH}?ref=${encodeURIComponent(result.receipt.incidentId)}`);
}

function redirectWithError(code: ReportConcernErrorCode): never {
  redirect(`${PAGE_PATH}?action=err&code=${code}`);
}

function readString(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}
