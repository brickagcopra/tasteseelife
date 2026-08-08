import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  CONCIERGE_RIDE_STATUS_TRANSITIONS,
  ConciergeTransportationListResponseSchema,
  MeResponseSchema,
  isConciergeRideTerminal,
  type ConciergeTransportationListResponse,
  type ConciergeTransportationRequestRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { scheduleRideAction, updateRideAction } from './actions';
import { readBanner, readString, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Concierge transportation — Taste & See Admin',
};

const PROVIDER_OPTIONS = [
  { value: 'manual', label: 'Manual (booked by concierge)' },
  { value: 'uber_health', label: 'Uber Health' },
  { value: 'lyft_health', label: 'Lyft Health' },
] as const;

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'requested', label: 'Requested' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'canceled', label: 'Canceled' },
] as const;

const VALID_STATUSES = new Set<string>(
  STATUS_FILTERS.map((s) => s.value).filter((v) => v.length > 0),
);

/**
 * Concierge transportation surface (TS-226; PRD §5.1 Tier 3 "transportation
 * coordination"; PDD §10.6). The fulfilment side of a Tier-3 household's
 * transportation need: a concierge arranges, tracks, and cancels the rides
 * (medical appointments, outings, social visits). Sibling of the TS-227
 * scheduled-events surface.
 *
 * `externalProvider` is the Phase-3 adapter seam — `manual` is the live Phase-1
 * default; `uber_health` / `lyft_health` are wired in a follow-up (their ride
 * state mirrors back via the shared-secret webhook). Permission-gated on
 * `concierge:read`; the schedule + update forms render only for an actor
 * holding `concierge:write`. Deep-linkable from the ticket-detail page with
 * `?householdId=&ticketId=` to pre-fill the create form.
 */
export default async function TransportationPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);
  const filterHouseholdId = readString(search, 'householdId');
  const filterStatus = readStatus(search);
  const prefillHouseholdId = filterHouseholdId ?? '';
  const prefillTicketId = readString(search, 'ticketId') ?? '';

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

  const list = await fetchRides(filterHouseholdId, filterStatus);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — concierge transportation</span>
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
        <h1>Concierge transportation</h1>
        <p>
          Arrange and track the rides that get a Tier&nbsp;3 household where they need to be —
          medical appointments, outings, social visits. Times are entered and shown in UTC. Vendor
          rides (Uber&nbsp;Health / Lyft&nbsp;Health) mirror their driver state back automatically;
          manual rides are driven here by hand.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Filter</h2>
          <form
            action="/concierge/transportation"
            method="GET"
            className="user-detail__action-form concierge-event-filter"
          >
            <label className="user-detail__action-label">
              <span>Household ID</span>
              <input name="householdId" defaultValue={filterHouseholdId ?? ''} placeholder="hh_…" />
            </label>
            <label className="user-detail__action-label">
              <span>Status</span>
              <select name="status" defaultValue={filterStatus ?? ''}>
                {STATUS_FILTERS.map((s) => (
                  <option key={s.value || 'all'} value={s.value}>
                    {s.label}
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
            <h2>Arrange a ride</h2>
            <ScheduleForm
              prefillHouseholdId={prefillHouseholdId}
              prefillTicketId={prefillTicketId}
            />
          </section>
        )}

        <section className="user-detail__section">
          <h2>Rides</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load transportation requests right now. The concierge service may be
              unreachable.
            </p>
          ) : (
            <RideList list={list} canWrite={canWrite} />
          )}
        </section>
      </main>
    </div>
  );
}

function RideList({
  list,
  canWrite,
}: {
  readonly list: ConciergeTransportationListResponse;
  readonly canWrite: boolean;
}): React.JSX.Element {
  if (list.requests.length === 0) {
    return (
      <div className="user-empty">
        <p>No rides match this view.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.requests.map((ride) => (
        <RideRow key={ride.id} ride={ride} canWrite={canWrite} />
      ))}
    </ul>
  );
}

function RideRow({
  ride,
  canWrite,
}: {
  readonly ride: ConciergeTransportationRequestRecord;
  readonly canWrite: boolean;
}): React.JSX.Element {
  const terminal = isConciergeRideTerminal(ride.status);
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">
          {ride.pickupAddress} → {ride.dropoffAddress}
        </span>
        <span className={statusChipClass(ride.status)}>{formatLabel(ride.status)}</span>
        {ride.externalProvider !== 'manual' && (
          <span className="user-row__chip">{formatLabel(ride.externalProvider)}</span>
        )}
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Pickup">{formatDate(ride.scheduledPickupAt)} UTC</FactItem>
        {ride.purpose !== null && <FactItem label="Purpose">{ride.purpose}</FactItem>}
        {ride.riderName !== null && <FactItem label="Rider">{ride.riderName}</FactItem>}
        {ride.externalReference !== null && (
          <FactItem label="Ride ref">
            <code>{ride.externalReference}</code>
          </FactItem>
        )}
        {ride.externalStatus !== null && (
          <FactItem label="Vendor status">{ride.externalStatus}</FactItem>
        )}
        <FactItem label="Household">
          <code>{ride.householdId}</code>
        </FactItem>
        {ride.ticketId !== null && (
          <FactItem label="Request">
            <Link href={`/concierge/tickets/${encodeURIComponent(ride.ticketId)}`}>
              <code>{ride.ticketId}</code>
            </Link>
          </FactItem>
        )}
        {ride.notes !== null && <FactItem label="Notes">{ride.notes}</FactItem>}
      </dl>
      {canWrite && !terminal && <UpdateForm ride={ride} />}
      {canWrite && terminal && (
        <p className="user-detail__hint">
          This ride is {formatLabel(ride.status)} — no further edits are available.
        </p>
      )}
    </li>
  );
}

