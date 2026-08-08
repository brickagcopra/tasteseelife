import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type {
  ProviderDiscoveryFacetBucket,
  ProviderDiscoveryFacets,
} from '@taste-and-see/contracts';
import { SPONSORED_LABEL } from '@taste-and-see/ui';

import { RecordSearchClickLink } from '@/components/record-search-click-link';
import { listFavoriteProviders } from '@/lib/favorite-providers-api';
import { formatTier, searchProviders } from '@/lib/providers-api';
import {
  buildProviderSearchUrl,
  EMPTY_FORM_STATE,
  formStateToRequest,
  hasAnyFilter,
  parseProviderSearchParams,
  requestToFormState,
  withCursor,
  withoutCursor,
  type ProviderSearchFormState,
} from '@/lib/provider-search-url';
import { getSavedSearch } from '@/lib/saved-searches-api';

import { saveCurrentSearchAction, toggleFavoriteAction } from './actions';

export const metadata: Metadata = {
  title: 'Browse providers — Taste & See',
};

/**
 * Family-portal provider discovery (TS-125 + TS-212).
 *
 * Server-rendered browse page with multi-select faceted filtering and
 * cursor pagination over the result set.
 *
 *   - **Filters** ride on URL params (`?q=`, `?tier=`, `?lang=`,
 *     `?specialty=`, `?cuisine=`, `?diet=`, `?cert=`, `?minRating=`).
 *     Multi-value filters use repeated keys so the URL stays shareable
 *     and the back button restores the exact filter selection.
 *   - **Facets** come back on every search response with bucket counts.
 *     The sidebar renders one checkbox per facet bucket; user toggles
 *     and clicks "Apply" to round-trip the new filter set.
 *   - **Pagination** uses the opaque `nextCursor` returned by the
 *     gateway. "Start over" drops the cursor and any active filter so
 *     the user is back at the page-one unfiltered grid. Browser back
 *     is the canonical "previous page" affordance — cursors are
 *     forward-only by contract.
 *   - **Saved searches** continue to hydrate via `?savedSearchId=` —
 *     the stored body now seeds the full filter set, not just `q` +
 *     tier. Once hydrated the URL drops the `savedSearchId` (the form
 *     state is what the user can refine).
 *   - **Favourites** continue to surface as a heart toggle on every
 *     card; the state mirrors the per-actor + per-provider tuple
 *     loaded in parallel.
 */
