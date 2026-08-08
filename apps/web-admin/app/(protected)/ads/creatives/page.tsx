import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  CreativeReviewQueueResponseSchema,
  MeResponseSchema,
  type AdAccessibilityCheckId,
  type AdAccessibilityCheckStatus,
  type AdAccessibilityReport,
  type AdCreativeReviewItem,
  type CreativeReviewQueueResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Ads — creative review queue — Taste & See Admin',
};

/**
 * Ad-creative review queue admin surface (TS-277b; PRD §10.9; PDD §18.3 —
 * "Compliance & Approval"). The web-admin half of the TS-277a backend: a FIFO
 * queue of `pending_review` creatives (oldest first), each rendered with its LIVE
 * accessibility report (per-check pass / fail / n-a + the WCAG contrast ratio) and
 * its campaign context, drilling into a review-detail page.
 *
 * **Permission gate.** The queue + detail GET endpoints (and the approve / reject /
 * request-changes decision) require `marketing:approve_creative` — a separate,
 * higher-trust gate than `ads:write` so a campaign author cannot self-approve their
 * own creative (PDD Appendix B). The page therefore gates on
 * `marketing:approve_creative`; the gateway BFF + service-ads re-enforce it
 * (defence-in-depth). The accessibility-metadata edit (the author's `ads:write`)
 * lives on the detail page, shown only for an actor who also holds `ads:write`.
 *
 * Mirrors the TS-271b / TS-272b web-admin ads surfaces.
 */
export default async function CreativeReviewQueuePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
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
  if (!hasPermission(me, 'marketing:approve_creative')) redirect('/dashboard/no-access');

  const queue = await fetchQueue();

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Ads creative review</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/dashboard" className="dash-logout">
            Back to console
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Ads — creative review queue</h1>
        <p>
          Review partner- and provider-submitted creatives before they become deliverable. Each
          creative carries an accessibility report — alt text, WCAG contrast, reduced-motion safety,
          and the mandatory &ldquo;Sponsored&rdquo; disclosure. Approving a creative whose report
          fails requires an explicit, audited override. Gated on{' '}
          <code>marketing:approve_creative</code>.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Pending review</h2>
          {queue === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load the review queue right now. The ads service may be unreachable.
            </p>
          ) : (
            <QueueList queue={queue} />
          )}
        </section>
      </main>
    </div>
  );
}

function QueueList({ queue }: { readonly queue: CreativeReviewQueueResponse }): React.JSX.Element {
  if (queue.items.length === 0) {
    return (
      <div className="user-empty">
        <p>The review queue is empty — no creatives are awaiting review.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {queue.items.map((item) => (
        <QueueRow key={item.creative.id} item={item} />
      ))}
    </ul>
  );
}

function QueueRow({ item }: { readonly item: AdCreativeReviewItem }): React.JSX.Element {
  const { creative, campaign, accessibility } = item;
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <Link
          href={`/ads/creatives/${encodeURIComponent(creative.id)}`}
          className="concierge-event-card__title"
        >
          {creative.headline}
        </Link>
        <span className="user-row__chip">{formatLabel(creative.kind)}</span>
        <AccessibilityVerdictChip report={accessibility} />
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Campaign">
          {campaign.name}{' '}
          <span className="user-row__chip">{formatLabel(campaign.advertiserKind)}</span>
        </FactItem>
        {creative.body !== null && <FactItem label="Body">{creative.body}</FactItem>}
        <FactItem label="Submitted">{formatDateTime(creative.createdAt)}</FactItem>
      </dl>
      <AccessibilityChecks report={accessibility} />
      <p className="user-detail__hint">
        <Link href={`/ads/creatives/${encodeURIComponent(creative.id)}`}>Open review →</Link>
      </p>
    </li>
  );
}

// ─── Accessibility rendering (shared shape with the detail page) ────────────────

function AccessibilityVerdictChip({
  report,
}: {
  readonly report: AdAccessibilityReport;
}): React.JSX.Element {
  return report.passed ? (
    <span className="user-row__chip user-row__chip--ok">Accessibility OK</span>
  ) : (
    <span className="user-row__chip user-row__chip--warn">Accessibility action needed</span>
  );
}

function AccessibilityChecks({
  report,
}: {
  readonly report: AdAccessibilityReport;
}): React.JSX.Element {
  return (
    <ul className="concierge-event-list">
      {report.checks.map((check) => (
        <li key={check.id} className="user-detail__hint">
          <span className={checkChipClass(check.status)}>{formatCheckStatus(check.status)}</span>{' '}
          <strong>{CHECK_LABEL[check.id]}</strong> — {check.detail}
        </li>
      ))}
    </ul>
  );
}

const CHECK_LABEL: Record<AdAccessibilityCheckId, string> = {
  alt_text_present: 'Alt text',
  contrast_ratio: 'Contrast ratio',
  motion_safe: 'Motion safety',
  disclosure_acknowledged: 'Sponsored disclosure',
};

function checkChipClass(status: AdAccessibilityCheckStatus): string {
  switch (status) {
    case 'pass':
      return 'user-row__chip user-row__chip--ok';
    case 'fail':
      return 'user-row__chip user-row__chip--warn';
    case 'not_applicable':
      return 'user-row__chip';
  }
}

function formatCheckStatus(status: AdAccessibilityCheckStatus): string {
  switch (status) {
    case 'pass':
      return 'Pass';
    case 'fail':
      return 'Fail';
    case 'not_applicable':
      return 'N/A';
  }
}

// ─── Shared ───────────────────────────────────────────────────────────────────

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

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
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
        Decision recorded.
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      Something went wrong. Please refresh and try again.
    </p>
  );
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchQueue(): Promise<CreativeReviewQueueResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/ads/creatives/review-queue');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = CreativeReviewQueueResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
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
