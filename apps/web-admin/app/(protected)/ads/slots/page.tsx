import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdPlacementsListResponseSchema,
  AdSlotSchedulesListResponseSchema,
  MeResponseSchema,
  type AdPlacementRecord,
  type AdPlacementsListResponse,
  type AdSlotScheduleRecord,
  type AdSlotSchedulesListResponse,
  type AdSlotScheduleStatus,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { createScheduleAction } from './actions';
import { readBanner, readEnum, readString, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Ads — slot inventory — Taste & See Admin',
};

const STATUS_OPTIONS = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
] as const;

const INITIAL_STATUS_OPTIONS = [
  { value: 'scheduled', label: 'Scheduled (booked, awaiting its window)' },
  { value: 'active', label: 'Active (delivers immediately)' },
] as const;

const VALID_STATUSES = new Set<string>(STATUS_OPTIONS.map((s) => s.value));

/**
 * Slot-inventory (slot-scheduling) admin surface (TS-272b; PRD §10.9 "Inventory
 * management (slot scheduling)"; PDD §18.1, §8.2). The web-admin half of the
 * TS-272a backend: list the seeded placements (read-only catalog), list slot
 * schedules (filtered by placement / campaign / status), book a campaign into a
 * placement over a delivery window, and drill into a schedule's editor.
 *
 * Permission-gated on `ads:read`; the create form renders only for an actor
 * holding `ads:write` (the gateway BFF + service-ads enforce the gate — this is
 * a UI-affordance gate). Mirrors the TS-271b ad-campaign surface.
 *
 * A schedule is the inventory binding only — budget + targeting live on the
 * campaign aggregate (TS-271a), so there is no money field here. The campaign a
 * schedule binds is referenced by id; manage it under Ads → campaigns.
 */
export default async function AdsSlotsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);
  const filterStatus = readEnum(search, 'status', VALID_STATUSES);
  const filterCampaignId = readString(search, 'campaignId');

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

  const placements = await fetchPlacements();
  const filterPlacementId = readEnum(
    search,
    'placementId',
    new Set<string>((placements ?? { placements: [] }).placements.map((p) => p.id)),
  );
  const list = await fetchSchedules(filterPlacementId, filterCampaignId, filterStatus);

  const slotCodeById = new Map<string, string>(
    (placements ?? { placements: [] }).placements.map((p) => [p.id, p.slotCode]),
  );

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Ads slot inventory</span>
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
        <h1>Ads — slot inventory</h1>
        <p>
          Schedule which campaign occupies each predefined UI slot, and over what window. A schedule
          binds a campaign into a placement; overlapping schedules on the same slot are served in{' '}
          <code>priority</code> order (higher first). Budgets and targeting live on the{' '}
          <Link href="/ads/campaigns">campaign</Link>.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Placements (seeded slot catalog)</h2>
          {placements === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load the placement catalog right now. The ads service may be
              unreachable.
            </p>
          ) : (
            <PlacementList list={placements} />
          )}
        </section>

        <section className="user-detail__section">
          <h2>Filter</h2>
          <form
            action="/ads/slots"
            method="GET"
            className="user-detail__action-form concierge-event-filter"
          >
            <label className="user-detail__action-label">
              <span>Placement</span>
              <select name="placementId" defaultValue={filterPlacementId ?? ''}>
                <option value="">All placements</option>
                {(placements ?? { placements: [] }).placements.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.slotCode}
                  </option>
                ))}
              </select>
            </label>
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
              <span>Campaign id</span>
              <input name="campaignId" defaultValue={filterCampaignId ?? ''} placeholder="cmp_…" />
            </label>
            <button type="submit" className="user-detail__action-button">
              Apply
            </button>
          </form>
        </section>

        {canWrite && (
          <section className="user-detail__section">
            <h2>Schedule a campaign into a slot</h2>
            {placements === null || placements.placements.length === 0 ? (
              <p className="user-detail__hint">
                No placements are available to schedule into — the slot catalog must be seeded first
                (<code>seed:placements</code>).
              </p>
            ) : (
              <CreateScheduleForm placements={placements.placements} />
            )}
          </section>
        )}

        <section className="user-detail__section">
          <h2>Schedules</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load schedules right now. The ads service may be unreachable.
            </p>
          ) : (
            <ScheduleList list={list} slotCodeById={slotCodeById} />
          )}
        </section>
      </main>
    </div>
  );
}

function PlacementList({ list }: { readonly list: AdPlacementsListResponse }): React.JSX.Element {
  if (list.placements.length === 0) {
    return (
      <div className="user-empty">
        <p>No placements are seeded yet. Run the placement seed to populate the slot catalog.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.placements.map((placement) => (
        <PlacementRow key={placement.id} placement={placement} />
      ))}
    </ul>
  );
}

