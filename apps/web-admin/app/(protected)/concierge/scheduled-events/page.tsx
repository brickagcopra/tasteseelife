import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  CONCIERGE_EVENT_STATUS_TRANSITIONS,
  ConciergeScheduledEventsListResponseSchema,
  MeResponseSchema,
  isConciergeEventTerminal,
  type ConciergeScheduledEventRecord,
  type ConciergeScheduledEventsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { scheduleEventAction, updateEventAction } from './actions';
import { readBanner, readString, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Concierge scheduled events — Taste & See Admin',
};

const KIND_OPTIONS = [
  { value: 'restaurant_reservation', label: 'Restaurant reservation' },
  { value: 'cultural_event', label: 'Cultural event' },
  { value: 'group_outing', label: 'Group outing' },
] as const;

const PROVIDER_OPTIONS = [
  { value: 'manual', label: 'Manual (booked by concierge)' },
  { value: 'opentable', label: 'OpenTable' },
  { value: 'museum', label: 'Museum API' },
] as const;

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'proposed', label: 'Proposed' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'completed', label: 'Completed' },
  { value: 'canceled', label: 'Canceled' },
] as const;

const VALID_STATUSES = new Set<string>(
  STATUS_FILTERS.map((s) => s.value).filter((v) => v.length > 0),
);

/**
 * Concierge scheduled-events surface (TS-227; PRD §5.1 Tier 3 "social outings ·
 * event dining"; PDD §10.6). The fulfilment side of the concierge requests
 * TS-223/TS-224 handle: a concierge schedules the concrete booked experience
 * (restaurant reservation / cultural event / group outing) for a household.
 *
 * Permission-gated on `concierge:read`; the schedule + update forms render only
 * for an actor holding `concierge:write`. Deep-linkable from the ticket-detail
 * page with `?householdId=&ticketId=` to pre-fill the create form.
 */
export default async function ScheduledEventsPage({
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

  const list = await fetchEvents(filterHouseholdId, filterStatus);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — concierge scheduled events</span>
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
        <h1>Concierge scheduled events</h1>
        <p>
          Book and track the experiences that fulfil a Tier&nbsp;3 household&apos;s requests —
          restaurant reservations, cultural events, and group outings. Times are entered and shown
          in UTC.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <section className="user-detail__section">
          <h2>Filter</h2>
          <form
            action="/concierge/scheduled-events"
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
            <h2>Schedule an event</h2>
            <ScheduleForm
              prefillHouseholdId={prefillHouseholdId}
              prefillTicketId={prefillTicketId}
            />
          </section>
        )}

        <section className="user-detail__section">
          <h2>Events</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load scheduled events right now. The concierge service may be
              unreachable.
            </p>
          ) : (
            <EventList list={list} canWrite={canWrite} />
          )}
        </section>
      </main>
    </div>
  );
}

function EventList({
  list,
  canWrite,
}: {
  readonly list: ConciergeScheduledEventsListResponse;
  readonly canWrite: boolean;
}): React.JSX.Element {
  if (list.events.length === 0) {
    return (
      <div className="user-empty">
        <p>No scheduled events match this view.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.events.map((event) => (
        <EventRow key={event.id} event={event} canWrite={canWrite} />
      ))}
    </ul>
  );
}

