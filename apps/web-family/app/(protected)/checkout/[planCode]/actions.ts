'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { loadEnv } from '@/lib/env';
import { loadPlans } from '@/lib/plans-api';

/**
 * Server action backing the family-portal checkout form (TS-124).
 *
 * The action:
 *   1. Validates the form payload (planCode, customerId, email, billingInterval).
 *   2. Looks up the plan in the catalog to make sure it still exists +
 *      grab the customerGroup the gateway expects.
 *   3. Calls `POST /api/v1/subscriptions/checkout-sessions` via the BFF
 *      and redirects the browser to Stripe's hosted URL on success.
 *
 * The action NEVER renders the Stripe URL into HTML — it issues a
 * server-side `redirect()` so the URL never lands in browser history.
 *
 * Email source. The form re-asks for the email today because the
 * gateway's `/me` endpoint is derived from the JWT and does not carry
 * the user's email (TS-124-followup-2 names the upgrade — adding the
 * email to the access-token claims so `/me` can surface it without a
 * downstream DB read). Stripe needs the email to create the Customer
 * record on first checkout.
 *
 * Failure surfaces:
 *   - `validation_failed` — form payload is malformed (a stale tab or
 *                           a tampered field).
 *   - `plan_unavailable`  — the catalog no longer has the plan.
 *   - `service_error`     — gateway / Stripe unreachable. Surface a
 *                           generic recoverable banner.
 */

export interface CheckoutActionState {
  readonly status: 'idle' | 'error';
  readonly message?: string;
}

export const INITIAL_CHECKOUT_STATE: CheckoutActionState = { status: 'idle' };

const FormSchema = z.object({
  planCode: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  customerEmail: z.string().email().max(254),
  billingInterval: z.enum(['monthly', 'annual']),
});

const CreateCheckoutResponseSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  expiresAt: z.string().datetime(),
  status: z.enum(['open', 'complete', 'expired']),
});

export async function checkoutAction(
  _prev: CheckoutActionState,
  formData: FormData,
): Promise<CheckoutActionState> {
  const rawPlan = formData.get('planCode');
  const rawCustomer = formData.get('customerId');
  const rawEmail = formData.get('customerEmail');
  const rawInterval = formData.get('billingInterval');

  const parsedForm = FormSchema.safeParse({
    planCode: typeof rawPlan === 'string' ? rawPlan : '',
    customerId: typeof rawCustomer === 'string' ? rawCustomer : '',
    customerEmail: typeof rawEmail === 'string' ? rawEmail : '',
    billingInterval: typeof rawInterval === 'string' ? rawInterval : 'monthly',
  });
  if (!parsedForm.success) {
    return { status: 'error', message: 'The checkout form is incomplete — please try again.' };
  }

  const plansResult = await loadPlans();
  if (plansResult.kind !== 'ok') {
    return {
      status: 'error',
      message:
        plansResult.kind === 'unauthorized'
          ? 'Your session expired. Please sign in again.'
          : 'Our catalog is briefly unreachable. Try again in a moment.',
    };
  }
  const plan = plansResult.plans.find(
    (candidate) =>
      candidate.code === parsedForm.data.planCode &&
      candidate.customerGroup === 'family' &&
      candidate.active,
  );
  if (plan === undefined) {
    return {
      status: 'error',
      message: 'That plan is no longer available. Please choose another.',
    };
  }

  const env = loadEnv();
  const successUrl = `${env.PORTAL_BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${env.PORTAL_BASE_URL}/checkout/cancel?plan=${encodeURIComponent(plan.code)}`;

  const createResult = await callGateway<unknown>('/api/v1/subscriptions/checkout-sessions', {
    method: 'POST',
    body: {
      planId: plan.id,
      customerId: parsedForm.data.customerId,
      customerGroup: 'family' as const,
      customerEmail: parsedForm.data.customerEmail,
      billingInterval: parsedForm.data.billingInterval,
      successUrl,
      cancelUrl,
    },
  });
  if (createResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (createResult.kind !== 'ok') {
    return {
      status: 'error',
      message: 'We could not open the secure checkout. Please try again in a moment.',
    };
  }
  const parsedResponse = CreateCheckoutResponseSchema.safeParse(createResult.body);
  if (!parsedResponse.success) {
    return {
      status: 'error',
      message: 'The checkout response was malformed. Our team has been notified.',
    };
  }

  redirect(parsedResponse.data.url);
}
