import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminBookingDetailResponseSchema,
  MeResponseSchema,
  type AdminBookingCheckInSummary,
  type AdminBookingDetail,
  type AdminBookingDisputeSummary,
  type AdminBookingRecurrenceSummary,
  type AdminBookingVisitNoteSummary,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Booking detail — Taste & See Admin',
};

/**
 * Admin booking detail (TS-128 Slice 1; PRD §10.5).
 *
 * Single-page view of one booking: identity columns + schedule + money
 * + status, plus the visit notes (one-row-max), check-ins (zero / one /
 * two), disputes (zero or more), and the recurrence record when the
 * row belongs to a series. Read-only — Slice 1 has no mutations.
 *
 * Mutations (manual concierge booking creation, cancel/refund, dispute
 * open/resolve), provider tier + commission management,
 * featured-placement scheduling, service-catalog management,
 * audit-event emission, and the rest of the follow-ups arrive in
 * subsequent slices.
 */
export default async function BookingDetailPage({
  params,
}: {
  params: Promise<{ readonly id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasSuperAdminRole(me)) redirect('/dashboard/no-access');

  const detail = await fetchBookingDetail(id);
  if (detail === 'not_found') notFound();
  if (detail === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — booking detail</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/bookings" className="dash-logout">
            ← All bookings
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>{formatServiceKind(detail.serviceKind)}</h1>
        <p className="user-detail__sub">
          <span className={`user-row__status user-row__status--${statusBucket(detail.status)}`}>
            {detail.status.replace(/_/g, ' ')}
          </span>
          {detail.recurrence !== null && <span className="user-row__chip">recurring</span>}
          {detail.disputes.length > 0 && (
            <span className="user-row__chip user-row__chip--warn">
              {detail.disputes.length} dispute{detail.disputes.length === 1 ? '' : 's'}
            </span>
          )}
        </p>

        <IdentitySection detail={detail} />
        <ScheduleSection detail={detail} />
        <MoneySection detail={detail} />
        <VisitNoteSection visitNote={detail.visitNote} />
        <CheckInsSection checkIns={detail.checkIns} />
        <DisputesSection disputes={detail.disputes} />
        <RecurrenceSection recurrence={detail.recurrence} />
        <CancellationSection detail={detail} />

        <section className="user-detail__section user-detail__section--placeholder">
          <h2>Actions</h2>
          <p>
            Manual booking creation, cancel + refund flows, and dispute open / resolve mutations
            arrive in later slices of TS-128. The audit log of every admin action lands with TS-100.
          </p>
        </section>
      </main>
    </div>
  );
}

function IdentitySection({ detail }: { readonly detail: AdminBookingDetail }): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Identity</h2>
      <dl className="user-detail__dl">
        <dt>Booking id</dt>
        <dd className="user-detail__mono">{detail.id}</dd>
        <dt>Household</dt>
        <dd className="user-detail__mono">{detail.householdId}</dd>
        <dt>Senior</dt>
        <dd className="user-detail__mono">{detail.seniorId}</dd>
        <dt>Provider</dt>
        <dd className="user-detail__mono">{detail.providerId}</dd>
        <dt>Service kind</dt>
        <dd>{formatServiceKind(detail.serviceKind)}</dd>
        <dt>Created</dt>
        <dd>{formatDateTime(detail.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{formatDateTime(detail.updatedAt)}</dd>
      </dl>
    </section>
  );
}

function ScheduleSection({ detail }: { readonly detail: AdminBookingDetail }): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Schedule</h2>
      <dl className="user-detail__dl">
        <dt>Scheduled start</dt>
        <dd>{formatDateTime(detail.scheduledStart)}</dd>
        <dt>Scheduled end</dt>
        <dd>{formatDateTime(detail.scheduledEnd)}</dd>
        <dt>Completed at</dt>
        <dd>
          {detail.completedAt !== null ? (
            formatDateTime(detail.completedAt)
          ) : (
            <span className="user-detail__hint">—</span>
          )}
        </dd>
        {detail.bookingNotes !== null && (
          <>
            <dt>Family notes</dt>
            <dd>{detail.bookingNotes}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function MoneySection({ detail }: { readonly detail: AdminBookingDetail }): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Money</h2>
      <dl className="user-detail__dl">
        <dt>Currency</dt>
        <dd>{detail.currency}</dd>
        <dt>Base price</dt>
        <dd>{formatMoney(detail.basePriceMinor, detail.currency)}</dd>
        <dt>Commission rate</dt>
        <dd>{formatBps(detail.commissionRateBps)}</dd>
        <dt>Commission amount</dt>
        <dd>{formatMoney(detail.commissionAmountMinor, detail.currency)}</dd>
        <dt>Final price</dt>
        <dd>
          <strong>{formatMoney(detail.finalPriceMinor, detail.currency)}</strong>
        </dd>
      </dl>
    </section>
  );
}

function VisitNoteSection({
  visitNote,
}: {
  readonly visitNote: AdminBookingVisitNoteSummary | null;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Visit notes</h2>
      {visitNote === null ? (
        <p className="user-detail__hint">No visit notes yet.</p>
      ) : (
        <dl className="user-detail__dl">
          <dt>Mood</dt>
          <dd>{visitNote.mood ?? <span className="user-detail__hint">—</span>}</dd>
          <dt>Appetite</dt>
          <dd>{visitNote.appetite ?? <span className="user-detail__hint">—</span>}</dd>
          <dt>Hydration</dt>
          <dd>{visitNote.hydration ?? <span className="user-detail__hint">—</span>}</dd>
          <dt>Social engagement</dt>
          <dd>{visitNote.socialEngagement ?? <span className="user-detail__hint">—</span>}</dd>
          {visitNote.freeform !== null && (
            <>
              <dt>Narrative</dt>
              <dd>{visitNote.freeform}</dd>
            </>
          )}
          {visitNote.photoKeys.length > 0 && (
            <>
              <dt>Photos</dt>
              <dd>
                {visitNote.photoKeys.length} photo
                {visitNote.photoKeys.length === 1 ? '' : 's'} attached
                <span className="user-detail__hint">
                  {' '}
                  (preview lands with the media-svc admin viewer)
                </span>
              </dd>
            </>
          )}
          <dt>Recorded by</dt>
          <dd className="user-detail__mono">{visitNote.recordedByUserId}</dd>
          <dt>Recorded at</dt>
          <dd>{formatDateTime(visitNote.recordedAt)}</dd>
        </dl>
      )}
    </section>
  );
}

function CheckInsSection({
  checkIns,
}: {
  readonly checkIns: readonly AdminBookingCheckInSummary[];
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Check-ins</h2>
      {checkIns.length === 0 ? (
        <p className="user-detail__hint">No check-ins recorded.</p>
      ) : (
        <ul className="user-detail__role-list">
          {checkIns.map((checkIn) => (
            <li key={checkIn.id}>
              <span className="user-detail__role-name">{checkIn.kind.replace(/_/g, ' ')}</span>
              <div className="user-detail__hint">
                {formatDateTime(checkIn.occurredAt)} · {checkIn.latitude.toFixed(6)},{' '}
                {checkIn.longitude.toFixed(6)}
                {checkIn.locationAccuracyMeters !== null && (
                  <> · accuracy {checkIn.locationAccuracyMeters.toFixed(1)} m</>
                )}
              </div>
              <div className="user-detail__hint">
                actor <span className="user-detail__mono">{checkIn.recordedByUserId}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DisputesSection({
  disputes,
}: {
  readonly disputes: readonly AdminBookingDisputeSummary[];
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Disputes</h2>
      {disputes.length === 0 ? (
        <p className="user-detail__hint">No disputes filed.</p>
      ) : (
        <ul className="user-detail__role-list">
          {disputes.map((dispute) => (
            <li key={dispute.id}>
              <span className="user-detail__role-name">{dispute.reason.replace(/_/g, ' ')}</span>
              <span className="user-detail__hint"> · opened by {dispute.openedByRole}</span>
              <span
                className={`user-row__chip ${
                  dispute.status === 'open' || dispute.status === 'under_review'
                    ? 'user-row__chip--warn'
                    : ''
                }`}
                style={{ marginLeft: '0.5rem' }}
              >
                {dispute.status.replace(/_/g, ' ')}
              </span>
              {dispute.reasonDetail !== null && <div>{dispute.reasonDetail}</div>}
              {dispute.resolutionNotes !== null && (
                <div>
                  <strong>Resolution:</strong> {dispute.resolutionNotes}
                </div>
              )}
              <div className="user-detail__hint">
                opened {formatDateTime(dispute.createdAt)} · actor{' '}
                <span className="user-detail__mono">{dispute.openedByUserId}</span>
                {dispute.resolvedAt !== null && (
                  <> · resolved {formatDateTime(dispute.resolvedAt)}</>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecurrenceSection({
  recurrence,
}: {
  readonly recurrence: AdminBookingRecurrenceSummary | null;
}): React.JSX.Element | null {
  if (recurrence === null) return null;
  return (
    <section className="user-detail__section">
      <h2>Recurrence</h2>
      <dl className="user-detail__dl">
        <dt>Series id</dt>
        <dd className="user-detail__mono">{recurrence.seriesId}</dd>
        <dt>RRULE</dt>
        <dd className="user-detail__mono">{recurrence.rrule}</dd>
        <dt>This occurrence</dt>
        <dd>
          {recurrence.seriesIndex + 1} of {recurrence.occurrenceCount}
        </dd>
        {recurrence.count !== null && (
          <>
            <dt>Total occurrences</dt>
            <dd>{recurrence.count}</dd>
          </>
        )}
        {recurrence.endDate !== null && (
          <>
            <dt>Ends at</dt>
            <dd>{formatDateTime(recurrence.endDate)}</dd>
          </>
        )}
        <dt>Series created</dt>
        <dd>{formatDateTime(recurrence.createdAt)}</dd>
      </dl>
    </section>
  );
}

function CancellationSection({
  detail,
}: {
  readonly detail: AdminBookingDetail;
}): React.JSX.Element | null {
  if (detail.canceledAt === null && detail.cancellationReason === null) return null;
  return (
    <section className="user-detail__section">
      <h2>Cancellation</h2>
      <dl className="user-detail__dl">
        <dt>Canceled at</dt>
        <dd>
          {detail.canceledAt !== null ? (
            formatDateTime(detail.canceledAt)
          ) : (
            <span className="user-detail__hint">—</span>
          )}
        </dd>
        <dt>Reason</dt>
        <dd>
          {detail.cancellationReason !== null ? (
            detail.cancellationReason.replace(/_/g, ' ')
          ) : (
            <span className="user-detail__hint">—</span>
          )}
        </dd>
        {detail.cancellationReasonText !== null && (
          <>
            <dt>Detail</dt>
            <dd>{detail.cancellationReasonText}</dd>
          </>
        )}
      </dl>
    </section>
  );
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

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchBookingDetail(id: string): Promise<AdminBookingDetail | 'not_found' | null> {
  const result = await callGateway<unknown>(`/api/v1/admin/bookings/${encodeURIComponent(id)}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'client_error' && result.status === 404) return 'not_found';
  if (result.kind !== 'ok') return null;
  const parsed = AdminBookingDetailResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.booking : null;
}

function statusBucket(
  status: AdminBookingDetail['status'],
): 'active' | 'suspended' | 'deactivated' {
  switch (status) {
    case 'pending':
    case 'confirmed':
    case 'in_progress':
    case 'completed':
      return 'active';
    case 'canceled':
    case 'declined':
      return 'deactivated';
  }
}

function formatServiceKind(kind: AdminBookingDetail['serviceKind']): string {
  switch (kind) {
    case 'companion_dining':
      return 'Companion dining';
    case 'personal_chef_visit':
      return 'Personal chef visit';
    case 'grocery_coordination':
      return 'Grocery coordination';
    case 'transportation':
      return 'Transportation';
    case 'social_outing':
      return 'Social outing';
    case 'event_dining':
      return 'Event dining';
    case 'emergency_concierge':
      return 'Emergency concierge';
    case 'holiday_dinner':
      return 'Holiday dinner';
    case 'birthday_experience':
      return 'Birthday experience';
    case 'tea_social':
      return 'Tea social';
    case 'museum_outing':
      return 'Museum outing';
    case 'memory_meal':
      return 'Memory meal';
    case 'custom_request':
      return 'Custom request';
  }
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(minor / 100);
  } catch {
    return `$${(minor / 100).toFixed(2)}`;
  }
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
