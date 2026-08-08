import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type { ProviderDiscoveryDocument } from '@taste-and-see/contracts';
import { PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX } from '@taste-and-see/contracts';

import { listFavoriteProviders } from '@/lib/favorite-providers-api';
import { formatTier, searchProviders } from '@/lib/providers-api';

import { removeFavoriteAction } from './actions';

export const metadata: Metadata = {
  title: 'Favourite chefs — Taste & See',
};

/**
 * Per-page favourite cap (TS-215-followup-2). Matches
 * `PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX` so a single hydration
 * request covers a full page in one round-trip.
 */
const FAVORITES_PAGE_SIZE = PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX;

/**
 * Favourite-providers list page (TS-215, TS-215-followup-2).
 *
 * Renders every provider the actor has favourited, newest first. Each
 * row links to the provider detail page and exposes a remove button.
 *
 * **Hydration (TS-215-followup-2).** Each favourite row is hydrated with
 * the denormalised provider discovery doc via a single batched
 * `searchProviders({ filters: { providerIds: [...], statuses: [...] } })`
 * call rather than N parallel single-doc fetches. One round-trip per
 * page is more efficient than N HTTP hops through the gateway and the
 * wire shape is identical — the `providerIds` filter is membership-only.
 * Rows whose discovery doc is missing (provider archived, deleted, or
 * indexer lag) fall back to a "currently unavailable" placeholder so
 * the row is still removable.
 *
 * **Pagination.** Client-side slicing by `FAVORITES_PAGE_SIZE` (24) —
 * the favourites API caps the per-actor total at 500 and returns the
 * full list in one call, so we hold all ids server-side and slice for
 * the rendered page. The "Load more" / "Newer" affordances drive the
 * page index via `?page=N` so the URL is shareable + the
 * back-button-restores-position invariant holds.
 */
