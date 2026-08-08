import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AD_CAMPAIGN_STATUS_TRANSITIONS,
  AD_CREATIVE_STATUS_TRANSITIONS,
  AdCampaignDetailResponseSchema,
  MeResponseSchema,
  type AdCampaignDetail,
  type AdCampaignStatus,
  type AdCreativeRecord,
  type AdCreativeStatus,
  type AdTargetingRuleRecord,
  type MeResponse,
  type ResolvedMediaAsset,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { resolveAssetKeysBatched } from '@/lib/media-preview';
import { CreativeAssetThumb } from '../../../_components/media-preview';
import {
  transitionCampaignAction,
  updateCampaignAction,
  updateCreativeStatusAction,
} from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Campaign editor — Taste & See Admin',
};

const CAMPAIGN_STATUS_ACTION_LABEL: Record<AdCampaignStatus, string> = {
  draft: 'Move to draft',
  scheduled: 'Schedule',
  active: 'Activate',
  paused: 'Pause',
  completed: 'Mark completed',
  archived: 'Archive',
};

const CREATIVE_STATUS_ACTION_LABEL: Record<AdCreativeStatus, string> = {
  draft: 'Move to draft',
  pending_review: 'Submit for review',
  approved: 'Approve',
  rejected: 'Reject',
  archived: 'Archive',
};

const DANGER_CAMPAIGN_STATUSES = new Set<AdCampaignStatus>(['archived']);
const DANGER_CREATIVE_STATUSES = new Set<AdCreativeStatus>(['rejected', 'archived']);

/**
 * Ad-campaign editor (TS-271b; PRD §10.9; PDD §18.1, §8.2). Hydrates a campaign
 * with its creatives + targeting rules and exposes every mutation the TS-271a
 * backend offers: edit the campaign scalars, drive it through its status matrix,
 * and advance each creative through its review lifecycle.
 *
 * Permission-gated on `ads:read`; write affordances render only for an actor
 * holding `ads:write`. Windows + budgets are entered + shown in UTC / USD.
 *
 * The TS-271a backend sets a campaign's creatives + targeting rules only at create
 * time (no add-after-create endpoint), so this editor shows targeting rules
 * read-only and manages creative status only. Post-create creative / rule
 * management + media-svc asset upload are the carved TS-271b followups.
 */
export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { campaignId } = await params;
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
  if (!hasPermission(me, 'ads:read')) redirect('/dashboard/no-access');
  const canWrite = hasPermission(me, 'ads:write');

  const campaign = await fetchCampaign(campaignId);

  // TS-282-followup-5b-followup-2 — ONE key per creative (the hero), batched
  // across the whole page. Resolving every asset of every creative would be up
  // to 200 keys; this surface is a summary, and the review page is where the
  // full set is judged.
  const canPreviewMedia = hasPermission(me, 'media:read');
  const heroKeys =
    campaign === null || !canPreviewMedia
      ? []
      : campaign.creatives.map((c) => c.assetKeys[0]).filter((k): k is string => k !== undefined);
  const resolved = heroKeys.length === 0 ? null : await resolveAssetKeysBatched(heroKeys);
  const previews = new Map((resolved?.assets ?? []).map((a) => [a.assetKey, a]));

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Ads campaign editor</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/ads/campaigns" className="dash-logout">
            Back to campaigns
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Campaign editor</h1>

        {banner !== null && <ActionBanner banner={banner} />}

        {campaign === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t find that campaign — it may have been removed, or the ads service is
            unreachable.
          </p>
        ) : (
          <>
            <CampaignSection campaign={campaign} canWrite={canWrite} />
            <CreativesSection
              campaign={campaign}
              canWrite={canWrite}
              previews={previews}
              canPreview={canPreviewMedia}
            />
            <TargetingSection campaign={campaign} />
          </>
        )}
      </main>
    </div>
  );
}

// ─── Campaign ─────────────────────────────────────────────────────────────────

