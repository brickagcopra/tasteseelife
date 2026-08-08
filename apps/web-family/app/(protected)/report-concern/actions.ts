'use server';

import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';

import { ReportConcernRequestSchema } from '@taste-and-see/contracts';

import { setFlash } from '@/lib/flash';
import { reportConcern } from '@/lib/trust-safety-api';

/**
 * File a trust & safety concern (TS-301a).
 *
 * Reads the category + description, re-validates against the canonical
 * schema (the page boundary is a security boundary), and files via the
 * gateway with a fresh Idempotency-Key. service-trust-safety resolves the
 * household from the token and opens a severity-defaulted incident. On
 * success the redirect carries the receipt's reference id so the page
 * renders the confirmation (with "what happens next" copy) — errors funnel
 * through the one-shot flash channel back to the form.
 */
export async function reportConcernAction(formData: FormData): Promise<void> {
  const page = '/report-concern';

  const category = readString(formData, 'category');
  const description = readString(formData, 'description');

  const validated = ReportConcernRequestSchema.safeParse({ category, description });
  if (!validated.success) {
    await setFlash({ kind: 'error', code: 'report_concern.invalid' });
    redirect(page);
  }

  const result = await reportConcern(validated.data, `report-concern-${randomUUID()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'report_concern.failed' });
    redirect(page);
  }

  redirect(`${page}?ref=${encodeURIComponent(result.receipt.incidentId)}`);
}

function readString(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}