export default async function FavoritesPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = (await searchParams) ?? {};
  const pageParam = typeof params.page === 'string' ? Number.parseInt(params.page, 10) : 1;
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;

  const result = await listFavoriteProviders();
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  // Compute the page window first; only hydrate the slice we're about
  // to render so we don't burn a wider gateway hop than necessary.
  const allFavorites = result.kind === 'ok' ? result.favorites : [];
  const pageOffset = (page - 1) * FAVORITES_PAGE_SIZE;
  const pageSlice = allFavorites.slice(pageOffset, pageOffset + FAVORITES_PAGE_SIZE);
  const totalCount = allFavorites.length;
  const hasOlder = pageOffset + pageSlice.length < totalCount;
  const hasNewer = page > 1;

  // Hydrate the page slice via a single batched discovery-doc fetch.
  // The discovery doc carries every field the card needs (display name,
  // headline, tier badge, bio, specialties, photo key). Failure to load
  // discovery docs does NOT block the favourites list — rows fall back
  // to a sparser placeholder card.
  const hydratedById = await hydrateDiscoveryDocs(pageSlice.map((r) => r.providerId));

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>Your favourite chefs</h1>
        <p>
          Chefs you&apos;ve loved before — keep them close so it&apos;s a one-click trip back to
          their profile when it&apos;s time to plan the next visit.
        </p>

        {result.kind !== 'ok' ? (
          <p className="providers-empty">
            We couldn&apos;t load your favourites right now. Please refresh in a moment.
          </p>
        ) : totalCount === 0 ? (
          <div className="providers-empty">
            <p>
              You haven&apos;t favourited a chef yet. Browse the{' '}
              <Link href="/providers" className="link-inline">
                chef directory
              </Link>{' '}
              and tap the heart on any profile to add them here.
            </p>
          </div>
        ) : pageSlice.length === 0 ? (
          // The actor navigated past the last page (e.g. removed a
          // favourite that was the only row on this page). Bounce them
          // back to page 1.
          <div className="providers-empty">
            <p>
              No favourites on this page.{' '}
              <Link href="/favorites" className="link-inline">
                Back to your most recent
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            <ul className="favorites-list">
              {pageSlice.map((row) => {
                const doc = hydratedById.get(row.providerId);
                return (
                  <li key={row.id} className="favorites-card">
                    {doc !== undefined ? (
                      <>
                        <header className="favorites-card-head">
                          <h2 className="favorites-card-name">
                            <Link
                              href={`/providers/${encodeURIComponent(row.providerId)}`}
                              className="link-inline"
                            >
                              {doc.displayName}
                            </Link>
                          </h2>
                          <span className="providers-tier">{formatTier(doc.tier)}</span>
                        </header>
                        {doc.headline !== null ? (
                          <p className="favorites-card-headline">{doc.headline}</p>
                        ) : null}
                        {doc.specialties.length > 0 ? (
                          <ul className="providers-tags">
                            {doc.specialties.slice(0, 4).map((t) => (
                              <li key={t}>{t}</li>
                            ))}
                          </ul>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <header className="favorites-card-head">
                          <h2 className="favorites-card-name">Chef profile unavailable</h2>
                        </header>
                        <p className="favorites-card-placeholder" role="status">
                          This chef may have stepped away from the platform. You can still remove
                          the favourite below.
                        </p>
                      </>
                    )}
                    <footer className="favorites-card-foot">
                      <span className="favorites-meta">
                        {row.seniorId !== null ? `For senior ${row.seniorId}` : 'General favourite'}
                      </span>
                      {row.notes !== null ? <p className="favorites-notes">{row.notes}</p> : null}
                      <form action={removeFavoriteAction}>
                        <input type="hidden" name="id" value={row.id} />
                        <button type="submit" className="dash-logout">
                          Remove
                        </button>
                      </form>
                    </footer>
                  </li>
                );
              })}
            </ul>
            {hasOlder || hasNewer ? (
              <nav className="favorites-pagination" aria-label="Favourites pagination">
                {hasNewer ? (
                  <Link
                    href={
                      page === 2
                        ? '/favorites'
                        : `/favorites?page=${encodeURIComponent(String(page - 1))}`
                    }
                    className="link-inline"
                    rel="prev"
                  >
                    ← Newer favourites
                  </Link>
                ) : (
                  <span />
                )}
                <span className="favorites-pagination-meta">
                  Showing {pageOffset + 1}–{pageOffset + pageSlice.length} of {totalCount}
                </span>
                {hasOlder ? (
                  <Link
                    href={`/favorites?page=${encodeURIComponent(String(page + 1))}`}
                    className="link-inline"
                    rel="next"
                  >
                    Older favourites →
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * Batch-hydrate the discovery docs for a page of favourites in one
 * gateway round-trip via the `providerIds` filter (TS-215-followup-2).
 *
 * Why a batched call rather than N parallel single-doc fetches: the
 * gateway hop carries cookie-auth + RBAC + downstream proxy on every
 * request; doing it 24 times for a page of favourites is wasteful when
 * the search backend already supports a membership filter. The wire
 * behaviour is identical from the caller's POV — pass ids in, get docs
 * back, fall back gracefully when a doc isn't found.
 *
 * **Status widening.** The default backend status filter is
 * `['active']`; favourites can point at providers that have since been
 * suspended or archived, and the family-portal still wants to surface
 * "this chef has stepped away" rather than silently drop the row. We
 * widen to every status here; the row falls back to a placeholder card
 * when the doc is genuinely gone from the index.
 *
 * **Empty input.** When the page slice is empty we return an empty Map
 * without issuing the gateway hop — defends against a Zod `min(1)`
 * trip on the `providerIds` filter when the page is past the end.
 *
 * **Soft-fail.** Any non-`ok` response from the gateway (timeout,
 * 502, etc.) returns an empty Map — rows render with the placeholder
 * card and the user can still remove or navigate. We deliberately do
 * NOT redirect the user away from a transient failure.
 */
async function hydrateDiscoveryDocs(
  providerIds: readonly string[],
): Promise<Map<string, ProviderDiscoveryDocument>> {
  const hydrated = new Map<string, ProviderDiscoveryDocument>();
  if (providerIds.length === 0) {
    return hydrated;
  }
  const result = await searchProviders({
    filters: {
      providerIds: [...providerIds],
      statuses: ['pending', 'in_review', 'active', 'suspended', 'archived'],
    },
    sort: 'relevance',
    limit: FAVORITES_PAGE_SIZE,
  } as never);
  if (result.kind !== 'ok') {
    return hydrated;
  }
  for (const hit of result.hits) {
    hydrated.set(hit.document.providerId, hit.document);
  }
  return hydrated;
}
