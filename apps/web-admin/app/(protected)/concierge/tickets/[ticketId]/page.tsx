import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  CONCIERGE_TICKET_STATUS_TRANSITIONS,
  ConciergeOpsTicketDetailResponseSchema,
  MeResponseSchema,
  isConciergeTicketTerminal,
  type ConciergeOpsTicketDetailResponse,
  type ConciergeTicketNoteRecord,
  type ConciergeTicketRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { addTicketNoteAction, escalateTicketAction, transitionTicketAction } from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Concierge ticket — Taste & See Admin',
};

const ESCALATION_TARGETS = [
  { value: 'concierge_lead', label: 'Concierge lead' },
  { value: 'ops_manager', label: 'Operations manager' },
  { value: 'trust_safety', label: 'Trust & Safety' },
  { value: 'emergency_on_call', label: 'Emergency on-call' },
] as const;

/**
 * Concierge ticket-detail + actions surface (TS-224; PRD §10.6; PDD §10.6).
 *
 * Renders one ticket, its internal-notes timeline, and — for an actor holding
 * `concierge:write` — the status-transition, escalation, and add-note forms.
 * A `concierge:read`-only actor (e.g. operations_manager) sees the read view
 * without the action forms. Links back to the household's dedicated-concierge
 * assignment surface for context.
 */
export default async function ConciergeTicketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { ticketId } = await params;
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

  const detail = await fetchDetail(ticketId);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — concierge ticket</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/concierge/tickets" className="dash-logout">
            Back to queue
          </Link>
        </div>
      </header>
      <main className="dash-main">
        {banner !== null && <ActionBanner banner={banner} />}

        {detail === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load this ticket. It may not exist, or the concierge service may be
            briefly unreachable.
          </p>
        ) : (
          <TicketDetail ticketId={ticketId} detail={detail} canWrite={canWrite} />
        )}
      </main>
    </div>
  );
}

function TicketDetail({
  ticketId,
  detail,
  canWrite,
}: {
  readonly ticketId: string;
  readonly detail: ConciergeOpsTicketDetailResponse;
  readonly canWrite: boolean;
}): React.JSX.Element {
  const { ticket } = detail;
  const terminal = isConciergeTicketTerminal(ticket.status);
  const allowedTargets = CONCIERGE_TICKET_STATUS_TRANSITIONS[ticket.status];

  return (
    <>
      <h1>{ticket.subject}</h1>
      <p>
        <span className="user-row__chip">{formatLabel(ticket.kind)}</span>{' '}
        <span className="user-row__chip user-row__chip--ok">{formatLabel(ticket.status)}</span>
        {ticket.escalationPath !== 'standard' && (
          <>
            {' '}
            <span className="user-row__chip concierge-chip--escalated">
              ↑ {formatLabel(ticket.escalationPath)}
            </span>
          </>
        )}
      </p>

      <section className="user-detail__section">
        <h2>Request</h2>
        <p className="concierge-detail__body">{ticket.body}</p>
        <dl className="concierge-detail__facts">
          <FactItem label="Household">
            <Link
              href={`/concierge/assignments?householdId=${encodeURIComponent(ticket.householdId)}`}
            >
              <code>{ticket.householdId}</code>
            </Link>
          </FactItem>
          <FactItem label="Assigned to">
            {ticket.assignedToUserId === null ? (
              <em>unassigned</em>
            ) : (
              <code>{ticket.assignedToUserId}</code>
            )}
          </FactItem>
          <FactItem label="SLA due">{formatMaybeDate(ticket.slaDueAt)}</FactItem>
          {ticket.requestedDate !== null && (
            <FactItem label="Requested date">{ticket.requestedDate}</FactItem>
          )}
          {ticket.partySize !== null && <FactItem label="Party size">{ticket.partySize}</FactItem>}
          {ticket.theme !== null && <FactItem label="Theme">{ticket.theme}</FactItem>}
          <FactItem label="Created">{formatMaybeDate(ticket.createdAt)}</FactItem>
          <FactItem label="Updated">{formatMaybeDate(ticket.updatedAt)}</FactItem>
        </dl>
        {canWrite && (
          <p className="user-detail__hint">
            <Link
              href={`/concierge/scheduled-events?householdId=${encodeURIComponent(ticket.householdId)}&ticketId=${encodeURIComponent(ticket.id)}`}
            >
              Schedule an event for this request →
            </Link>
          </p>
        )}
      </section>

      <section className="user-detail__section">
        <h2>Internal notes</h2>
        <NotesTimeline notes={detail.notes} />
        {canWrite && <AddNoteForm ticketId={ticketId} />}
      </section>

      {canWrite && (
        <section className="user-detail__section">
          <h2>Actions</h2>
          {terminal ? (
            <p className="user-detail__hint">
              This ticket is {formatLabel(ticket.status)} — no further transitions are available.
            </p>
          ) : (
            <div className="user-detail__actions-grid">
              {allowedTargets.length > 0 && (
                <TransitionForm ticketId={ticketId} targets={allowedTargets} />
              )}
              <EscalateForm ticketId={ticketId} />
            </div>
          )}
        </section>
      )}
    </>
  );
}

