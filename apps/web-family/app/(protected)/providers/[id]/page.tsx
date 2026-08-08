import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { listFavoriteProviders } from '@/lib/favorite-providers-api';
import { formatTier, searchProviders } from '@/lib/providers-api';

import { toggleFavoriteAction } from '../actions';

export const metadata: Metadata = {
  title: 'Provider profile — Taste & See',
};

/**
 * Family-portal provider profile page (TS-125).
 *
 * Phase-1 reads the profile from the discovery doc — there's no
 * dedicated `service-provider` profile read surface yet (TS-125-followup-1
 * captures the upgrade when service-provider grows a public read
 * endpoint). The doc carries enough to render a useful profile:
 * display name, headline, bio, languages, cuisines, specialties,
 * dietary expertise, tier, ratings.
 *
 * The "Request a visit" CTA jumps to `/bookings/new?providerId=...` —
 * the family-facing booking request form. When the family arrived here
 * from a provider-discovery search, the `?searchId=` correlation token
 * (TS-217-prep-4a) rides through on the CTA so the eventual booking can
 * be attributed to the originating search (TS-217-prep-4c).
 */
export default async function ProviderProfilePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  // The originating search-correlation token, when this profile was opened
  // from a search result. Threaded onto the "Request a visit" CTA below.
  const searchId = typeof query.searchId === 'string' ? query.searchId : null;

  // Phase-1 lookup: pull the doc out of the search index by id. The
  // discovery doc is the same shape we'd return from a dedicated
  // profile endpoint; this saves a service round-trip until the
  // dedicated endpoint lands. A status filter widens the result set to
  // include non-active providers so the page works for "in_review" or
  // "suspended" providers too — concierge ops needs to see them.
  //
  // TS-215-followup-1 — Fetch the actor's no-senior favourites in
  // parallel so the heart toggle on this detail page reflects state
  // without a second navigation. A failure to load favourites does
  // NOT block the profile render; the heart simply renders as
  // "not favourited" and the toggle action will re-fetch.
  const [result, favoritesLookup] = await Promise.all([
    searchProviders({
      filters: { statuses: ['pending', 'in_review', 'active', 'suspended', 'archived'] },
      sort: 'relevance',
      limit: 100,
    } as never),
    listFavoriteProviders({ providerId: id, seniorId: null }),
  ]);
  if (result.kind === 'unauthorized' || favoritesLookup.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  const isFavorited = favoritesLookup.kind === 'ok' && favoritesLookup.favorites.length > 0;
  if (result.kind !== 'ok') {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Profile is briefly unreachable</h1>
          <p>Please refresh in a moment.</p>
          <Link href="/providers" className="link-back">
            Back to browse
          </Link>
        </main>
      </div>
    );
  }
  const hit = result.hits.find((h) => h.document.providerId === id);
  if (hit === undefined) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>That profile isn&apos;t here</h1>
          <p>
            This chef may have stepped away from the platform — or the link is stale. Take a look at
            our roster instead.
          </p>
          <Link href="/providers" className="plans-cta">
            Browse all providers
          </Link>
        </main>
      </div>
    );
  }
  const doc = hit.document;

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/providers" className="dash-logout">
          Back to browse
        </Link>
      </header>
      <main className="dash-main">
        <article className="provider-profile">
          <header>
            <h1>{doc.displayName}</h1>
            <p className="providers-tier">{formatTier(doc.tier)}</p>
            {doc.headline !== null ? <p className="provider-headline">{doc.headline}</p> : null}
          </header>

          {doc.bio !== null ? (
            <section>
              <h2>About</h2>
              <p>{doc.bio}</p>
            </section>
          ) : null}

          {doc.specialties.length > 0 ? (
            <section>
              <h2>Specialties</h2>
              <ul className="providers-tags">
                {doc.specialties.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {doc.cuisines.length > 0 ? (
            <section>
              <h2>Cuisines</h2>
              <ul className="providers-tags">
                {doc.cuisines.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {doc.languages.length > 0 ? (
            <section>
              <h2>Languages</h2>
              <ul className="providers-tags">
                {doc.languages.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {doc.certifications.length > 0 ? (
            <section>
              <h2>Certifications</h2>
              <ul className="providers-tags">
                {doc.certifications.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <footer className="provider-profile-foot">
            <p>
              Once you ask for a visit, our concierge team confirms the date and time with you and
              the chef within 24 hours.
            </p>
            <div className="provider-profile-actions">
              <form action={toggleFavoriteAction}>
                <input type="hidden" name="providerId" value={doc.providerId} />
                <button
                  type="submit"
                  className="favorite-toggle"
                  aria-label={isFavorited ? 'Remove from favourites' : 'Save to favourites'}
                  aria-pressed={isFavorited}
                >
                  <span aria-hidden="true">{isFavorited ? '♥' : '♡'}</span>
                  <span className="favorite-toggle-label">
                    {isFavorited ? 'Favourited' : 'Save to favourites'}
                  </span>
                </button>
              </form>
              <Link
                href={`/bookings/new?providerId=${encodeURIComponent(doc.providerId)}${
                  searchId !== null ? `&searchId=${encodeURIComponent(searchId)}` : ''
                }`}
                className="plans-cta"
              >
                Request a visit
              </Link>
            </div>
          </footer>
        </article>
      </main>
    </div>
  );
}