function ScheduleForm({
  prefillHouseholdId,
  prefillTicketId,
}: {
  readonly prefillHouseholdId: string;
  readonly prefillTicketId: string;
}): React.JSX.Element {
  return (
    <form action={scheduleRideAction} className="user-detail__action-form concierge-event-form">
      <label className="user-detail__action-label">
        <span>Household ID</span>
        <input name="householdId" required defaultValue={prefillHouseholdId} placeholder="hh_…" />
      </label>
      <label className="user-detail__action-label">
        <span>Originating request ID (optional)</span>
        <input name="ticketId" defaultValue={prefillTicketId} placeholder="tk_… (optional)" />
      </label>
      <label className="user-detail__action-label">
        <span>Pickup address</span>
        <input name="pickupAddress" required placeholder="101 Park Ave, New York, NY" />
      </label>
      <label className="user-detail__action-label">
        <span>Dropoff address</span>
        <input name="dropoffAddress" required placeholder="Mount Sinai, 1 Gustave L. Levy Pl" />
      </label>
      <label className="user-detail__action-label">
        <span>Pickup time (UTC)</span>
        <input type="datetime-local" name="scheduledPickupAt" required />
      </label>
      <label className="user-detail__action-label">
        <span>Purpose (optional)</span>
        <input name="purpose" placeholder="Cardiology follow-up" />
      </label>
      <label className="user-detail__action-label">
        <span>Rider name (optional)</span>
        <input name="riderName" placeholder="Eleanor" />
      </label>
      <label className="user-detail__action-label">
        <span>Booking source</span>
        <select name="externalProvider" defaultValue="manual">
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Vendor ride ref (optional)</span>
        <input name="externalReference" placeholder="uber_ride_99" />
      </label>
      <label className="user-detail__action-label">
        <span>Status</span>
        <select name="status" defaultValue="requested">
          <option value="requested">Requested</option>
          <option value="scheduled">Scheduled</option>
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Notes (optional)</span>
        <textarea name="notes" rows={2} placeholder="Accessibility, mobility aid, escort…" />
      </label>
      <button type="submit" className="user-detail__action-button">
        Arrange ride
      </button>
    </form>
  );
}

function UpdateForm({
  ride,
}: {
  readonly ride: ConciergeTransportationRequestRecord;
}): React.JSX.Element {
  const bound = updateRideAction.bind(null, ride.id);
  const transitions = CONCIERGE_RIDE_STATUS_TRANSITIONS[ride.status];
  return (
    <form action={bound} className="user-detail__action-form concierge-event-update">
      <label className="user-detail__action-label">
        <span>Status</span>
        <select name="status" defaultValue={ride.status}>
          <option value={ride.status}>{formatLabel(ride.status)} (unchanged)</option>
          {transitions.map((t) => (
            <option key={t} value={t}>
              → {formatLabel(t)}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Reschedule pickup (UTC)</span>
        <input
          type="datetime-local"
          name="scheduledPickupAt"
          defaultValue={toLocalInput(ride.scheduledPickupAt)}
        />
      </label>
      <label className="user-detail__action-label">
        <span>Vendor ride ref</span>
        <input
          name="externalReference"
          defaultValue={ride.externalReference ?? ''}
          placeholder="uber_ride_99"
        />
      </label>
      <label className="user-detail__action-label">
        <span>Notes</span>
        <textarea name="notes" rows={2} defaultValue={ride.notes ?? ''} />
      </label>
      <button type="submit" className="user-detail__action-button">
        Update ride
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

function statusChipClass(status: ConciergeTransportationRequestRecord['status']): string {
  if (status === 'completed') return 'user-row__chip user-row__chip--ok';
  if (status === 'in_progress') return 'user-row__chip user-row__chip--ok';
  return 'user-row__chip';
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

/** ISO (UTC) → `YYYY-MM-DDTHH:MM` for a datetime-local input default. */
function toLocalInput(iso: string): string {
  return iso.slice(0, 16);
}

function readStatus(
  search: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const raw = readString(search, 'status');
  return raw !== undefined && VALID_STATUSES.has(raw) ? raw : undefined;
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Ride saved.
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
      return 'The form input was invalid. Check the fields (including the pickup time) and try again.';
    case 'conflict':
      return 'That change is not allowed in the ride’s current state (e.g. an invalid status transition, or a terminal ride).';
    case 'not-found':
      return "We couldn't find that ride — it may have been removed.";
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

async function fetchRides(
  householdId: string | undefined,
  status: string | undefined,
): Promise<ConciergeTransportationListResponse | null> {
  const params = new URLSearchParams();
  if (householdId !== undefined) params.set('householdId', householdId);
  if (status !== undefined) params.set('status', status);
  const qs = params.toString();
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/transportation${qs.length > 0 ? `?${qs}` : ''}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = ConciergeTransportationListResponseSchema.safeParse(result.body);
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
