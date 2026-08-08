import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type { ProviderDiscoveryTier, RecommendationSignal } from '@taste-and-see/contracts';

import { getSeniorRecommendations } from '@/lib/recommendations-api';
import { listMySeniors } from '@/lib/seniors-api';

export const metadata: Metadata = {
  title: 'Recommended chefs — Taste & See',
};

const TIER_LABEL: Record<ProviderDiscoveryTier, string> = {
  basic: 'Companion',
  certified: 'Certified Companion',
  elite: 'Elite Concierge',
};

/**
 * Turn the explainability signal trail into human-readable "why we think
 * they're a match" chips. Only the preference-match signals surface here
 * — the rating / popularity / tier quality baselines are shown
 * separately (rating as a star) rather than as match reasons.
 */
function matchChips(signals: readonly RecommendationSignal[]): readonly string[] {
  const chips: string[] = [];
  for (const signal of signals) {
    switch (signal.kind) {
      case 'language':
        chips.push(`Speaks ${signal.matchedValues.join(', ')}`);
        break;
      case 'dietary':
        chips.push(`Dietary: ${signal.matchedValues.join(', ')}`);
        break;
      case 'cuisine':
        chips.push(`Cuisine: ${signal.matchedValues.join(', ')}`);
        break;
      case 'dementia_experience':
        chips.push('Memory-care experience');
        break;
      case 'rating':
      case 'popularity':
      case 'tier':
        break;
    }
  }
  return chips;
}

/**
 * Senior match-recommendations surface (TS-213).
 *
 * Renders the top providers matched to a senior's preferences +
 * household intake, each with a plain-language "why we think they're a
 * match" trail. The data comes from the gateway BFF aggregator, which
 * does the actor↔senior authz, so a non-member gets the same
 * "we couldn't find that loved one" page the preferences editor shows.
 */
export default async function SeniorRecommendationsPage({
  params,
}: {
  readonly params: Promise<{ readonly seniorId: string }>;
}): Promise<React.JSX.Element> {
  const { seniorId } = await params;

  const [recsResult, seniorsResult] = await Promise.all([
    getSeniorRecommendations(seniorId),
    listMySeniors(),
  ]);

  if (recsResult.kind === 'unauthorized' || seniorsResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  if (recsResult.kind === 'forbidden' || recsResult.kind === 'not_found') {
    return (
      <Shell>
        <h1>We couldn&apos;t find that loved one</h1>
        <p className="providers-empty">
          This profile isn&apos;t in your household, or it may have been removed.{' '}
          <Link href="/seniors" className="link-inline">
            Back to your loved ones
          </Link>
          .
        </p>
      </Shell>
    );
  }

  if (recsResult.kind !== 'ok') {
    return (
      <Shell>
        <h1>We&apos;re having a moment</h1>
        <p className="providers-empty">
          We couldn&apos;t load recommendations right now. Please refresh in a moment.
        </p>
      </Shell>
    );
  }

  const senior =
    seniorsResult.kind === 'ok'
      ? seniorsResult.seniors.find((s) => s.seniorId === seniorId)
      : undefined;
  const name =
    senior !== undefined
      ? senior.displayName !== null && senior.displayName.length > 0
        ? senior.displayName
        : senior.firstName
      : 'your loved one';

  const { recommendations } = recsResult;

  return (
    <Shell>
      <h1>Chefs we recommend for {name}</h1>
      <p>
        These chefs are matched to what we know about {name} — the languages they speak, the dishes
        that feel like home, and the gentle care they need.{' '}
        <Link href={`/seniors/${encodeURIComponent(seniorId)}/preferences`} className="link-inline">
          Tell us more
        </Link>{' '}
        to sharpen the match.
      </p>

      {recommendations.length === 0 ? (
        <p className="providers-empty">
          We don&apos;t have any chefs to recommend just yet. As more chefs join your area, they
          &apos;ll appear here.
        </p>
      ) : (
        <ul className="recs-list">
          {recommendations.map(({ document, signals }) => {
            const chips = matchChips(signals);
            return (
              <li key={document.providerId} className="recs-card">
                <div className="recs-card__head">
                  <span className="recs-card__name">{document.displayName}</span>
                  <span className="recs-card__tier">{TIER_LABEL[document.tier]}</span>
                </div>
                {document.headline !== null ? (
                  <p className="recs-card__headline">{document.headline}</p>
                ) : null}
                {document.ratingAverage !== null ? (
                  <p className="recs-card__rating">
                    {document.ratingAverage.toFixed(1)} ★
                    {document.ratingCount > 0 ? ` (${document.ratingCount})` : ''}
                  </p>
                ) : null}
                {chips.length > 0 ? (
                  <div className="recs-why">
                    <span className="recs-why__label">Why we think they&apos;re a match:</span>
                    <ul className="recs-why__chips">
                      {chips.map((chip) => (
                        <li key={chip} className="recs-why__chip">
                          {chip}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="recs-card__actions">
                  <Link
                    href={`/providers/${encodeURIComponent(document.providerId)}`}
                    className="link-inline"
                  >
                    View profile
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}

function Shell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/seniors" className="dash-logout">
          Your loved ones
        </Link>
      </header>
      <main className="dash-main">{children}</main>
    </div>
  );
}
