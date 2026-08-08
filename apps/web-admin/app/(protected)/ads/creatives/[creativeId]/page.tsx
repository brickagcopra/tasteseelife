import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  CreativeReviewDetailResponseSchema,
  MeResponseSchema,
  type AdAccessibilityCheckId,
  type AdAccessibilityCheckStatus,
  type AdAccessibilityReport,
  type AdCreativeAccessibilityMetadata,
  type AdCreativeReviewItem,
  type AdCreativeReviewRecord,
  type MeResponse,
  type ResolvedMediaAsset,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { resolveAssetKeys } from '@/lib/media-preview';
import { MediaPreviewGrid, MediaPreviewTruncationNotice } from '../../../_components/media-preview';
import { reviewCreativeAction, updateAccessibilityAction } from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Creative review — Taste & See Admin',
};

/**
 * Ad-creative review-detail surface (TS-277b; PRD §10.9; PDD §18.3). Hydrates one
 * creative under review with its LIVE accessibility report, the declared
 * accessibility metadata, and its append-only decision history, and exposes the
 * three mutations the TS-277a backend offers:
 *
 *   - edit the accessibility metadata (alt text / colours / motion / disclosure) —
 *     the author's `ads:write` affordance, shown only for an actor holding it.
 *   - approve / reject / request-changes — the reviewer's
 *     `marketing:approve_creative` decision. Rejecting / requesting changes
 *     requires a note; APPROVING a creative whose accessibility report FAILS
 *     requires an explicit, audited override (acknowledge + note) — the service
 *     enforces it, this surface surfaces the choice.
 *
 * Page-gated on `marketing:approve_creative` (the review GET needs it). Windows are
 * shown in UTC.
 */
export default async function CreativeReviewDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ creativeId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { creativeId } = await params;
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
  const canEditAccessibility = hasPermission(me, 'ads:write');
  // A reviewer without `media:read` gets an explicit explanation rather than an
  // empty panel — "no images here" and "you may not see the images" are the
  // difference between a creative with no assets and a broken review.
  const canPreviewMedia = hasPermission(me, 'media:read');

  const detail = await fetchDetail(creativeId);

  // TS-282-followup-5b — resolved BEFORE the accessibility section renders,
  // because the reviewer's judgement on alt text and contrast is a judgement
  // about this image. `resolveAssetKeys` never throws and never returns a short
  // list, so a media outage costs the preview and nothing else on the page.
  const previews =
    detail === null || !canPreviewMedia
      ? []
      : await resolveAssetKeys(detail.item.creative.assetKeys);

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
          <Link href="/ads/creatives" className="dash-logout">
            Back to review queue
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Creative review</h1>

        {banner !== null && <ActionBanner banner={banner} />}

        {detail === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t find that creative — it may have been removed, or the ads service is
            unreachable.
          </p>
        ) : (
          <>
            <CreativeSection item={detail.item} />
            <CreativeAssetsSection
              assetKeys={detail.item.creative.assetKeys}
              previews={previews}
              canPreview={canPreviewMedia}
            />
            <AccessibilitySection
              report={detail.item.accessibility}
              metadata={detail.item.accessibilityMetadata}
            />
            {canEditAccessibility && (
              <EditAccessibilitySection
                creativeId={detail.item.creative.id}
                metadata={detail.item.accessibilityMetadata}
              />
            )}
            <ReviewDecisionSection
              creativeId={detail.item.creative.id}
              report={detail.item.accessibility}
            />
            <ReviewHistorySection reviews={detail.reviews} />
          </>
        )}
      </main>
    </div>
  );
}

// ─── Creative facts ─────────────────────────────────────────────────────────────

function CreativeSection({ item }: { readonly item: AdCreativeReviewItem }): React.JSX.Element {
  const { creative, campaign } = item;
  return (
    <section className="user-detail__section">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{creative.headline}</span>
        <span className={creativeStatusChipClass(creative.status)}>
          {formatLabel(creative.status)}
        </span>
        <span className="user-row__chip">{formatLabel(creative.kind)}</span>
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Campaign">
          <Link href={`/ads/campaigns/${encodeURIComponent(campaign.id)}`}>{campaign.name}</Link>{' '}
          <span className="user-row__chip">{formatLabel(campaign.advertiserKind)}</span>
        </FactItem>
        {creative.body !== null && <FactItem label="Body">{creative.body}</FactItem>}
        {creative.ctaUrl !== null && (
          <FactItem label="CTA URL">
            <code>{creative.ctaUrl}</code>
          </FactItem>
        )}
        <FactItem label="Assets">
          {creative.assetKeys.length === 0
            ? '—'
            : `${creative.assetKeys.length} referenced — see below`}
        </FactItem>
        <FactItem label="Submitted">{formatDateTime(creative.createdAt)}</FactItem>
        <FactItem label="Updated">{formatDateTime(creative.updatedAt)}</FactItem>
      </dl>
    </section>
  );
}

// ─── Creative assets (TS-282-followup-5b) ───────────────────────────────────────