function CampaignSection({
  campaign,
  canWrite,
}: {
  readonly campaign: AdCampaignDetail;
  readonly canWrite: boolean;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{campaign.name}</span>
        <span className={campaignStatusChipClass(campaign.status)}>
          {formatLabel(campaign.status)}
        </span>
        <span className="user-row__chip">{formatLabel(campaign.advertiserKind)}</span>
      </div>
      <dl className="concierge-detail__facts">
        {campaign.advertiserId !== null && (
          <FactItem label="Advertiser">
            <code>{campaign.advertiserId}</code>
          </FactItem>
        )}
        <FactItem label="Budget">
          {campaign.budgetMinor === null
            ? 'Uncapped'
            : `${formatMinorUsd(campaign.budgetMinor)} ${campaign.currency}`}
        </FactItem>
        <FactItem label="Starts">
          {campaign.startAt === null ? '—' : formatDateTime(campaign.startAt)}
        </FactItem>
        <FactItem label="Ends">
          {campaign.endAt === null ? '—' : formatDateTime(campaign.endAt)}
        </FactItem>
        <FactItem label="Updated">{formatDateTime(campaign.updatedAt)}</FactItem>
      </dl>

      {canWrite && (
        <>
          <div className="enrichment-transitions">
            {AD_CAMPAIGN_STATUS_TRANSITIONS[campaign.status].map((to) => (
              <form key={to} action={transitionCampaignAction.bind(null, campaign.id, to)}>
                <button
                  type="submit"
                  className={
                    DANGER_CAMPAIGN_STATUSES.has(to)
                      ? 'user-detail__action-button user-detail__action-button--danger'
                      : 'user-detail__action-button'
                  }
                >
                  {CAMPAIGN_STATUS_ACTION_LABEL[to]}
                </button>
              </form>
            ))}
          </div>

          <div className="concierge-event-update">
            <h3 className="enrichment-section__title">Edit campaign</h3>
            <CampaignEditForm campaign={campaign} />
          </div>
        </>
      )}
    </section>
  );
}

function CampaignEditForm({
  campaign,
}: {
  readonly campaign: AdCampaignDetail;
}): React.JSX.Element {
  return (
    <form
      action={updateCampaignAction.bind(null, campaign.id)}
      className="user-detail__action-form concierge-event-form"
    >
      <label className="user-detail__action-label">
        <span>Name</span>
        <input name="name" defaultValue={campaign.name} required />
      </label>
      {campaign.advertiserKind !== 'internal' && (
        <label className="user-detail__action-label">
          <span>Advertiser id</span>
          <input name="advertiserId" defaultValue={campaign.advertiserId ?? ''} />
        </label>
      )}
      <label className="user-detail__action-label">
        <span>Budget (USD — blank = uncapped)</span>
        <input
          name="budgetUsd"
          inputMode="decimal"
          defaultValue={campaign.budgetMinor === null ? '' : minorToDollars(campaign.budgetMinor)}
        />
      </label>
      <label className="user-detail__action-label">
        <span>Starts at (UTC — blank clears)</span>
        <input type="datetime-local" name="startAt" defaultValue={isoToLocal(campaign.startAt)} />
      </label>
      <label className="user-detail__action-label">
        <span>Ends at (UTC — blank clears)</span>
        <input type="datetime-local" name="endAt" defaultValue={isoToLocal(campaign.endAt)} />
      </label>
      <button type="submit" className="user-detail__action-button">
        Save campaign
      </button>
    </form>
  );
}

// ─── Creatives ────────────────────────────────────────────────────────────────

/**
 * The resolved hero asset for one creative, or null when it has no assets (or
 * when the batch declined to ask about this one — see `resolveAssetKeysBatched`).
 */
function previewFor(
  creative: AdCreativeRecord,
  previews: ReadonlyMap<string, ResolvedMediaAsset>,
): ResolvedMediaAsset | null {
  const hero = creative.assetKeys[0];
  if (hero === undefined) return null;
  return previews.get(hero) ?? null;
}

