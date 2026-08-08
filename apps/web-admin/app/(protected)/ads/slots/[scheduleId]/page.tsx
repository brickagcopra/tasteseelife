import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AD_SLOT_SCHEDULE_STATUS_TRANSITIONS,
  AdPlacementsListResponseSchema,
  AdSlotScheduleResponseSchema,
  MeResponseSchema,
  type AdSlotScheduleRecord,
  type AdSlotScheduleStatus,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { transitionScheduleAction, updateScheduleAction } from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Slot schedule editor — Taste & See Admin',
};

const STATUS_ACTION_LABEL: Record<AdSlotScheduleStatus, string> = {
  scheduled: 'Move to scheduled',
  active: 'Activate',
  paused: 'Pause',
  completed: 'Mark completed',
  archived: 'Archive',
};

const DANGER_STATUSES = new Set<AdSlotScheduleStatus>(['archived']);

/**
 * Slot-schedule editor (TS-272b; PRD §10.9; PDD §18.1, §8.2). Hydrates a single
 * schedule and exposes the mutations the TS-272a backend offers: edit the
 * delivery window + priority, and drive the schedule through its status matrix.
 *
 * Permission-gated on `ads:read`; write affordances render only for an actor
 * holding `ads:write`. Windows are entered + shown in UTC.
 *
 * The placement and campaign a schedule binds are immutable (rebinding is a new
 * schedule), so they render read-only; the placement is cross-referenced to its
 * seeded slot code for legibility.
 */
export default async function SlotScheduleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ scheduleId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { scheduleId } = await params;
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

  const schedule = await fetchSchedule(scheduleId);
  const slotCode = schedule === null ? undefined : await fetchSlotCode(schedule.placementId);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Ads slot-schedule editor</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/ads/slots" className="dash-logout">
            Back to slot inventory
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Slot schedule editor</h1>

        {banner !== null && <ActionBanner banner={banner} />}

        {schedule === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t find that schedule — it may have been removed, or the ads service is
            unreachable.
          </p>
        ) : (
          <ScheduleSection schedule={schedule} slotCode={slotCode} canWrite={canWrite} />
        )}
      </main>
    </div>
  );
}

function ScheduleSection({
  schedule,
  slotCode,
  canWrite,
}: {
  readonly schedule: AdSlotScheduleRecord;
  readonly slotCode: string | undefined;
  readonly canWrite: boolean;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{slotCode ?? schedule.placementId}</span>
        <span className={statusChipClass(schedule.status)}>{formatLabel(schedule.status)}</span>
        <span className="user-row__chip">priority {schedule.priority}</span>
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Placement">
          <code>{schedule.placementId}</code>
        </FactItem>
        <FactItem label="Campaign">
          <code>{schedule.campaignId}</code>
        </FactItem>
        <FactItem label="Starts">{formatDateTime(schedule.startAt)}</FactItem>
        <FactItem label="Ends">
          {schedule.endAt === null ? 'Open-ended' : formatDateTime(schedule.endAt)}
        </FactItem>
        <FactItem label="Updated">{formatDateTime(schedule.updatedAt)}</FactItem>
      </dl>

      {canWrite && (
        <>
          <div className="enrichment-transitions">
            {AD_SLOT_SCHEDULE_STATUS_TRANSITIONS[schedule.status].map((to) => (
              <form key={to} action={transitionScheduleAction.bind(null, schedule.id, to)}>
                <button
                  type="submit"
                  className={
                    DANGER_STATUSES.has(to)
                      ? 'user-detail__action-button user-detail__action-button--danger'
                      : 'user-detail__action-button'
                  }
                >
                  {STATUS_ACTION_LABEL[to]}
                </button>
              </form>
            ))}
          </div>

          <div className="concierge-event-update">
            <h3 className="enrichment-section__title">Edit schedule</h3>
            <ScheduleEditForm schedule={schedule} />
          </div>
        </>
      )}
    </section>
  );
}

function ScheduleEditForm({
  schedule,
}: {
  readonly schedule: AdSlotScheduleRecord;
}): React.JSX.Element {
  return (
    <form
      action={updateScheduleAction.bind(null, schedule.id)}
      className="user-detail__action-form concierge-event-form"
    >
      <label className="user-detail__action-label">
        <span>Starts at (UTC)</span>
        <input type="datetime-local" name="startAt" defaultValue={isoToLocal(schedule.startAt)} />
      </label>
      <label className="user-detail__action-label">
        <span>Ends at (UTC — blank = open-ended)</span>
        <input type="datetime-local" name="endAt" defaultValue={isoToLocal(schedule.endAt)} />
      </label>
      <label className="user-detail__action-label">
        <span>Priority (0–1000, higher served first)</span>
        <input
          name="priority"
          type="number"
          inputMode="numeric"
          min={0}
          max={1000}
          defaultValue={schedule.priority}
        />
      </label>
      <button type="submit" className="user-detail__action-button">
        Save schedule
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

/** ISO UTC → `YYYY-MM-DDTHH:MM` for a datetime-local input (empty when null). */
function isoToLocal(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 16);
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
      return 'The input was invalid. Check the fields (a valid start date is required; ends-at must be after starts-at; priority is 0–1000) and try again.';
    case 'conflict':
      return 'That status change is not allowed from the schedule’s current state, or the window is invalid. Reload and try again.';
    case 'not-found':
      return 'That schedule no longer exists. It may have been removed.';
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

async function fetchSchedule(scheduleId: string): Promise<AdSlotScheduleRecord | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/ads/slot-schedules/${encodeURIComponent(scheduleId)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdSlotScheduleResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.schedule : null;
}

/** Best-effort cross-reference of the schedule's placement to its seeded slot code. */
async function fetchSlotCode(placementId: string): Promise<string | undefined> {
  const result = await callGateway<unknown>('/api/v1/admin/ads/placements');
  if (result.kind !== 'ok') return undefined;
  const parsed = AdPlacementsListResponseSchema.safeParse(result.body);
  if (!parsed.success) return undefined;
  return parsed.data.placements.find((p) => p.id === placementId)?.slotCode;
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
