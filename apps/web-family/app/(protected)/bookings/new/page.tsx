import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { searchProviders } from '@/lib/providers-api';

import { BookingRequestForm } from './booking-request-form';

export const metadata: Metadata = {
  title: 'Request a visit — Taste & See',
};

const MeBodySchema = z.object({
  userId: z.string().min(1),
});

/**
 * Family-portal booking-request page (TS-125).
 *
 * Reads `?providerId=` from the URL. If a provider is specified, looks
 * it up in the search index and pre-fills the form with the provider's
 * display name. If no provider is specified the page still renders —
 * concierge can pick the chef for the family.
 *
 * Phase-1 simplification. `householdId` and `seniorId` are both passed
 * as the user's `me.userId`. TS-125-followup-2 captures the upgrade —
 * once household-svc grows a resolver that maps user → household +
 * seniors, the form pre-populates with a senior picker.
 */
export default async function NewBookingPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = (await searchParams) ?? {};
  const providerId = typeof params.providerId === 'string' ? params.providerId : '';
  // TS-217-prep-4c — the originating search-correlation token, when the family
  // arrived here from a provider-discovery search. Threaded onto the booking
  // request so `booking.created` echoes it for precise per-search conversion.
  const searchId = typeof params.searchId === 'string' ? params.searchId : null;

  // Identity readback — used as the soft-FK customerId / householdId /
  // seniorId until household-svc lands (TS-125-followup-2).
  const meResult = await callGateway<unknown>('/api/v1/me');
  if (meResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (meResult.kind !== 'ok') {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>We&apos;re having a moment</h1>
          <p>Our service is briefly unreachable. Please refresh in a moment.</p>
          <Link href="/dashboard" className="link-back">
            Back to dashboard
          </Link>
        </main>
      </div>
    );
  }
  const me = MeBodySchema.safeParse(meResult.body);
  if (!me.success) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>We&apos;re having a moment</h1>
          <p>The session readback was malformed. Please refresh.</p>
        </main>
      </div>
    );
  }

  let providerName: string | null = null;
  let resolvedProviderId = providerId;
  if (providerId.length > 0) {
    // Phase-1 lookup of the provider's display name via the search
    // index. If service-search is unreachable we still let the form
    // render — the user already navigated here with intent.
    const search = await searchProviders({
      filters: { statuses: ['pending', 'in_review', 'active', 'suspended', 'archived'] },
      sort: 'relevance',
      limit: 100,
    } as never);
    if (search.kind === 'ok') {
      const hit = search.hits.find((h) => h.document.providerId === providerId);
      if (hit !== undefined) providerName = hit.document.displayName;
    }
  }

  if (resolvedProviderId.length === 0) {
    return (
      <div className="dash-shell">
        <header className="dash-top">
          <span className="dash-brand">Taste &amp; See</span>
          <Link href="/dashboard" className="dash-logout">
            Dashboard
          </Link>
        </header>
        <main className="dash-main">
          <h1>Tell us who you&apos;d like to book</h1>
          <p>
            Browse our roster and pick a chef — or let our concierge team handpick someone for you.
          </p>
          <div className="booking-empty-actions">
            <Link href="/providers" className="plans-cta">
              Browse providers
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href={`/providers/${encodeURIComponent(resolvedProviderId)}`} className="dash-logout">
          Back to profile
        </Link>
      </header>
      <main className="dash-main">
        <h1>Request a visit</h1>
        <BookingRequestForm
          providerId={resolvedProviderId}
          providerName={providerName}
          householdId={me.data.userId}
          seniorId={me.data.userId}
          searchId={searchId}
        />
      </main>
    </div>
  );
}