function NotesTimeline({
  notes,
}: {
  readonly notes: readonly ConciergeTicketNoteRecord[];
}): React.JSX.Element {
  if (notes.length === 0) {
    return (
      <div className="user-empty">
        <p>No internal notes yet.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-notes">
      {notes.map((note) => (
        <li key={note.id} className="concierge-notes__item">
          <p className="concierge-notes__body">{note.body}</p>
          <p className="user-detail__hint">
            <code>{note.authorUserId}</code> · {formatMaybeDate(note.createdAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function TransitionForm({
  ticketId,
  targets,
}: {
  readonly ticketId: string;
  readonly targets: readonly ConciergeTicketRecord['status'][];
}): React.JSX.Element {
  const bound = transitionTicketAction.bind(null, ticketId);
  return (
    <div className="user-detail__action-card">
      <h3 className="user-detail__role-name">Change status</h3>
      <form action={bound} className="user-detail__action-form">
        <label className="user-detail__action-label">
          <span>Move to</span>
          <select name="targetStatus" required defaultValue={targets[0]}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {formatLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Note (optional)</span>
          <textarea name="note" rows={2} placeholder="Why this change…" />
        </label>
        <button type="submit" className="user-detail__action-button">
          Apply transition
        </button>
      </form>
    </div>
  );
}

function EscalateForm({ ticketId }: { readonly ticketId: string }): React.JSX.Element {
  const bound = escalateTicketAction.bind(null, ticketId);
  return (
    <div className="user-detail__action-card">
      <h3 className="user-detail__role-name">Escalate</h3>
      <form action={bound} className="user-detail__action-form">
        <label className="user-detail__action-label">
          <span>Route to</span>
          <select name="escalationPath" required defaultValue={ESCALATION_TARGETS[0].value}>
            {ESCALATION_TARGETS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Note (optional)</span>
          <textarea name="note" rows={2} placeholder="Why escalate…" />
        </label>
        <button
          type="submit"
          className="user-detail__action-button user-detail__action-button--danger"
        >
          Escalate ticket
        </button>
      </form>
    </div>
  );
}

function AddNoteForm({ ticketId }: { readonly ticketId: string }): React.JSX.Element {
  const bound = addTicketNoteAction.bind(null, ticketId);
  return (
    <form action={bound} className="user-detail__action-form concierge-note-form">
      <label className="user-detail__action-label">
        <span>Add an internal note</span>
        <textarea name="body" rows={3} required placeholder="What happened…" />
      </label>
      <button type="submit" className="user-detail__action-button">
        Add note
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

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatMaybeDate(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Ticket updated.
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
      return 'The form input was invalid. Please check the fields and try again.';
    case 'conflict':
      return 'That action is not allowed in the ticket’s current state. Refresh and try again.';
    case 'not-found':
      return "We couldn't find that ticket — it may have been removed.";
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
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchDetail(ticketId: string): Promise<ConciergeOpsTicketDetailResponse | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/tickets/${encodeURIComponent(ticketId)}`,
  );
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = ConciergeOpsTicketDetailResponseSchema.safeParse(result.body);
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
