import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { formatUsdMinor, loadPlans } from '@/lib/plans-api';

export const metadata: Metadata = {
  title: 'Choose a plan — Taste & See',
};

/**
 * Family-portal plan picker (TS-124).
 *
 * Server component that calls the gateway plans catalog through
 * `loadPlans()` and renders the active family plans as link cards. The
 * "Continue" link routes to `/checkout/[code]` where the customer
 * confirms billing cadence and triggers the Stripe Checkout redirect.
 *
 * Plan filtering. Only `customerGroup === 'family'` plans surface here
 * — the provider portal will mount its own equivalent under TS-122
 * follow-ups, and the academy catalog is its own thing.
 */
export default async function PlansPage(): Promise<React.JSX.Element> {
  const result = await loadPlans();
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  if (result.kind !== 'ok') {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Plans are taking a moment</h1>
          <p>Our catalog is briefly unreachable. Refresh in a few seconds.</p>
          <Link href="/dashboard" className="link-back">
            Back to your dashboard
          </Link>
        </main>
      </div>
    );
  }

  const familyPlans = result.plans
    .filter((plan) => plan.customerGroup === 'family' && plan.active)
    .sort((a, b) => a.monthlyPriceUsdMinor - b.monthlyPriceUsdMinor);

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Back
        </Link>
      </header>
      <main className="dash-main">
        <h1>Choose a plan</h1>
        <p>
          Every plan starts a relationship — a chef who learns the table, a companion who notices
          the small things. Pick the rhythm that fits your family today; you can change tier or
          pause at any time.
        </p>

        {familyPlans.length === 0 ? (
          <p className="plans-empty">
            We&apos;re refreshing the catalog. Please check back in a few minutes.
          </p>
        ) : (
          <ul className="plans-list">
            {familyPlans.map((plan) => {
              const monthly = formatUsdMinor(plan.monthlyPriceUsdMinor);
              const annual = formatUsdMinor(plan.annualPriceUsdMinor);
              return (
                <li key={plan.code} className="plans-card">
                  <header className="plans-card-head">
                    <h2>{plan.name}</h2>
                    <span className="plans-price">{monthly}/mo</span>
                  </header>
                  {plan.description !== undefined ? (
                    <p className="plans-desc">{plan.description}</p>
                  ) : null}
                  {plan.features.length > 0 ? (
                    <ul className="plans-features">
                      {plan.features.map((feature) => (
                        <li key={feature}>{feature}</li>
                      ))}
                    </ul>
                  ) : null}
                  <footer className="plans-card-foot">
                    <span className="plans-annual">or {annual}/yr</span>
                    <Link className="plans-cta" href={`/checkout/${plan.code}`}>
                      Continue
                    </Link>
                  </footer>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
