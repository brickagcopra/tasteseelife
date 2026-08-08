import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Checkout canceled — Taste & See',
  robots: { index: false, follow: false },
};

interface CancelPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Stripe Checkout cancel-landing page (TS-124).
 *
 * Reached when the customer hits "Back" on the Stripe-hosted page. We
 * don't surface an error — the customer just changed their mind. The
 * `plan` query param (if present) lets us deep-link the "try again"
 * button to the right /checkout page.
 */
export default async function CheckoutCancelPage({
  searchParams,
}: CancelPageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const rawPlan = params.plan;
  const planCode = typeof rawPlan === 'string' ? rawPlan : null;

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Your dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>No problem.</h1>
        <p>
          Your checkout was canceled — nothing was charged. Take your time. When you&apos;re ready,
          your plan options are still here.
        </p>
        {planCode !== null ? (
          <Link href={`/checkout/${planCode}`} className="cta">
            Continue with that plan
          </Link>
        ) : (
          <Link href="/plans" className="cta">
            See plans
          </Link>
        )}
      </main>
    </div>
  );
}
