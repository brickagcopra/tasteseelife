import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { formatUsdMinor } from '@/lib/plans-api';

export const metadata: Metadata = {
  title: 'You’re in — Taste & See',
  robots: { index: false, follow: false },
};

interface SuccessPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SubscriptionResponseSchema = z.object({
  id: z.string().min(1),
  planCode: z.string().min(1),
  planId: z.string().min(1),
  billingInterval: z.enum(['monthly', 'annual']),
  unitPriceUsdMinor: z.number().int().min(0),
  currency: z.literal('USD'),
  currentPeriodStart: z.string().datetime(),
  currentPeriodEnd: z.string().datetime(),
  status: z.string().min(1),
});

const SessionResponseSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['open', 'complete', 'expired']),
  stripeSubscriptionId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  customerEmail: z.string().email().nullable(),
});

/**
 * Stripe Checkout success-landing page (TS-124).
 *
 * Stripe redirects the browser here with `?session_id={CHECKOUT_SESSION_ID}`
 * after a successful payment. The page:
 *
 *   1. Reads the session id from the query string.
 *   2. Calls `POST /api/v1/subscriptions/checkout-sessions/:id/finalize`
 *      to promote the session into a local subscription row. The
 *      endpoint is idempotent on the underlying Stripe subscription id,
 *      so a refresh / Back-then-forward replays cleanly.
 *   3. Renders confirmation with the plan name + first billing period.
 *
 * If the session is still `open` (the rare case where Stripe redirected
 * before the payment cleared in our view), the page falls back to a
 * "we're confirming your payment" message + a link to retry. A 422
 * `session_not_complete` from finalize lands here.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: SuccessPageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const rawSessionId = params.session_id;
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  if (sessionId.length === 0) {
    return <MissingSession />;
  }

  // Try to finalize. The endpoint is idempotent on the Stripe
  // subscription id, so a Back+forward returns the existing row.
  const finalizeResult = await callGateway<unknown>(
    `/api/v1/subscriptions/checkout-sessions/${encodeURIComponent(sessionId)}/finalize`,
    { method: 'POST', body: {} },
  );

  if (finalizeResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  if (finalizeResult.kind === 'ok') {
    const parsedSub = SubscriptionResponseSchema.safeParse(finalizeResult.body);
    if (parsedSub.success) {
      return <Confirmed subscription={parsedSub.data} />;
    }
  }

  // Fallback path: payment likely still settling — read the session
  // status to give the user a faithful in-flight message.
  const getResult = await callGateway<unknown>(
    `/api/v1/subscriptions/checkout-sessions/${encodeURIComponent(sessionId)}`,
  );
  if (getResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (getResult.kind === 'ok') {
    const parsedSession = SessionResponseSchema.safeParse(getResult.body);
    if (parsedSession.success) {
      return <Pending sessionStatus={parsedSession.data.status} />;
    }
  }

  return <ServiceWarning />;
}

function Confirmed({
  subscription,
}: {
  readonly subscription: z.infer<typeof SubscriptionResponseSchema>;
}): React.JSX.Element {
  const intervalLabel = subscription.billingInterval === 'monthly' ? 'month' : 'year';
  const priceLabel = `${formatUsdMinor(subscription.unitPriceUsdMinor)} / ${intervalLabel}`;
  const nextPeriod = new Date(subscription.currentPeriodEnd).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Your dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>Your table is set.</h1>
        <p>
          Thank you. You&apos;re on the <strong>{subscription.planCode}</strong> plan, billed{' '}
          {priceLabel}. Your next billing date is <strong>{nextPeriod}</strong>.
        </p>
        <p>
          Stripe sent your receipt to your inbox — we&apos;ll also keep every invoice on your{' '}
          <Link
            href={`/billing/invoices?subscriptionId=${subscription.id}`}
            className="link-inline"
          >
            billing page
          </Link>{' '}
          so you can find them later.
        </p>
        <Link href="/dashboard" className="cta">
          Open your dashboard
        </Link>
      </main>
    </div>
  );
}

function Pending({
  sessionStatus,
}: {
  readonly sessionStatus: 'open' | 'complete' | 'expired';
}): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Your dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>Confirming your payment</h1>
        {sessionStatus === 'expired' ? (
          <p>
            That checkout session expired before payment cleared. Please{' '}
            <Link href="/plans" className="link-inline">
              start a new checkout
            </Link>{' '}
            and we&apos;ll be right with you.
          </p>
        ) : (
          <p>
            Stripe is still finalizing your payment on their side. Refresh this page in a few
            seconds — you&apos;ll see your plan confirmation as soon as it clears.
          </p>
        )}
      </main>
    </div>
  );
}

function MissingSession(): React.JSX.Element {
  return (
    <div className="dash-shell">
      <main className="dash-main">
        <h1>Missing session</h1>
        <p>
          We didn&apos;t see a checkout session in the URL. If you reached this page by mistake,
          head back to{' '}
          <Link href="/plans" className="link-inline">
            plans
          </Link>
          .
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
        <p>
          Stripe confirmed your payment, but our service is briefly slow to reflect it. Please
          refresh in a few seconds.
        </p>
      </main>
    </div>
  );
}
