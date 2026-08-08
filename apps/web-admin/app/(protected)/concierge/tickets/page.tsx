import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ConciergeOpsTicketsListResponseSchema,
  MeResponseSchema,
  type ConciergeOpsTicketsListResponse,
  type ConciergeTicketRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Concierge ops queue — Taste & See Admin',
};

const STATUS_FILTERS = [
  { value: '', label: 'Needs attention (open · assigned · in progress · escalated)' },
  { value: 'open', label: 'Open' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'canceled', label: 'Canceled' },
] as const;

const VALID_STATUSES = new Set<string>(
  STATUS_FILTERS.map((s) => s.value).filter((v) => v.length > 0),
);

/**
 * Concierge ops-console queue (TS-224; PRD §10.6; PDD §10.6).
 *
 * Lists concierge tickets across every household, ordered by SLA proximity
 * (the back end's default sort). Defaults to the non-terminal "needs
 * attention" set; the status filter pins one lifecycle state. Permission-gated
 * on `concierge:read` — super_admin, concierge_lead, and operations_manager
 * reach it. Each row links to the ticket-detail surface where the write
 * actions live (gated on `concierge:write`).
 */
export default async function ConciergeOpsQueuePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const status = readStatus(search);

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

  const queue = await fetchQueue(status);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — concierge ops queue</span>
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
        <h1>Concierge ops queue</h1>
        <p>
          Tickets across every household, soonest SLA first. Pick a ticket to add internal notes,
          transition its status, or escalate it.
        </p>

        <section className="user-detail__section">
          <form action="/concierge/tickets" method="GET" className="user-detail__action-form">
            <label className="user-detail__action-label">
              <span>Show</span>
              <select name="status" defaultValue={status ?? ''}>
                {STATUS_FILTERS.map((s) => (
                  <option key={s.value || 'active'} value={s.value}>
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

        {queue === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load the concierge queue right now. The downstream concierge service
            may be unreachable.
          </p>
        ) : (
          <QueueList queue={queue} />
        )}
      </main>
    </div>
  );
}

function QueueList({
  queue,
}: {
  readonly queue: ConciergeOpsTicketsListResponse;
}): React.JSX.Element {
  if (queue.tickets.length === 0) {
    return (
      <div className="user-empty">
        <p>No tickets match this view. Nicely done — the queue is clear.</p>
      </div>
    );
  }
  const now = Date.now();
  return (
    <ul className="concierge-queue">
      {queue.tickets.map((ticket) => (
        <TicketRow key={ticket.id} ticket={ticket} now={now} />
      ))}
    </ul>
  );
}

function TicketRow({
  ticket,
  now,
}: {
  readonly ticket: ConciergeTicketRecord;
  readonly now: number;
}): React.JSX.Element {
  const sla = slaLabel(ticket.slaDueAt, now);
  return (
    <li className="concierge-queue__row">
      <Link
        href={`/concierge/tickets/${encodeURIComponent(ticket.id)}`}
        className="concierge-queue__link"
      >
        <span className="concierge-queue__subject">{ticket.subject}</span>
        <span className="concierge-queue__meta">
          <span className="user-row__chip">{formatKind(ticket.kind)}</span>
          <span className={statusChipClass(ticket.status)}>{formatStatus(ticket.status)}</span>
          {ticket.escalationPath !== 'standard' && (
            <span className="user-row__chip concierge-chip--escalated">
              ↑ {formatEscalation(ticket.escalationPath)}
            </span>
          )}
          <span className={sla.overdue ? 'concierge-sla concierge-sla--overdue' : 'concierge-sla'}>
            {sla.text}
          </span>
        </span>
        <span className="concierge-queue__household">
          household <code>{ticket.householdId}</code>
          {ticket.assignedToUserId !== null && (
            <>
              {' · '}assigned <code>{ticket.assignedToUserId}</code>
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

function slaLabel(slaDueAt: string | null, now: number): { text: string; overdue: boolean } {
  if (slaDueAt === null) return { text: 'no SLA', overdue: false };
  const due = new Date(slaDueAt).getTime();
  const diffMs = due - now;
  const overdue = diffMs < 0;
  const hours = Math.round(Math.abs(diffMs) / (60 * 60 * 1000));
  const label = hours >= 48 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  return { text: overdue ? `overdue ${label}` : `due in ${label}`, overdue };
}

function statusChipClass(status: ConciergeTicketRecord['status']): string {
  if (status === 'resolved') return 'user-row__chip user-row__chip--ok';
  if (status === 'canceled') return 'user-row__chip';
  if (status === 'escalated') return 'user-row__chip concierge-chip--escalated';
  return 'user-row__chip user-row__chip--ok';
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function formatKind(kind: string): string {
  return kind.replace(/_/g, ' ');
}

function formatEscalation(path: string): string {
  return path.replace(/_/g, ' ');
}

function readStatus(
  search: Record<string, string | string[] | undefined> | undefined,
): string | null {
  if (search === undefined) return null;
  const raw = search['status'];
  if (typeof raw !== 'string') return null;
  return VALID_STATUSES.has(raw) ? raw : null;
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

async function fetchQueue(status: string | null): Promise<ConciergeOpsTicketsListResponse | null> {
  const query = status === null ? '' : `?status=${encodeURIComponent(status)}`;
  const result = await callGateway<unknown>(`/api/v1/admin/concierge/tickets${query}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = ConciergeOpsTicketsListResponseSchema.safeParse(result.body);
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