/**
 * The assets the reviewer is actually judging.
 *
 * Sits ABOVE the accessibility report on purpose: TS-277a's checks run against
 * the creative's DECLARED metadata, and the reviewer's job is to cross-check
 * that declaration against the rendered asset. Until this section existed there
 * was nothing to cross-check against — the page showed `assetKeys.join(', ')`.
 */
function CreativeAssetsSection({
  assetKeys,
  previews,
  canPreview,
}: {
  readonly assetKeys: readonly string[];
  readonly previews: readonly ResolvedMediaAsset[];
  readonly canPreview: boolean;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Assets</h2>
      {!canPreview ? (
        <>
          <p className="auth-alert auth-alert--info" role="status">
            You do not hold <code>media:read</code>, so this console cannot show you the
            creative&apos;s imagery. Approving an accessibility review without seeing the asset is
            not a decision this page can support — ask an administrator for the permission.
          </p>
          <dl className="concierge-detail__facts">
            <FactItem label="Referenced keys">
              {assetKeys.length === 0 ? '—' : assetKeys.join(', ')}
            </FactItem>
          </dl>
        </>
      ) : (
        <>
          <p className="user-detail__hint">
            Check the declared alt text, colours and motion below against what you see here. An
            asset that will not render is called out with the reason.
          </p>
          <MediaPreviewTruncationNotice shown={previews.length} total={assetKeys.length} />
          <MediaPreviewGrid
            assets={previews}
            emptyLabel="This creative references no assets. A text-only creative is legitimate — an image-bearing one that lists nothing is not."
          />
        </>
      )}
    </section>
  );
}

// ─── Accessibility report ───────────────────────────────────────────────────────

function AccessibilitySection({
  report,
  metadata,
}: {
  readonly report: AdAccessibilityReport;
  readonly metadata: AdCreativeAccessibilityMetadata;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <div className="concierge-event-card__head">
        <h2>Accessibility</h2>
        <AccessibilityVerdictChip report={report} />
      </div>
      <p className="user-detail__hint">
        Checks run against the creative&apos;s DECLARED metadata (alt text, colours, motion,
        disclosure) — a reviewer cross-checks them against the rendered asset.
      </p>
      <ul className="concierge-event-list">
        {report.checks.map((check) => (
          <li key={check.id} className="concierge-event-card">
            <div className="concierge-event-card__head">
              <span className="concierge-event-card__title">{CHECK_LABEL[check.id]}</span>
              <span className={checkChipClass(check.status)}>
                {formatCheckStatus(check.status)}
              </span>
              {check.contrastRatio !== null && (
                <span className="user-row__chip">{check.contrastRatio}:1</span>
              )}
            </div>
            <p className="user-detail__hint">{check.detail}</p>
          </li>
        ))}
      </ul>
      <dl className="concierge-detail__facts">
        <FactItem label="Declared alt text">{metadata.altText ?? '—'}</FactItem>
        <FactItem label="Declared text colour">
          <ColourFact value={metadata.textColor} />
        </FactItem>
        <FactItem label="Declared background colour">
          <ColourFact value={metadata.backgroundColor} />
        </FactItem>
        <FactItem label="Reduced-motion safe">{metadata.motionSafe ? 'Yes' : 'No'}</FactItem>
        <FactItem label="Disclosure acknowledged">
          {metadata.disclosureAcknowledged ? 'Yes' : 'No'}
        </FactItem>
      </dl>
    </section>
  );
}

function ColourFact({ value }: { readonly value: string | null }): React.JSX.Element {
  if (value === null) return <>—</>;
  return (
    <span>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: '0.85em',
          height: '0.85em',
          borderRadius: '2px',
          border: '1px solid var(--ink-soft)',
          background: value,
          verticalAlign: 'middle',
          marginRight: '0.4em',
        }}
      />
      <code>{value}</code>
    </span>
  );
}

// ─── Accessibility metadata edit ────────────────────────────────────────────────

