import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdCampaignsListResponseSchema,
  MeResponseSchema,
  type AdCampaignRecord,
  type AdCampaignsListResponse,
  type AdCampaignStatus,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { createCampaignAction } from './actions';
import { readBanner, readEnum, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Ads — campaign management — Taste & See Admin',
};

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
] as const;

const INITIAL_STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft (compose buffer)' },
  { value: 'scheduled', label: 'Scheduled (approved + dated)' },
  { value: 'active', label: 'Active (live immediately)' },
] as const;

const ADVERTISER_KIND_OPTIONS = [
  { value: 'provider', label: 'Provider (sponsored listing)' },
  { value: 'partner', label: 'Partner (co-marketing)' },
  { value: 'internal', label: 'Internal (house ad)' },
] as const;

const CREATIVE_KIND_OPTIONS = [
  { value: 'sponsored_listing', label: 'Sponsored listing' },
  { value: 'banner', label: 'Banner' },
  { value: 'sponsored_content', label: 'Sponsored content' },
  { value: 'partner_card', label: 'Partner card' },
] as const;

const CREATIVE_STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'pending_review', label: 'Pending review (submit on create)' },
] as const;

const TARGETING_KIND_OPTIONS = [
  { value: '', label: 'No targeting rule (delivers to everyone)' },
  { value: 'geography', label: 'Geography' },
  { value: 'persona', label: 'Persona' },
  { value: 'tier', label: 'Subscription tier' },
  { value: 'behavior_cohort', label: 'Behaviour cohort' },
  { value: 'household_composition', label: 'Household composition' },
] as const;

const TARGETING_OPERATOR_OPTIONS = [
  { value: 'any_of', label: 'any_of (audience matches any value)' },
  { value: 'none_of', label: 'none_of (audience matches no value)' },
  { value: 'all_of', label: 'all_of (audience holds every value)' },
] as const;

const VALID_STATUSES = new Set<string>(STATUS_OPTIONS.map((s) => s.value));
const VALID_ADVERTISER_KINDS = new Set<string>(ADVERTISER_KIND_OPTIONS.map((k) => k.value));

/**
 * Ad-campaign management admin surface (TS-271b; PRD §10.9; PDD §18.1, §8.2).
 * The web-admin half of the TS-271a backend: list campaigns (filtered by status /
 * advertiser kind), create a campaign with an optional initial creative + a single
 * targeting rule, and drill into a campaign's editor.
 *
 * Permission-gated on `ads:read`; the create form renders only for an actor
 * holding `ads:write` (the gateway BFF + service-ads enforce the gate — this is a
 * UI-affordance gate). Mirrors the TS-251 academy course-catalog surface.
 *
 * The TS-271a backend sets a campaign's creatives + targeting rules only at
 * create time (no add-after-create endpoint); the editor manages campaign scalars
 * + status and each creative's review status. Richer post-create creative / rule
 * management + media-svc asset upload are the carved TS-271b followups.
 */
export default async function AdsCampaignsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);
  const filterStatus = readEnum(search, 'status', VALID_STATUSES);
  const filterAdvertiserKind = readEnum(search, 'advertiserKind', VALID_ADVERTISER_KINDS);

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

  const list = await fetchCampaigns(filterStatus, filterAdvertiserKind);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Ads campaign management</span>
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
        <h1>Ads — campaign management</h1>
        <p>
          Create and manage in-app ad campaigns — sponsored provider listings, banners, and partner
          co-marketing slots. A campaign carries its creatives and targeting rules; only an{' '}
          <code>approved</code> creative is deliverable, and campaigns move draft &rarr; scheduled
          &rarr; active &rarr; paused / completed &rarr; archived.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Filter</h2>
          <form
            action="/ads/campaigns"
            method="GET"
            className="user-detail__action-form concierge-event-filter"
          >
            <label className="user-detail__action-label">
              <span>Status</span>
              <select name="status" defaultValue={filterStatus ?? ''}>
                <option value="">All statuses</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="user-detail__action-label">
              <span>Advertiser kind</span>
              <select name="advertiserKind" defaultValue={filterAdvertiserKind ?? ''}>
                <option value="">All advertiser kinds</option>
                {ADVERTISER_KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="user-detail__action-button">
              Apply
            </button>
          </form>
        </section>

        {canWrite && (
          <section className="user-detail__section">
            <h2>Create a campaign</h2>
            <CreateCampaignForm />
          </section>
        )}

        <section className="user-detail__section">
          <h2>Campaigns</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load campaigns right now. The ads service may be unreachable.
            </p>
          ) : (
            <CampaignList list={list} />
          )}
        </section>
      </main>
    </div>
  );
}

function CampaignList({ list }: { readonly list: AdCampaignsListResponse }): React.JSX.Element {
  if (list.campaigns.length === 0) {
    return (
      <div className="user-empty">
        <p>No campaigns match this view.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.campaigns.map((campaign) => (
        <CampaignRow key={campaign.id} campaign={campaign} />
      ))}
    </ul>
  );
}

