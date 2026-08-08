import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  GetConciergeEnrichmentSummaryResponseSchema,
  MeResponseSchema,
  type ConciergeEnrichmentSummaryRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { editEnrichmentSummaryAction, transitionEnrichmentSummaryAction } from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Enrichment summary — Taste & See Admin',
};

/**
 * Tier-3 weekly enrichment-summary detail surface (TS-229). Shows the summary's
 * narrative + status, an edit form, and the lifecycle transition buttons
 * (publish / unpublish / archive). Permission-gated on `concierge:read`; the
 * write affordances render only for an actor holding `concierge:write`.
 */
export default async function EnrichmentSummaryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ summaryId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { summaryId } = await params;
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);

  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasPermission(me, 'concierge:read')) redirect('/dashboard/no-access');
  const canWrite = hasPermission(me, 'concierge:write');

  const summary = await fetchSummary(summaryId);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Tier 3 enrichment summary</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/concierge/enrichment-summaries" className="dash-logout">
            Back to summaries
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Enrichment summary</h1>

        {banner !== null && <ActionBanner banner={banner} />}

        {summary === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t find that summary — it may have been removed, or the concierge service
            is unreachable.
          </p>
        ) : (
          <SummaryDetail summary={summary} canWrite={canWrite} />
        )}
      </main>
    </div>
  );
}

function SummaryDetail({
  summary,
  canWrite,
}: {
  readonly summary: ConciergeEnrichmentSummaryRecord;
  readonly canWrite: boolean;
}): React.JSX.Element {
  return (
    <>
      <section className="user-detail__section">
        <div className="concierge-event-card__head">
          <span className="concierge-event-card__title">{summary.headline}</span>
          <span className={statusChipClass(summary.status)}>{summary.status}</span>
        </div>
        <dl className="concierge-detail__facts">
          <FactItem label="Household">
            <code>{summary.householdId}</code>
          </FactItem>
          <FactItem label="Week of">{formatDate(summary.weekStartDate)}</FactItem>
          {summary.publishedAt !== null && (
            <FactItem label="Published">{formatDateTime(summary.publishedAt)}</FactItem>
          )}
          {summary.archivedAt !== null && (
            <FactItem label="Archived">{formatDateTime(summary.archivedAt)}</FactItem>
          )}
          <FactItem label="Last updated">{formatDateTime(summary.updatedAt)}</FactItem>
        </dl>
        <div className="enrichment-sections">
          <NarrativeSection title="Visit highlights" body={summary.visitHighlights} />
          <NarrativeSection title="Wellness signals" body={summary.wellnessSignals} />
          <NarrativeSection title="Social engagement" body={summary.socialEngagement} />
          {summary.additionalNotes !== null && (
            <NarrativeSection title="Additional notes" body={summary.additionalNotes} />
          )}
        </div>
      </section>

      {canWrite && (
        <>
          <section className="user-detail__section">
            <h2>Status</h2>
            <div className="enrichment-transitions">
              {transitionsFor(summary.status).map((t) => (
                <form
                  key={t.status}
                  action={transitionEnrichmentSummaryAction.bind(null, summary.id, t.status)}
                >
                  <button
                    type="submit"
                    className={
                      t.status === 'archived'
                        ? 'user-detail__action-button user-detail__action-button--danger'
                        : 'user-detail__action-button'
                    }
                  >
                    {t.label}
                  </button>
                </form>
              ))}
            </div>
          </section>

          <section className="user-detail__section">
            <h2>Edit</h2>
            <form
              action={editEnrichmentSummaryAction.bind(null, summary.id)}
              className="user-detail__action-form concierge-event-update"
            >
              <label className="user-detail__action-label">
                <span>Headline</span>
                <input name="headline" defaultValue={summary.headline} />
              </label>
              <label className="user-detail__action-label">
                <span>Visit highlights</span>
                <textarea name="visitHighlights" rows={3} defaultValue={summary.visitHighlights} />
              </label>
              <label className="user-detail__action-label">
                <span>Wellness signals</span>
                <textarea name="wellnessSignals" rows={3} defaultValue={summary.wellnessSignals} />
              </label>
              <label className="user-detail__action-label">
                <span>Social engagement</span>
                <textarea
                  name="socialEngagement"
                  rows={3}
                  defaultValue={summary.socialEngagement}
                />
              </label>
              <label className="user-detail__action-label">
                <span>Additional notes</span>
                <textarea
                  name="additionalNotes"
                  rows={2}
                  defaultValue={summary.additionalNotes ?? ''}
                />
              </label>
              <button type="submit" className="user-detail__action-button">
                Save changes
              </button>
            </form>
          </section>
        </>
      )}
    </>
  );
}

function NarrativeSection({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}): React.JSX.Element {
  return (
    <div className="enrichment-section">
      <h3 className="enrichment-section__title">{title}</h3>
      <p className="enrichment-section__body">{body}</p>
    </div>
  );
}

function FactItem({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="concierge-detail__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The lifecycle buttons offered from the current status. */
function transitionsFor(
  status: ConciergeEnrichmentSummaryRecord['status'],
): readonly { readonly status: 'draft' | 'published' | 'archived'; readonly label: string }[] {
  switch (status) {
    case 'draft':
      return [
        { status: 'published', label: 'Publish to family' },
        { status: 'archived', label: 'Archive' },
      ];
    case 'published':
      return [
        { status: 'draft', label: 'Unpublish (back to draft)' },
        { status: 'archived', label: 'Archive' },
      ];
    case 'archived':
      return [
        { status: 'published', label: 'Re-publish' },
        { status: 'draft', label: 'Move to draft' },
      ];
  }
}

function statusChipClass(status: ConciergeEnrichmentSummaryRecord['status']): string {
  return status === 'published' ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
}

function formatDate(yyyymmdd: string): string {
  return new Date(`${yyyymmdd}T00:00:00.000Z`).toLocaleDateString(undefined, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Summary saved.
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      {bannerMessageFor(banner.code)}
    </p>
  );
}

function bannerMessageFor(code: string): string {
  switch (code) {
    case 'invalid-input':
      return 'The form input was invalid. Check the fields and try again.';
    case 'conflict':
      return 'That status change is not allowed right now.';
    case 'not-found':
      return "We couldn't find that summary — it may have been removed.";
    case 'bad-request':
      return 'The request was rejected as malformed. Please refresh and try again.';
    case 'service-warning':
      return 'The concierge service is briefly unreachable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please refresh and try again.';
  }
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchSummary(summaryId: string): Promise<ConciergeEnrichmentSummaryRecord | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/enrichment-summaries/${encodeURIComponent(summaryId)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = GetConciergeEnrichmentSummaryResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.summary : null;
}

function ServiceWarning(): React.JSX.Element {
  return (
    <main className="dash-main">
      <h1>We&apos;re having a moment</h1>
      <p>
        Our service is briefly unreachable. Please refresh in a few seconds — and if it persists,
        our team is already on it.
      </p>
    </main>
  );
}
