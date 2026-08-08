'use server';

import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';

import { VerifyEmailRequestSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Spend an email-verification token (TS-510-followup-2).
 *
 * **The only place a token is spent, and it is a POST reached by a human
 * pressing a button.** The emailed link is a GET that changes nothing —
 * see the page's doc-comment for why that separation exists.
 *
 * Outcomes travel back on the query string rather than through the flash
 * cookie: this route is public, a person arriving from their mail client
 * has no session for a flash to ride on, and the outcome must survive a
 * refresh of the result page.
 */
export async function verifyEmailAction(formData: FormData): Promise<void> {
  const raw = formData.get('token');
  const token = typeof raw === 'string' ? raw.trim() : '';

  const validated = VerifyEmailRequestSchema.safeParse({ token });
  if (!validated.success) {
    redirect('/verify-email?state=invalid');
  }

  const result = await callGateway<unknown>('/api/v1/auth/verify-email', {
    method: 'POST',
    body: validated.data,
    // A fresh key per press. The token itself is the real single-use
    // guard; this only makes a double-submit of the SAME press replay
    // rather than race, and service-identity owns that cache (the gateway
    // deliberately does not keep a second one).
    headers: { 'idempotency-key': randomUUID() },
  });

  if (result.kind === 'ok') {
    redirect('/verify-email?state=verified');
  }

  // Every 4xx collapses to one outcome. A spent token, an unknown token
  // and an expired one are already indistinguishable downstream by
  // design (TS-510) — and to the person holding a link that did not
  // work, the useful next step is identical in all three cases.
  if (result.kind === 'client_error') {
    redirect('/verify-email?state=failed');
  }

  redirect('/verify-email?state=unavailable');
}
