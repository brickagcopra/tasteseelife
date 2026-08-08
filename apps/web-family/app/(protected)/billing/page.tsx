import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type { MySubscriptionSummary } from '@taste-and-see/contracts';

import { formatUsdMinor } from '@/lib/plans-api';
import { readMySubscription, type MySubscriptionResult } from '@/lib/my-subscription-api';

import { openBillingPortalAction } from './actions';

export const metadata: Metadata = {
  title: 'Billing — Taste & See',
  robots: { index: false, follow: false },
};

/**
 * Family billing home (TS-042-followup-3a3-followup-1 /
 * TS-042-followup-3a3-followup-1a).
 *
 * The page the dunning ladder's call to action points at. It shipped
 * with a portal button and nothing to say about the plan that button
 * manages, because no family-facing subscription read existed on the
 * platform at all — a household could buy a plan at checkout and never
 * see it again. `GET /api/v1/subscriptions/me` closed that; this page is
 * where it lands.
 *
 * **The plan read never gates the portal button.** A family arrives here
 * from a dunning email precisely when billing is having a bad day, and
 * that is the worst possible moment to make the one useful control
 * depend on a second service call succeeding. Every branch — including
 * "we couldn't reach the service" — still renders the button.
 */
export default async function BillingPage(): Promise<React.JSX.Element> {
  const result = await readMySubscription();
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  return (
    <Shell>
      <h1>Billing</h1>
      <p>
        Everything to do with paying for your Taste &amp; See plan lives here — the card we charge,
        and every receipt we&apos;ve issued.
      </p>

      <PlanSection result={result} />

      <section className="billing-card" aria-labelledby="billing-payment-heading">
        <h2 id="billing-payment-heading">Your payment method</h2>
        <p>
          Update your card, change your billing address, or review your plan in our payment
          provider&apos;s secure portal. We never see or store your card details.
        </p>
        <form action={openBillingPortalAction}>
          <button type="submit" className="cta">
            Update your payment method
          </button>
        </form>
        <p className="billing-note">
          This opens Stripe, who handle payments for us. You&apos;ll come straight back here when
          you&apos;re done.
        </p>
      </section>

      <section className="billing-card" aria-labelledby="billing-invoices-heading">
        <h2 id="billing-invoices-heading">Your receipts</h2>
        <p>Every invoice we&apos;ve issued for your plan, with a PDF for your records.</p>
        <Link href="/billing/invoices" className="link-inline">
          View your invoices
        </Link>
      </section>
    </Shell>
  );
}

/**
 * `unauthorized` is excluded rather than handled: the page has already
 * redirected by the time this renders, and a branch for a state that
 * cannot arrive is a branch nobody will keep correct.
 */
type PlanSectionResult = Exclude<MySubscriptionResult, { kind: 'unauthorized' }>;

function PlanSection({ result }: { readonly result: PlanSectionResult }): React.JSX.Element {
  if (result.kind === 'none') {
    return (
      <section className="billing-card" aria-labelledby="billing-plan-heading">
        <h2 id="billing-plan-heading">Your plan</h2>
        <p>
          You don&apos;t have a Taste &amp; See plan on this account yet. Have a look at what&apos;s
          available whenever you&apos;re ready — there&apos;s no rush.
        </p>
        <Link href="/plans" className="link-inline">
          See our plans
        </Link>
      </section>
    );
  }

  if (result.kind === 'unavailable') {
    // Explicitly NOT "you have no plan". We do not know that, and telling
    // a paying family they have nothing is the more harmful of the two
    // wrong answers.
    return (
      <section className="billing-card" aria-labelledby="billing-plan-heading">
        <h2 id="billing-plan-heading">Your plan</h2>
        <p>
          We can&apos;t show your plan details just this moment. Nothing has changed about your
          membership — please refresh in a few seconds.
        </p>
      </section>
    );
  }

  return <PlanCard subscription={result.subscription} />;
}

function PlanCard({
  subscription,
}: {
  readonly subscription: MySubscriptionSummary;
}): React.JSX.Element {
  const price = formatUsdMinor(subscription.unitPriceUsdMinor);
  const per = subscription.billingInterval === 'monthly' ? 'a month' : 'a year';

  return (
    <section className="billing-card" aria-labelledby="billing-plan-heading">
      <h2 id="billing-plan-heading">Your plan</h2>

      {subscription.paymentTrouble ? <PaymentTrouble subscription={subscription} /> : null}

      <p className="billing-plan-name">
        <strong>{subscription.planName}</strong> — {price} {per}
      </p>

      <PlanTiming subscription={subscription} />
    </section>
  );
}

/**
 * The banner a family in dunning needs. It says what is happening and
 * what to do, and — like the emails — never states the retry count and
 * never uses collections language. The deadline appears only when we
 * actually have one.
 */
function PaymentTrouble({
  subscription,
}: {
  readonly subscription: MySubscriptionSummary;
}): React.JSX.Element {
  return (
    <p className="billing-alert" role="status">
      <strong>We&apos;re having trouble with your payment.</strong>{' '}
      {subscription.paymentDueBy !== null ? (
        <>
          To keep upcoming visits on the calendar, it needs to be sorted by{' '}
          {formatDate(subscription.paymentDueBy)}.{' '}
        </>
      ) : (
        <>We&apos;ll keep trying, and there may be nothing for you to do. </>
      )}
      Updating your card below is the quickest way to put it right.
    </p>
  );
}

function PlanTiming({
  subscription,
}: {
  readonly subscription: MySubscriptionSummary;
}): React.JSX.Element {
  if (subscription.status === 'canceled') {
    return (
      <p className="billing-note">
        This membership ended on {formatDate(subscription.currentPeriodEnd)}.{' '}
        <Link href="/plans" className="link-inline">
          Start again whenever you like
        </Link>
        .
      </p>
    );
  }

  if (subscription.cancelAtPeriodEnd) {
    // The date means something different here, and saying "renews on" of a
    // membership that is ending would be simply false.
    return (
      <p className="billing-note">
        Your membership is set to end on {formatDate(subscription.currentPeriodEnd)}. Visits
        continue as normal until then.
      </p>
    );
  }

  if (subscription.pauseResumesAt !== null) {
    return (
      <p className="billing-note">
        Your membership is paused and picks up again on {formatDate(subscription.pauseResumesAt)}.
      </p>
    );
  }

  if (subscription.status === 'paused') {
    return <p className="billing-note">Your membership is paused.</p>;
  }

  if (subscription.trialEnd !== null && subscription.status === 'trialing') {
    return (
      <p className="billing-note">
        You&apos;re in your trial until {formatDate(subscription.trialEnd)}. Your first payment
        comes after that.
      </p>
    );
  }

  return <p className="billing-note">Renews on {formatDate(subscription.currentPeriodEnd)}.</p>;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function Shell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Back to dashboard
        </Link>
      </header>
      <main className="dash-main">{children}</main>
    </div>
  );
}
