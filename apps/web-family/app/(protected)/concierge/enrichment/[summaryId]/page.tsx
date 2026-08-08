import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';
import type { ConciergeEnrichmentSummaryRecord } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import {
  getMyEnrichmentSummary,
  type MyEnrichmentSummaryResult,
} from '@/lib/concierge-enrichment-api';

export const metadata: Metadata = {
  title: 'Weekly recap — Taste & See',
};

const MeBodySchema = z.object({ userId: z.string().min(1) });

/**
 * Family read-only Tier-3 weekly enrichment-summary permalink (TS-229). The
 * stable per-week page the dashboard + email link to. Only PUBLISHED summaries
 * for the caller's household resolve; anything else renders a gentle
 * not-found.
 */
export default async function FamilyEnrichmentSummaryPage({
  params,
}: {
  params: Promise<{ summaryId: string }>;
}): Promise<React.JSX.Element> {
  const { summaryId } = await params;

  const me = await callGateway<unknown>('/api/v1/me');
  if (me.kind === 'unauthorized') redirect('/login?expired=1');
  if (me.kind !== 'ok' || !MeBodySchema.safeParse(me.body).success) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }

  const result = await getMyEnrichmentSummary(summaryId);

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <div className="dash-account">
          <Link href="/concierge/enrichment" className="dash-logout">
            Back to recaps
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <SummaryBody result={result} />
      </main>
    </div>
  );
}

function SummaryBody({
  result,
}: {
  readonly result: MyEnrichmentSummaryResult;
}): React.JSX.Element {
  if (result.kind === 'unavailable') {
    return (
      <>
        <h1>We&apos;re having a moment</h1>
        <p className="auth-alert" role="alert">
          We couldn&apos;t load this recap right now. Please refresh in a few seconds.
        </p>
      </>
    );
  }
  if (result.kind === 'not-found') {
    return (
      <>
        <h1>Recap not found</h1>
        <p>
          We couldn&apos;t find that recap. It may not be published yet.{' '}
          <Link href="/concierge/enrichment" className="link-inline">
            See all recaps
          </Link>
          .
        </p>
      </>
    );
  }

  return <SummaryArticle summary={result.summary} />;
}

function SummaryArticle({
  summary,
}: {
  readonly summary: ConciergeEnrichmentSummaryRecord;
}): React.JSX.Element {
  return (
    <article className="enrichment-article">
      <p className="enrichment-article__week">Week of {formatDate(summary.weekStartDate)}</p>
      <h1 className="enrichment-article__headline">{summary.headline}</h1>
      <Section title="Visit highlights" body={summary.visitHighlights} />
      <Section title="Wellbeing this week" body={summary.wellnessSignals} />
      <Section title="Company &amp; connection" body={summary.socialEngagement} />
      {summary.additionalNotes !== null && (
        <Section title="A note from your concierge" body={summary.additionalNotes} />
      )}
      {summary.publishedAt !== null && (
        <p className="enrichment-article__meta">Shared {formatDateTime(summary.publishedAt)}</p>
      )}
    </article>
  );
}

function Section({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}): React.JSX.Element {
  return (
    <section className="enrichment-article__section">
      <h2 className="enrichment-article__section-title">{title}</h2>
      <p className="enrichment-article__section-body">{body}</p>
    </section>
  );
}

function formatDate(yyyymmdd: string): string {
  return new Date(`${yyyymmdd}T00:00:00.000Z`).toLocaleDateString(undefined, {
    dateStyle: 'long',
    timeZone: 'UTC',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
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
