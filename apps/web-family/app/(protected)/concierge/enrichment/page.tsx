import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';
import type { ConciergeEnrichmentSummaryRecord } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import {
  getMyEnrichmentSummaries,
  type MyEnrichmentSummariesResult,
} from '@/lib/concierge-enrichment-api';

export const metadata: Metadata = {
  title: 'Your weekly recaps — Taste & See',
};

const MeBodySchema = z.object({ userId: z.string().min(1) });

/**
 * Family read-only Tier-3 weekly enrichment-summary list (TS-229; PRD §5.1
 * Tier 3, §6.9). Shows the household's published weekly recaps, newest first,
 * each linking to its permalink. Read-only — the concierge team writes them.
 */
export default async function FamilyEnrichmentPage(): Promise<React.JSX.Element> {
  const me = await callGateway<unknown>('/api/v1/me');
  if (me.kind === 'unauthorized') redirect('/login?expired=1');
  if (me.kind !== 'ok' || !MeBodySchema.safeParse(me.body).success) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }

  const result = await getMyEnrichmentSummaries();

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <div className="dash-account">
          <Link href="/dashboard" className="dash-logout">
            Back to dashboard
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Your weekly recaps</h1>
        <p>
          Each week your concierge shares a warm recap of your loved one&apos;s visits, wellbeing,
          and the company they&apos;ve kept. Here are your published recaps.
        </p>
        <EnrichmentBody result={result} />
      </main>
    </div>
  );
}

function EnrichmentBody({
  result,
}: {
  readonly result: MyEnrichmentSummariesResult;
}): React.JSX.Element {
  if (result.kind === 'unavailable') {
    return (
      <p className="auth-alert" role="alert">
        We couldn&apos;t load your recaps right now. Please refresh in a few seconds.
      </p>
    );
  }
  if (result.kind === 'none') {
    return (
      <section className="enrichment-card">
        <p>
          You don&apos;t have any weekly recaps yet. Once you&apos;re on a Concierge Lifestyle plan,
          your dedicated concierge will start sharing them here.{' '}
          <Link href="/plans" className="link-inline">
            See plans
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <ul className="enrichment-list">
      {result.summaries.map((summary) => (
        <EnrichmentListItem key={summary.id} summary={summary} />
      ))}
    </ul>
  );
}

function EnrichmentListItem({
  summary,
}: {
  readonly summary: ConciergeEnrichmentSummaryRecord;
}): React.JSX.Element {
  const href = `/concierge/enrichment/${encodeURIComponent(summary.id)}`;
  return (
    <li className="enrichment-list__item">
      <span className="enrichment-list__week">Week of {formatDate(summary.weekStartDate)}</span>
      <Link href={href} className="enrichment-list__headline">
        {summary.headline}
      </Link>
      <p className="enrichment-list__teaser">{summary.visitHighlights}</p>
      <Link href={href} className="link-inline">
        Read the full recap →
      </Link>
    </li>
  );
}

function formatDate(yyyymmdd: string): string {
  return new Date(`${yyyymmdd}T00:00:00.000Z`).toLocaleDateString(undefined, {
    dateStyle: 'long',
    timeZone: 'UTC',
  });
}

function ServiceWarning(): React.JSX.Element {
  return (
    <main className="dash-main">
      <h1>We&apos;re having a moment</h1>
      <p>Our service is briefly unreachable. Please refresh in a few seconds.</p>
    </main>
  );
}