function PlacementRow({ placement }: { readonly placement: AdPlacementRecord }): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{placement.slotCode}</span>
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Supported creative kinds">
          {placement.supportedCreativeKinds.length === 0
            ? '—'
            : placement.supportedCreativeKinds.map(formatLabel).join(', ')}
        </FactItem>
        <FactItem label="Placement id">
          <code>{placement.id}</code>
        </FactItem>
      </dl>
    </li>
  );
}

function ScheduleList({
  list,
  slotCodeById,
}: {
  readonly list: AdSlotSchedulesListResponse;
  readonly slotCodeById: ReadonlyMap<string, string>;
}): React.JSX.Element {
  if (list.schedules.length === 0) {
    return (
      <div className="user-empty">
        <p>No schedules match this view.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.schedules.map((schedule) => (
        <ScheduleRow
          key={schedule.id}
          schedule={schedule}
          slotCode={slotCodeById.get(schedule.placementId)}
        />
      ))}
    </ul>
  );
}

function ScheduleRow({
  schedule,
  slotCode,
}: {
  readonly schedule: AdSlotScheduleRecord;
  readonly slotCode: string | undefined;
}): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <Link
          href={`/ads/slots/${encodeURIComponent(schedule.id)}`}
          className="concierge-event-card__title"
        >
          {slotCode ?? schedule.placementId}
        </Link>
        <span className={statusChipClass(schedule.status)}>{formatLabel(schedule.status)}</span>
        <span className="user-row__chip">priority {schedule.priority}</span>
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Campaign">
          <code>{schedule.campaignId}</code>
        </FactItem>
        <FactItem label="Starts">{formatDateTime(schedule.startAt)}</FactItem>
        <FactItem label="Ends">
          {schedule.endAt === null ? 'Open-ended' : formatDateTime(schedule.endAt)}
        </FactItem>
        <FactItem label="Updated">{formatDateTime(schedule.updatedAt)}</FactItem>
      </dl>
      <p className="user-detail__hint">
        <Link href={`/ads/slots/${encodeURIComponent(schedule.id)}`}>Open schedule editor →</Link>
      </p>
    </li>
  );
}

function CreateScheduleForm({
  placements,
}: {
  readonly placements: readonly AdPlacementRecord[];
}): React.JSX.Element {
  return (
    <form action={createScheduleAction} className="user-detail__action-form concierge-event-form">
      <label className="user-detail__action-label">
        <span>Placement</span>
        <select name="placementId" defaultValue={placements[0]?.id ?? ''}>
          {placements.map((p) => (
            <option key={p.id} value={p.id}>
              {p.slotCode}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Campaign id (from Ads → campaigns)</span>
        <input name="campaignId" required placeholder="cmp_…" />
      </label>
      <label className="user-detail__action-label">
        <span>Starts at (UTC)</span>
        <input type="datetime-local" name="startAt" required />
      </label>
      <label className="user-detail__action-label">
        <span>Ends at (UTC, optional — blank = open-ended)</span>
        <input type="datetime-local" name="endAt" />
      </label>
      <label className="user-detail__action-label">
        <span>Priority (0–1000, higher served first)</span>
        <input
          name="priority"
          type="number"
          inputMode="numeric"
          min={0}
          max={1000}
          defaultValue={0}
        />
      </label>
      <label className="user-detail__action-label">
        <span>Initial status</span>
        <select name="status" defaultValue="scheduled">
          {INITIAL_STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="user-detail__action-button">
        Schedule
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

function statusChipClass(status: AdSlotScheduleStatus): string {
  return status === 'active' ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
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
        Schedule saved.
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
      return 'The form input was invalid. Check the fields (a campaign id and a valid start date are required; ends-at must be after starts-at; priority is 0–1000) and try again.';
    case 'not-found':
      return 'The placement or campaign could not be found. Confirm the campaign id exists and try again.';
    case 'conflict':
      return 'That change conflicts with the schedule’s current state. Reload and try again.';
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

async function fetchPlacements(): Promise<AdPlacementsListResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/ads/placements');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdPlacementsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchSchedules(
  placementId: string | undefined,
  campaignId: string | undefined,
  status: string | undefined,
): Promise<AdSlotSchedulesListResponse | null> {
  const params = new URLSearchParams();
  if (placementId !== undefined) params.set('placementId', placementId);
  if (campaignId !== undefined) params.set('campaignId', campaignId);
  if (status !== undefined) params.set('status', status);
  const qs = params.toString();
  const result = await callGateway<unknown>(
    `/api/v1/admin/ads/slot-schedules${qs.length > 0 ? `?${qs}` : ''}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdSlotSchedulesListResponseSchema.safeParse(result.body);
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
