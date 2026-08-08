'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { SubmitConciergeRequestRequestSchema } from '@taste-and-see/contracts';

import { setFlash } from '@/lib/flash';
import { submitConciergeRequest } from '@/lib/concierge-requests-api';

/**
 * Submit a concierge service request (TS-223).
 *
 * Reads the form fields, assembles the contract request body (omitting the
 * optional structured fields when blank), re-validates against the
 * canonical schema (the page boundary is a security boundary), and submits
 * via the gateway with a fresh Idempotency-Key. service-concierge resolves
 * the household from the token and routes the ticket to the household's
 * active dedicated concierge.
 *
 * Outcomes funnel through the one-shot flash channel + a redirect back to
 * the requests page so the protected-layout banner surfaces the result.
 */
export async function submitConciergeRequestAction(formData: FormData): Promise<void> {
  const page = '/concierge/requests';

  const kind = readString(formData, 'kind');
  const subject = readString(formData, 'subject');
  const body = readString(formData, 'body');
  const requestedDate = readString(formData, 'requestedDate');
  const theme = readString(formData, 'theme');
  const partySizeRaw = readString(formData, 'partySize');

  const candidate: Record<string, unknown> = { kind, subject, body };
  if (requestedDate.length > 0) candidate['requestedDate'] = requestedDate;
  if (theme.length > 0) candidate['theme'] = theme;
  if (partySizeRaw.length > 0) candidate['partySize'] = Number.parseInt(partySizeRaw, 10);

  const validated = SubmitConciergeRequestRequestSchema.safeParse(candidate);
  if (!validated.success) {
    await setFlash({ kind: 'error', code: 'concierge_request.invalid' });
    redirect(page);
  }

  const result = await submitConciergeRequest(validated.data, randomUUID());
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'concierge_request.failed' });
    redirect(page);
  }

  await setFlash({ kind: 'success', code: 'concierge_request.submitted' });
  revalidatePath(page);
  redirect(page);
}

function readString(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}