export default async function ProvidersPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = (await searchParams) ?? {};
  const { formState: urlFormState } = parseProviderSearchParams(params);

  let formState: ProviderSearchFormState = urlFormState;
  let savedSearchUnavailable = false;
  if (urlFormState.savedSearchId !== null && !hasAnyFilter(urlFormState)) {
    const fetched = await getSavedSearch(urlFormState.savedSearchId);
    if (fetched.kind === 'unauthorized') {
      redirect('/login?expired=1');
    }
    if (fetched.kind === 'ok') {
      formState = requestToFormState(fetched.savedSearch.query, urlFormState.savedSearchId);
    } else {
      savedSearchUnavailable = true;
    }
  }

  const request = formStateToRequest(formState);
  const [result, favoritesLookup] = await Promise.all([
    searchProviders(request),
    listFavoriteProviders({ seniorId: null }),
  ]);
  if (result.kind === 'unauthorized' || favoritesLookup.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  const favoriteByProviderId = new Map<string, string>();
  if (favoritesLookup.kind === 'ok') {
    for (const favorite of favoritesLookup.favorites) {
      if (favorite.seniorId === null) {
        favoriteByProviderId.set(favorite.providerId, favorite.id);
      }
    }
  }

  const facets: ProviderDiscoveryFacets =
    result.kind === 'ok'
      ? result.facets
      : { tiers: [], languages: [], specialties: [], cuisines: [], certifications: [] };
  const hits = result.kind === 'ok' ? result.hits : [];
  const totalEstimate = result.kind === 'ok' ? result.totalEstimate : 0;
  const nextCursor = result.kind === 'ok' ? result.nextCursor : null;
  // Search-correlation token echoed on the result-click beacon (TS-217-prep-4b);
  // null when the search load failed so the link renders without a beacon.
  const searchId = result.kind === 'ok' ? result.searchId : null;

  const baseFormState = withoutCursor({ ...formState, savedSearchId: null });
  const startOverHref = buildProviderSearchUrl('/providers', EMPTY_FORM_STATE);
  const nextHref =
    nextCursor !== null
      ? buildProviderSearchUrl('/providers', withCursor(baseFormState, nextCursor))
      : null;
  const onPageOneHref = buildProviderSearchUrl('/providers', baseFormState);
  const isPagedBeyondFirst = formState.cursor !== null;

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>Browse chefs &amp; companions</h1>
        <p>
          Every person on Taste &amp; See is vetted, certified, and trained for hospitality and
          warmth — not clinical care. Browse our roster, then ask our concierge team to confirm the
          right fit for your loved one.
        </p>

        {savedSearchUnavailable ? (
          <p className="providers-empty" role="status">
            That saved search isn&apos;t available any more. Showing all providers instead.
          </p>
        ) : null}

        <form className="save-search-form" action={saveCurrentSearchAction}>
          <label htmlFor="save-search-name" className="sr-only">
            Name this search
          </label>
          <input
            id="save-search-name"
            type="text"
            name="name"
            placeholder='Name this search (e.g. "Italian-speaking chefs near Mom")'
            maxLength={120}
            required
          />
          <input
            type="hidden"
            name="body"
            value={JSON.stringify(formStateToRequest(baseFormState))}
          />
          <button type="submit" className="link-inline">
            Save this search
          </button>
        </form>

        <div className="providers-layout">
          <aside className="providers-sidebar" aria-label="Filter providers">
            <form className="providers-filter-form" action="/providers" method="GET">
              <header className="providers-sidebar-head">
                <h2>Filters</h2>
                {hasAnyFilter(formState) ? (
                  <Link href={startOverHref} className="link-inline">
                    Clear all
                  </Link>
                ) : null}
              </header>

              <div className="providers-search-row">
                <label htmlFor="provider-q" className="sr-only">
                  Search
                </label>
                <input
                  id="provider-q"
                  type="search"
                  name="q"
                  defaultValue={formState.query}
                  placeholder="Search by cuisine, language, name…"
                  autoComplete="off"
                  inputMode="search"
                />
              </div>

              <FacetGroup
                title="Tier"
                facetKey="tier"
                buckets={facets.tiers}
                selected={formState.tiers}
                labeller={(value) => formatTier(value as 'basic' | 'certified' | 'elite')}
              />
              <FacetGroup
                title="Language"
                facetKey="lang"
                buckets={facets.languages}
                selected={formState.languages}
              />
              <FacetGroup
                title="Cuisine"
                facetKey="cuisine"
                buckets={facets.cuisines}
                selected={formState.cuisines}
              />
              <FacetGroup
                title="Specialty"
                facetKey="specialty"
                buckets={facets.specialties}
                selected={formState.specialties}
              />
              <FacetGroup
                title="Certification"
                facetKey="cert"
                buckets={facets.certifications}
                selected={formState.certifications}
              />

              <MinRatingControl current={formState.minRating} />

              {/* Dietary expertise has no facet aggregate today (the backend
                 exposes it as a filter but not as a facet). Render only when
                 the user has already opted in via URL so they can clear the
                 selection — adding the facet aggregate is TS-212-followup-1. */}
              {formState.dietaryExpertise.length > 0 ? (
                <ActiveFilterRow
                  title="Dietary expertise"
                  values={formState.dietaryExpertise}
                  facetKey="diet"
                />
              ) : null}

              <button type="submit" className="submit providers-filter-apply">
                Apply filters
              </button>
            </form>
          </aside>

          <section className="providers-results" aria-live="polite">
            <header className="providers-summary">
              <ResultSummary
                kind={result.kind === 'ok' ? 'ok' : 'failure'}
                hitCount={hits.length}
                totalEstimate={totalEstimate}
                isPagedBeyondFirst={isPagedBeyondFirst}
                isLive={result.kind === 'ok' ? result.liveMode : false}
              />
              {isPagedBeyondFirst ? (
                <Link href={onPageOneHref} className="link-inline">
                  ← Back to page one
                </Link>
              ) : null}
            </header>

            {result.kind !== 'ok' ? (
              <p className="providers-empty">
                The provider directory is briefly unreachable. Please refresh in a moment.
              </p>
            ) : hits.length === 0 ? (
              <div className="providers-empty">
                <p>
                  No matches yet. Try a broader search or{' '}
                  <Link href="/bookings/new" className="link-inline">
                    ask our concierge
                  </Link>{' '}
                  to handpick someone for you.
                </p>
              </div>
            ) : (
              <ul className="providers-grid">
                {hits.map((hit, index) => {
                  const doc = hit.document;
                  return (
                    <li key={doc.providerId} className="providers-card">
                      <header className="providers-card-head">
                        <h3>{doc.displayName}</h3>
                        <span className="providers-card-tags">
                          {/* TS-218b / TS-278 — mandatory "Sponsored" disclosure
                             (PDD §18.3) on paid placements. The label text is
                             single-sourced from `@taste-and-see/ui`
                             (`SPONSORED_LABEL`) so it can never drift; the pill
                             visual stays as web-family's `.providers-sponsored`
                             CSS (this app is hand-CSS, not a packages/ui Tailwind
                             consumer — full `SponsoredBadge` adoption is
                             TS-278-followup-1). Independent of the organic
                             "Featured" boost — a row may show both. */}
                          {hit.sponsored !== null ? (
                            <span className="providers-sponsored">{SPONSORED_LABEL}</span>
                          ) : null}
                          {hit.featured ? (
                            <span className="providers-featured">Featured</span>
                          ) : null}
                          <span className="providers-tier">{formatTier(doc.tier)}</span>
                        </span>
                      </header>
                      {doc.headline !== null ? (
                        <p className="providers-headline">{doc.headline}</p>
                      ) : null}
                      {doc.bio !== null ? <p className="providers-bio">{doc.bio}</p> : null}
                      {doc.specialties.length > 0 ? (
                        <ul className="providers-tags">
                          {doc.specialties.slice(0, 4).map((t) => (
                            <li key={t}>{t}</li>
                          ))}
                        </ul>
                      ) : null}
                      {doc.ratingAverage !== null ? (
                        <p className="providers-rating">
                          <span aria-hidden="true">★</span> {doc.ratingAverage.toFixed(1)}
                          <span className="providers-rating-count">
                            {' '}
                            ({doc.ratingCount} {doc.ratingCount === 1 ? 'review' : 'reviews'})
                          </span>
                        </p>
                      ) : null}
                      <footer className="providers-card-foot">
                        <RecordSearchClickLink
                          href={`/providers/${encodeURIComponent(doc.providerId)}${
                            searchId !== null ? `?searchId=${encodeURIComponent(searchId)}` : ''
                          }`}
                          className="link-inline"
                          searchId={searchId}
                          providerId={doc.providerId}
                          position={index}
                        >
                          View profile
                        </RecordSearchClickLink>
                        <form action={toggleFavoriteAction}>
                          <input type="hidden" name="providerId" value={doc.providerId} />
                          <button
                            type="submit"
                            className="favorite-toggle"
                            aria-label={
                              favoriteByProviderId.has(doc.providerId)
                                ? 'Remove from favourites'
                                : 'Save to favourites'
                            }
                          >
                            {favoriteByProviderId.has(doc.providerId) ? '♥' : '♡'}
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
                      </footer>
                    </li>
                  );
                })}
              </ul>
            )}

            {result.kind === 'ok' && (nextHref !== null || isPagedBeyondFirst) ? (
              <nav className="providers-pagination" aria-label="Search pagination">
                <span aria-hidden={!isPagedBeyondFirst}>
                  {isPagedBeyondFirst ? (
                    <Link href={onPageOneHref} rel="prev" className="link-inline">
                      ← First page
                    </Link>
                  ) : null}
                </span>
                <span aria-hidden={nextHref === null}>
                  {nextHref !== null ? (
                    <Link href={nextHref} rel="next" className="link-inline">
                      Next page →
                    </Link>
                  ) : null}
                </span>
              </nav>
            ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}

interface ResultSummaryProps {
  readonly kind: 'ok' | 'failure';
  readonly hitCount: number;
  readonly totalEstimate: number;
  readonly isPagedBeyondFirst: boolean;
  readonly isLive: boolean;
}

function ResultSummary(props: ResultSummaryProps): React.JSX.Element {
  if (props.kind !== 'ok') {
    return <p className="providers-summary-text">Loading the chef directory…</p>;
  }
  if (props.totalEstimate === 0) {
    return <p className="providers-summary-text">No matches.</p>;
  }
  const seenLabel = props.isPagedBeyondFirst ? 'on this page' : 'so far';
  const liveSuffix = props.isLive ? '' : ' (preview)';
  return (
    <p className="providers-summary-text">
      Showing <strong>{props.hitCount}</strong> {props.hitCount === 1 ? 'chef' : 'chefs'}{' '}
      {seenLabel}
      {props.totalEstimate > props.hitCount
        ? ` · ${props.totalEstimate} matching the current filters`
        : ''}
      {liveSuffix}
    </p>
  );
}

interface FacetGroupProps {
  readonly title: string;
  readonly facetKey: string;
  readonly buckets: readonly ProviderDiscoveryFacetBucket[];
  readonly selected: readonly string[];
  readonly labeller?: (value: string) => string;
}

function FacetGroup(props: FacetGroupProps): React.JSX.Element | null {
  const selectedSet = new Set(props.selected);
  // Always show every actively-selected value plus the top server-returned
  // buckets — a refinement might exclude the previously-selected bucket
  // from the new facet aggregate, but the user still needs to see it so
  // they can uncheck it.
  const displayBuckets: ProviderDiscoveryFacetBucket[] = [...props.buckets];
  for (const value of props.selected) {
    if (!displayBuckets.some((b) => b.value === value)) {
      displayBuckets.unshift({ value, count: 0 });
    }
  }
  if (displayBuckets.length === 0) return null;
  return (
    <fieldset className="providers-facet">
      <legend className="providers-facet-title">{props.title}</legend>
      <ul className="providers-facet-list">
        {displayBuckets.map((bucket) => (
          <li key={bucket.value} className="providers-facet-item">
            <label>
              <input
                type="checkbox"
                name={props.facetKey}
                value={bucket.value}
                defaultChecked={selectedSet.has(bucket.value)}
              />
              <span className="providers-facet-label">
                {props.labeller !== undefined ? props.labeller(bucket.value) : bucket.value}
              </span>
              <span className="providers-facet-count" aria-hidden="true">
                {bucket.count}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

interface ActiveFilterRowProps {
  readonly title: string;
  readonly values: readonly string[];
  readonly facetKey: string;
}

function ActiveFilterRow(props: ActiveFilterRowProps): React.JSX.Element {
  return (
    <fieldset className="providers-facet">
      <legend className="providers-facet-title">{props.title}</legend>
      <ul className="providers-facet-list">
        {props.values.map((value) => (
          <li key={value} className="providers-facet-item">
            <label>
              <input type="checkbox" name={props.facetKey} value={value} defaultChecked />
              <span className="providers-facet-label">{value}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

interface MinRatingControlProps {
  readonly current: number | null;
}

function MinRatingControl(props: MinRatingControlProps): React.JSX.Element {
  const current = props.current === null ? '' : String(props.current);
  const options: Array<{ value: string; label: string }> = [
    { value: '', label: 'Any rating' },
    { value: '3', label: '3.0+' },
    { value: '4', label: '4.0+' },
    { value: '4.5', label: '4.5+' },
  ];
  return (
    <fieldset className="providers-facet">
      <legend className="providers-facet-title">Minimum rating</legend>
      <ul className="providers-facet-list">
        {options.map((opt) => (
          <li key={opt.value || 'any'} className="providers-facet-item">
            <label>
              <input
                type="radio"
                name="minRating"
                value={opt.value}
                defaultChecked={current === opt.value}
              />
              <span className="providers-facet-label">{opt.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
