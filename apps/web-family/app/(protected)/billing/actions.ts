'use server';

import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';

import { setFlash } from '@/lib/flash';
import { createBillingPortalSession } from '@/lib/billing-portal-api';

/**
 * Open the Stripe Billing Portal (TS-042-followup-3a3-followup-1).
 *
 * Mints a session through the gateway and redirects the browser straight
 * to Stripe. The URL is single-use and short-lived, which is why this is
 * a server action ending in a redirect rather than a link rendered into
 * the page: a portal URL sitting in an anchor is a credential sitting in
 * the HTML, and it would be spent by the time anyone clicked it twice.
 *
 * Sends no payload. The Stripe customer is resolved downstream from the
 * caller's household scope; there is nothing here to pass and nothing a
 * tampered form could add.
 */
export async function openBillingPortalAction(): Promise<void> {
  const page = '/billing';

  const result = await createBillingPortalSession(randomUUID());

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'no_plan') {
    await setFlash({ kind: 'error', code: 'billing_portal.no_plan' });
    redirect(page);
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'billing_portal.failed' });
    redirect(page);
  }

  // An external redirect: `next/navigation`'s `redirect` handles an
  // absolute URL by issuing it as-is. The value came from Stripe via a
  // schema that requires a URL, and it is never persisted anywhere.
  redirect(result.url);
}