function EditAccessibilitySection({
  creativeId,
  metadata,
}: {
  readonly creativeId: string;
  readonly metadata: AdCreativeAccessibilityMetadata;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Edit accessibility metadata</h2>
      <p className="user-detail__hint">
        Declare the asset&apos;s alt text and colours so the contrast check can run. Leave a colour
        blank to clear it. Image-bearing creatives (banner, sponsored content, partner card) must
        clear WCAG AA contrast (4.5:1).
      </p>
      <form
        action={updateAccessibilityAction.bind(null, creativeId)}
        className="user-detail__action-form concierge-event-form"
      >
        <label className="user-detail__action-label">
          <span>Alt text (blank clears)</span>
          <input
            name="altText"
            defaultValue={metadata.altText ?? ''}
            placeholder="Chef Aria plating a meal"
          />
        </label>
        <label className="user-detail__action-label">
          <span>Text colour (hex, e.g. #1a2b3c — blank clears)</span>
          <input
            name="textColor"
            defaultValue={metadata.textColor ?? ''}
            placeholder="#1a2b3c"
            pattern="#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})"
          />
        </label>
        <label className="user-detail__action-label">
          <span>Background colour (hex — blank clears)</span>
          <input
            name="backgroundColor"
            defaultValue={metadata.backgroundColor ?? ''}
            placeholder="#ffffff"
            pattern="#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})"
          />
        </label>
        <label className="user-detail__action-checkbox">
          <input type="checkbox" name="motionSafe" defaultChecked={metadata.motionSafe} />
          <span>Reduced-motion safe (no autoplay or flashing)</span>
        </label>
        <label className="user-detail__action-checkbox">
          <input
            type="checkbox"
            name="disclosureAcknowledged"
            defaultChecked={metadata.disclosureAcknowledged}
          />
          <span>&ldquo;Sponsored&rdquo; disclosure acknowledged</span>
        </label>
        <button type="submit" className="user-detail__action-button">
          Save accessibility metadata
        </button>
      </form>
    </section>
  );
}

// ─── Review decision ────────────────────────────────────────────────────────────

function ReviewDecisionSection({
  creativeId,
  report,
}: {
  readonly creativeId: string;
  readonly report: AdAccessibilityReport;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Decision</h2>
      <p className="user-detail__hint">
        Approve to make the creative deliverable, reject to bounce it, or request changes to return
        it to draft for the author. A note is required to reject or request changes.
      </p>
      {!report.passed && (
        <p className="auth-alert auth-alert--info" role="status">
          This creative&apos;s accessibility report FAILS. Approving it anyway is an audited
          override — tick &ldquo;acknowledge accessibility failures&rdquo; and explain why in the
          note.
        </p>
      )}
      <form
        action={reviewCreativeAction.bind(null, creativeId)}
        className="user-detail__action-form concierge-event-form"
      >
        <label className="user-detail__action-label">
          <span>Action</span>
          <select name="action" defaultValue="approve">
            <option value="approve">Approve (→ approved, deliverable)</option>
            <option value="reject">Reject (→ rejected)</option>
            <option value="request_changes">Request changes (→ draft)</option>
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Note (required to reject / request changes)</span>
          <textarea name="notes" rows={3} placeholder="Reason returned to the author…" />
        </label>
        <label className="user-detail__action-checkbox">
          <input type="checkbox" name="acknowledgeAccessibilityFailures" />
          <span>
            Acknowledge accessibility failures (audited override to approve a failing report)
          </span>
        </label>
        <button type="submit" className="user-detail__action-button">
          Record decision
        </button>
      </form>
    </section>
  );
}

// ─── Review history ─────────────────────────────────────────────────────────────

function ReviewHistorySection({
  reviews,
}: {
  readonly reviews: readonly AdCreativeReviewRecord[];
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Decision history</h2>
      {reviews.length === 0 ? (
        <div className="user-empty">
          <p>No decisions have been recorded for this creative yet.</p>
        </div>
      ) : (
        <ul className="concierge-event-list">
          {reviews.map((review) => (
            <li key={review.id} className="concierge-event-card">
              <div className="concierge-event-card__head">
                <span className="concierge-event-card__title">{formatLabel(review.decision)}</span>
                <span
                  className={
                    review.accessibilityPassed
                      ? 'user-row__chip user-row__chip--ok'
                      : 'user-row__chip user-row__chip--warn'
                  }
                >
                  {review.accessibilityPassed ? 'Accessibility OK' : 'Accessibility failed'}
                </span>
                {review.overrodeAccessibility && (
                  <span className="user-row__chip user-row__chip--warn">Override</span>
                )}
              </div>
              <dl className="concierge-detail__facts">
                <FactItem label="Reviewer">
                  <code>{review.reviewerUserId}</code>
                </FactItem>
                {review.notes !== null && <FactItem label="Note">{review.notes}</FactItem>}
                <FactItem label="Recorded">{formatDateTime(review.createdAt)}</FactItem>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Accessibility rendering helpers ────────────────────────────────────────────

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

function creativeStatusChipClass(status: string): string {
  return status === 'approved' ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
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
        Saved.
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
      return 'The input was invalid. Check the fields (colours must be hex like #1a2b3c; a note is required to reject or request changes; approving a failing accessibility report requires the acknowledge checkbox) and try again.';
    case 'conflict':
      return 'That decision is not allowed from the creative’s current state. Reload and try again.';
    case 'not-found':
      return 'That creative no longer exists. It may have been removed.';
    case 'bad-request':
      return 'The request was rejected as malformed. Please refresh and try again.';
    case 'service-warning':
      return 'The ads service is briefly unreachable. Please try again in a moment.';
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

async function fetchDetail(
  creativeId: string,
): Promise<{ item: AdCreativeReviewItem; reviews: readonly AdCreativeReviewRecord[] } | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/ads/creatives/${encodeURIComponent(creativeId)}/review`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = CreativeReviewDetailResponseSchema.safeParse(result.body);
  return parsed.success ? { item: parsed.data.item, reviews: parsed.data.reviews } : null;
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