function EventRow({
  event,
  canWrite,
}: {
  readonly event: ConciergeScheduledEventRecord;
  readonly canWrite: boolean;
}): React.JSX.Element {
  const terminal = isConciergeEventTerminal(event.status);
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{event.title}</span>
        <span className="user-row__chip">{formatLabel(event.kind)}</span>
        <span className={statusChipClass(event.status)}>{formatLabel(event.status)}</span>
        {event.externalProvider !== 'manual' && (
          <span className="user-row__chip">{formatLabel(event.externalProvider)}</span>
        )}
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="When">{formatRange(event.scheduledStart, event.scheduledEnd)}</FactItem>
        {event.venueName !== null && <FactItem label="Venue">{event.venueName}</FactItem>}
        {event.venueAddress !== null && <FactItem label="Address">{event.venueAddress}</FactItem>}
        {event.partySize !== null && <FactItem label="Party">{event.partySize}</FactItem>}
        {event.externalReference !== null && (
          <FactItem label="Confirmation">
            <code>{event.externalReference}</code>
          </FactItem>
        )}
        <FactItem label="Household">
          <code>{event.householdId}</code>
        </FactItem>
        {event.ticketId !== null && (
          <FactItem label="Request">
            <Link href={`/concierge/tickets/${encodeURIComponent(event.ticketId)}`}>
              <code>{event.ticketId}</code>
            </Link>
          </FactItem>
        )}
        {event.notes !== null && <FactItem label="Notes">{event.notes}</FactItem>}
      </dl>
      {canWrite && !terminal && <UpdateForm event={event} />}
      {canWrite && terminal && (
        <p className="user-detail__hint">
          This event is {formatLabel(event.status)} — no further edits are available.
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
    <form action={scheduleEventAction} className="user-detail__action-form concierge-event-form">
      <label className="user-detail__action-label">
        <span>Household ID</span>
        <input name="householdId" required defaultValue={prefillHouseholdId} placeholder="hh_…" />
      </label>
      <label className="user-detail__action-label">
        <span>Originating request ID (optional)</span>
        <input name="ticketId" defaultValue={prefillTicketId} placeholder="tk_… (optional)" />
      </label>
      <label className="user-detail__action-label">
        <span>Kind</span>
        <select name="kind" defaultValue={KIND_OPTIONS[0].value}>
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Title</span>
        <input name="title" required placeholder="Sunday lunch at Carbone" />
      </label>
      <label className="user-detail__action-label">
        <span>Venue (optional)</span>
        <input name="venueName" placeholder="Carbone" />
      </label>
      <label className="user-detail__action-label">
        <span>Address (optional)</span>
        <input name="venueAddress" placeholder="181 Thompson St, New York, NY" />
      </label>
      <label className="user-detail__action-label">
        <span>Starts (UTC)</span>
        <input type="datetime-local" name="scheduledStart" required />
      </label>
      <label className="user-detail__action-label">
        <span>Ends (UTC, optional)</span>
        <input type="datetime-local" name="scheduledEnd" />
      </label>
      <label className="user-detail__action-label">
        <span>Party size (optional)</span>
        <input type="number" name="partySize" min={1} max={200} />
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
        <span>Confirmation reference (optional)</span>
        <input name="externalReference" placeholder="OT-998877" />
      </label>
      <label className="user-detail__action-label">
        <span>Status</span>
        <select name="status" defaultValue="proposed">
          <option value="proposed">Proposed</option>
          <option value="confirmed">Confirmed</option>
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Notes (optional)</span>
        <textarea name="notes" rows={2} placeholder="Logistics, accessibility, preferences…" />
      </label>
      <button type="submit" className="user-detail__action-button">
        Schedule event
      </button>
    </form>
  );
}

function UpdateForm({
  event,
}: {
  readonly event: ConciergeScheduledEventRecord;
}): React.JSX.Element {
  const bound = updateEventAction.bind(null, event.id);
  const transitions = CONCIERGE_EVENT_STATUS_TRANSITIONS[event.status];
  return (
    <form action={bound} className="user-detail__action-form concierge-event-update">
      <label className="user-detail__action-label">
        <span>Status</span>
        <select name="status" defaultValue={event.status}>
          <option value={event.status}>{formatLabel(event.status)} (unchanged)</option>
          {transitions.map((t) => (
            <option key={t} value={t}>
              → {formatLabel(t)}
            </option>
          ))}
        </select>
      </label>
      <label className="user-detail__action-label">
        <span>Reschedule start (UTC)</span>
        <input
          type="datetime-local"
          name="scheduledStart"
          defaultValue={toLocalInput(event.scheduledStart)}
        />
      </label>
      <label className="user-detail__action-label">
        <span>Reschedule end (UTC)</span>
        <input
          type="datetime-local"
          name="scheduledEnd"
          defaultValue={event.scheduledEnd === null ? '' : toLocalInput(event.scheduledEnd)}
        />
      </label>
      <label className="user-detail__action-label">
        <span>Confirmation reference</span>
        <input
          name="externalReference"
          defaultValue={event.externalReference ?? ''}
          placeholder="OT-998877"
        />
      </label>
      <label className="user-detail__action-label">
        <span>Notes</span>
        <textarea name="notes" rows={2} defaultValue={event.notes ?? ''} />
      </label>
      <button type="submit" className="user-detail__action-button">
        Update event
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

function statusChipClass(status: ConciergeScheduledEventRecord['status']): string {
  if (status === 'completed') return 'user-row__chip user-row__chip--ok';
  if (status === 'canceled') return 'user-row__chip';
  if (status === 'confirmed') return 'user-row__chip user-row__chip--ok';
  return 'user-row__chip';
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatMaybeDate(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

function formatRange(start: string, end: string | null): string {
  const startText = formatMaybeDate(start);
  return end === null ? `${startText} UTC` : `${startText} – ${formatMaybeDate(end)} UTC`;
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
        Event saved.
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
      return 'The form input was invalid. Check the fields (including the start/end times) and try again.';
    case 'conflict':
      return 'That change is not allowed in the event’s current state (e.g. an invalid status transition or a non-monotonic time range).';
    case 'not-found':
      return "We couldn't find that event — it may have been removed.";
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

async function fetchEvents(
  householdId: string | undefined,
  status: string | undefined,
): Promise<ConciergeScheduledEventsListResponse | null> {
  const params = new URLSearchParams();
  if (householdId !== undefined) params.set('householdId', householdId);
  if (status !== undefined) params.set('status', status);
  const qs = params.toString();
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/scheduled-events${qs.length > 0 ? `?${qs}` : ''}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = ConciergeScheduledEventsListResponseSchema.safeParse(result.body);
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