function CreativesSection({
  campaign,
  canWrite,
  previews,
  canPreview,
}: {
  readonly campaign: AdCampaignDetail;
  readonly canWrite: boolean;
  readonly previews: ReadonlyMap<string, ResolvedMediaAsset>;
  readonly canPreview: boolean;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Creatives</h2>
      <p className="user-detail__hint">
        Only an <code>approved</code> creative is deliverable. Creatives are attached at campaign
        creation; asset upload + adding creatives after creation land in a follow-up.
      </p>
      {campaign.creatives.length === 0 ? (
        <div className="user-empty">
          <p>This campaign has no creatives.</p>
        </div>
      ) : (
        <ul className="concierge-event-list">
          {campaign.creatives.map((creative) => (
            <CreativeRow
              key={creative.id}
              campaignId={campaign.id}
              creative={creative}
              canWrite={canWrite}
              preview={previewFor(creative, previews)}
              canPreview={canPreview}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CreativeRow({
  campaignId,
  creative,
  canWrite,
  preview,
  canPreview,
}: {
  readonly campaignId: string;
  readonly creative: AdCreativeRecord;
  readonly canWrite: boolean;
  readonly preview: ResolvedMediaAsset | null;
  readonly canPreview: boolean;
}): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{creative.headline}</span>
        <span className={creativeStatusChipClass(creative.status)}>
          {formatLabel(creative.status)}
        </span>
        <span className="user-row__chip">{formatLabel(creative.kind)}</span>
      </div>
      <dl className="concierge-detail__facts">
        {creative.body !== null && <FactItem label="Body">{creative.body}</FactItem>}
        {creative.ctaUrl !== null && (
          <FactItem label="CTA URL">
            <code>{creative.ctaUrl}</code>
          </FactItem>
        )}
        <FactItem label="Assets">
          {/*
            TS-282-followup-5b-followup-2 — a HERO thumbnail, not the whole set.
            This page is a summary; resolving every asset of every creative
            would be up to 200 keys (20 creatives x 10). The review page
            (TS-282-followup-5b) is where a reviewer sees them all, and the
            count here says how many there are to go and see.
          */}
          {canPreview ? (
            <CreativeAssetThumb asset={preview} totalAssets={creative.assetKeys.length} />
          ) : creative.assetKeys.length === 0 ? (
            '—'
          ) : (
            // Without `media:read` this stays a key list rather than becoming a
            // blank cell — an operator who cannot see the picture should still
            // see that assets exist.
            creative.assetKeys.join(', ')
          )}
        </FactItem>
        <FactItem label="Updated">{formatDateTime(creative.updatedAt)}</FactItem>
      </dl>
      {canWrite && (
        <div className="enrichment-transitions">
          {AD_CREATIVE_STATUS_TRANSITIONS[creative.status].map((to) => (
            <form
              key={to}
              action={updateCreativeStatusAction.bind(null, campaignId, creative.id, to)}
            >
              <button
                type="submit"
                className={
                  DANGER_CREATIVE_STATUSES.has(to)
                    ? 'user-detail__action-button user-detail__action-button--danger'
                    : 'user-detail__action-button'
                }
              >
                {CREATIVE_STATUS_ACTION_LABEL[to]}
              </button>
            </form>
          ))}
        </div>
      )}
    </li>
  );
}

// ─── Targeting ────────────────────────────────────────────────────────────────

function TargetingSection({
  campaign,
}: {
  readonly campaign: AdCampaignDetail;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Targeting rules</h2>
      <p className="user-detail__hint">
        A campaign delivers to a viewer only when every rule matches (rules are AND-combined). No
        rules means the campaign delivers to everyone. Rules are read-only after creation.
      </p>
      {campaign.targetingRules.length === 0 ? (
        <div className="user-empty">
          <p>No targeting rules — this campaign delivers to everyone.</p>
        </div>
      ) : (
        <ul className="concierge-event-list">
          {campaign.targetingRules.map((rule) => (
            <TargetingRow key={rule.id} rule={rule} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TargetingRow({ rule }: { readonly rule: AdTargetingRuleRecord }): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{formatLabel(rule.kind)}</span>
        <span className="user-row__chip">{formatLabel(rule.predicate.operator)}</span>
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Values">
          <code>{rule.predicate.values.join(', ')}</code>
        </FactItem>
      </dl>
    </li>
  );
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

function campaignStatusChipClass(status: AdCampaignStatus): string {
  return status === 'active' ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
}

function creativeStatusChipClass(status: AdCreativeStatus): string {
  return status === 'approved' ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
}

/** Float-free minor-units → `$X.YY`. */
function formatMinorUsd(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Float-free minor-units → `X.YY` (form prefill, no `$`). */
function minorToDollars(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** ISO UTC → `YYYY-MM-DDTHH:MM` for a datetime-local input (empty when null). */
function isoToLocal(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 16);
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
      return 'The input was invalid. Check the fields (budget must be a dollar amount; dates must be valid) and try again.';
    case 'conflict':
      return 'That status change is not allowed from the campaign’s / creative’s current state. Reload and try again.';
    case 'not-found':
      return 'That campaign or creative no longer exists. It may have been removed.';
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

async function fetchCampaign(campaignId: string): Promise<AdCampaignDetail | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/ads/campaigns/${encodeURIComponent(campaignId)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdCampaignDetailResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.campaign : null;
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