function CampaignRow({ campaign }: { readonly campaign: AdCampaignRecord }): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <Link
          href={`/ads/campaigns/${encodeURIComponent(campaign.id)}`}
          className="concierge-event-card__title"
        >
          {campaign.name}
        </Link>
        <span className={statusChipClass(campaign.status)}>{formatLabel(campaign.status)}</span>
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
        {campaign.startAt !== null && (
          <FactItem label="Starts">{formatDateTime(campaign.startAt)}</FactItem>
        )}
        {campaign.endAt !== null && (
          <FactItem label="Ends">{formatDateTime(campaign.endAt)}</FactItem>
        )}
        <FactItem label="Updated">{formatDateTime(campaign.updatedAt)}</FactItem>
      </dl>
      <p className="user-detail__hint">
        <Link href={`/ads/campaigns/${encodeURIComponent(campaign.id)}`}>
          Open campaign editor →
        </Link>
      </p>
    </li>
  );
}

function CreateCampaignForm(): React.JSX.Element {
  return (
    <form action={createCampaignAction} className="user-detail__action-form concierge-event-form">
      <label className="user-detail__action-label">
        <span>Name</span>
        <input name="name" required placeholder="Spring sponsored chefs" />
      </label>
      <label className="user-detail__action-label">
        <span>Advertiser kind</span>
        <select name="advertiserKind" defaultValue={ADVERTISER_KIND_OPTIONS[0].value}>
          {ADVERTISER_KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Advertiser id (provider / partner row id — leave blank for internal)</span>
        <input name="advertiserId" placeholder="prv_… / ptn_…" />
      </label>
      <label className="user-detail__action-label">
        <span>Budget (USD, optional — blank = uncapped)</span>
        <input name="budgetUsd" inputMode="decimal" placeholder="5000.00" />
      </label>
      <label className="user-detail__action-label">
        <span>Starts at (UTC, optional)</span>
        <input type="datetime-local" name="startAt" />
      </label>
      <label className="user-detail__action-label">
        <span>Ends at (UTC, optional)</span>
        <input type="datetime-local" name="endAt" />
      </label>
      <label className="user-detail__action-label">
        <span>Initial status</span>
        <select name="status" defaultValue="draft">
          {INITIAL_STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="concierge-event-form__group">
        <legend>Initial creative (optional — add a headline to include one)</legend>
        <label className="user-detail__action-label">
          <span>Creative kind</span>
          <select name="creativeKind" defaultValue={CREATIVE_KIND_OPTIONS[0].value}>
            {CREATIVE_KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Headline</span>
          <input name="creativeHeadline" placeholder="Meet chef Aria" />
        </label>
        <label className="user-detail__action-label">
          <span>Body (optional)</span>
          <textarea name="creativeBody" rows={2} placeholder="Supporting copy…" />
        </label>
        <label className="user-detail__action-label">
          <span>Click-through URL (optional)</span>
          <input name="creativeCtaUrl" placeholder="https://…" />
        </label>
        <label className="user-detail__action-label">
          <span>Creative status</span>
          <select name="creativeStatus" defaultValue="draft">
            {CREATIVE_STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="concierge-event-form__group">
        <legend>Targeting rule (optional — pick a kind + values to include one)</legend>
        <label className="user-detail__action-label">
          <span>Targeting kind</span>
          <select name="targetingKind" defaultValue="">
            {TARGETING_KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Operator</span>
          <select name="targetingOperator" defaultValue={TARGETING_OPERATOR_OPTIONS[0].value}>
            {TARGETING_OPERATOR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Values (comma-separated tokens, e.g. NYC, BOS)</span>
          <input name="targetingValues" placeholder="tier_3, NYC" />
        </label>
      </fieldset>

      <button type="submit" className="user-detail__action-button">
        Create campaign
      </button>
    </form>
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

function statusChipClass(status: AdCampaignStatus): string {
  return status === 'active' ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
}

/** Float-free minor-units → `$X.YY` presentation (CLAUDE.md §6 — round once at presentation). */
function formatMinorUsd(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
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
        Campaign saved.
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
      return 'The form input was invalid. Check the fields (an advertiser id is required for provider / partner campaigns; budget must be a dollar amount) and try again.';
    case 'conflict':
      return 'That change conflicts with the campaign’s current state (an illegal status transition). Reload and try again.';
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

async function fetchCampaigns(
  status: string | undefined,
  advertiserKind: string | undefined,
): Promise<AdCampaignsListResponse | null> {
  const params = new URLSearchParams();
  if (status !== undefined) params.set('status', status);
  if (advertiserKind !== undefined) params.set('advertiserKind', advertiserKind);
  const qs = params.toString();
  const result = await callGateway<unknown>(
    `/api/v1/admin/ads/campaigns${qs.length > 0 ? `?${qs}` : ''}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdCampaignsListResponseSchema.safeParse(result.body);
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
