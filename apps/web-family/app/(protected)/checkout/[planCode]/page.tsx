import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { formatUsdMinor, loadPlans } from '@/lib/plans-api';

import { CheckoutForm } from './checkout-form';

export const metadata: Metadata = {
  title: 'Confirm and check out — Taste & See',
};

const MeBodySchema = z.object({
  userId: z.string().min(1),
  mfaVerified: z.boolean(),
});

interface CheckoutPageProps {
  readonly params: Promise<{ readonly planCode: string }>;
}

/**
 * Confirm + Stripe Checkout entry page (TS-124).
 *
 * Server component that:
 *   1. Resolves the planCode from the URL.
 *   2. Calls `GET /api/v1/me` for the customer email / userId. The
 *      portal does NOT yet have a household-svc to look up the
 *      household id; the user's `userId` is used as the soft FK
 *      `customerId` for Phase 1 (a known simplification — followup
 *      TS-124-followup-1 wires household-svc once it lands).
 *   3. Calls `GET /api/v1/plans` for the catalog and finds the plan.
 *   4. Renders a billing-interval picker (monthly / annual) + the
 *      "Continue to secure payment" button bound to the server action
 *      that creates the Stripe Checkout Session and redirects.
 */
export default async function CheckoutPage({
  params,
}: CheckoutPageProps): Promise<React.JSX.Element> {
  const { planCode } = await params;

  const meResult = await callGateway<unknown>('/api/v1/me');
  if (meResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (meResult.kind !== 'ok') {
    return <ServiceWarning />;
  }
  const parsedMe = MeBodySchema.safeParse(meResult.body);
  if (!parsedMe.success) {
    return <ServiceWarning />;
  }
  const me = parsedMe.data;

  const plansResult = await loadPlans();
  if (plansResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (plansResult.kind !== 'ok') {
    return <ServiceWarning />;
  }

  const plan = plansResult.plans.find(
    (candidate) =>
      candidate.code === planCode && candidate.customerGroup === 'family' && candidate.active,
  );
  if (plan === undefined) {
    notFound();
  }

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/plans" className="dash-logout">
          Back to plans
        </Link>
      </header>
      <main className="dash-main">
        <h1>{plan.name}</h1>
        <p>{plan.description ?? 'A starting plan for your family.'}</p>

        <section className="checkout-card" aria-labelledby="billing-interval">
          <h2 id="billing-interval" className="checkout-section-heading">
            Billing rhythm
          </h2>
          <CheckoutForm
            planCode={plan.code}
            planName={plan.name}
            customerId={me.userId}
            monthlyLabel={`${formatUsdMinor(plan.monthlyPriceUsdMinor)} / month`}
            annualLabel={`${formatUsdMinor(plan.annualPriceUsdMinor)} / year`}
          />
        </section>

        <p className="checkout-fineprint">
          You&apos;ll be taken to Stripe&apos;s secure checkout to enter your card. Cancel any time
          from your dashboard — billed monthly or annually, never automatically renewed after a
          cancellation request.
        </p>
      </main>
    </div>
  );
}

function ServiceWarning(): React.JSX.Element {
  return (
    <div className="dash-shell">
      <main className="dash-main">
        <h1>We&apos;re having a moment</h1>
        <p>Our checkout service is briefly unreachable. Please refresh in a few seconds.</p>
        <Link href="/plans" className="link-back">
          Back to plans
        </Link>
      </main>
    </div>
  );
}
