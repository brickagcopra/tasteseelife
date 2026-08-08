import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AuditEventsListResponseSchema,
  MeResponseSchema,
  type AuditEventResponse,
  type AuditEventsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'RBAC — change history — Taste & See Admin',
};

/**
 * The audit resource kinds the RBAC bounded context emits
 * (identity's `RBAC_AUDIT_RESOURCE`) — the default kind-wide stream.
 * `org_security_policy` joined with TS-296; `user_impersonation`
 * with TS-297. NOTE: the by-resource-kind CSV bound is 5 and we now
 * use all 5 — a sixth kind needs a contract bound bump first.
 */
const RBAC_KINDS = [
  'rbac_role',
  'rbac_assignment',
  'rbac_approval',
  'org_security_policy',
  'user_impersonation',
] as const;
type RbacKind = (typeof RBAC_KINDS)[number];

/** Every action identity's RBAC mutations stamp (TS-295) — filter chips. */
const RBAC_ACTIONS = [
  'rbac_role:create',
  'rbac_role:update',
  'rbac_role:archive',
  'rbac_assignment:grant',
  'rbac_assignment:revoke',
  'rbac_assignment:expire',
  'rbac_approval:request',
  'rbac_approval:approve',
  'rbac_approval:reject',
  'org_security_policy:create',
  'org_security_policy:update',
  'user_impersonation:start',
  'user_impersonation:end',
] as const;
type RbacAction = (typeof RBAC_ACTIONS)[number];

interface HistoryFilters {
  readonly kind: RbacKind | null;
  readonly action: RbacAction | null;
  readonly order: 'desc' | 'asc';
  readonly cursor: string | null;
}

/**
 * RBAC change history (TS-295; PRD §10.12, §10.13; PDD §10.3, §17.1).
 * A read-only stream of role / assignment / approval changes with actor,
 * timestamp, and before/after diff — sourced from `service-audit`'s
 * append-only, hash-chained store via the gateway's
 * `by-resource-kind` proxy. Page-gated on `audit:read` (seeded to
 * super_admin, trust & safety, and read_only_auditor). Filters and the
 * timestamp sort are plain links — no client JS anywhere on the page.
 */
export default async function RbacHistoryPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const filters = readFilters(search);

  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>We&apos;re having a moment</h1>
          <p>Our service is briefly unreachable. Please refresh in a few seconds.</p>
        </main>
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasPermission(me, 'audit:read')) redirect('/dashboard/no-access');

  const list = await fetchHistory(filters);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — RBAC</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/roles" className="dash-logout">
            Back to roles
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>RBAC change history</h1>
        <p>
          Every role, assignment, and approval change — who made it, when, and what changed. Served
          from the append-only audit log. Viewing gated on <code>audit:read</code>.
        </p>

        <FilterBar filters={filters} />

        <section className="user-detail__section">
          <h2>Changes {filters.order === 'desc' ? '(newest first)' : '(oldest first)'}</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load the change history right now. The audit service may be
              unreachable.
            </p>
          ) : (
            <HistoryList list={list} filters={filters} />
          )}
        </section>
      </main>
    </div>
  );
}

/** Filter + sort affordances — all links, keyed off the current filters. */
function FilterBar({ filters }: { readonly filters: HistoryFilters }): React.JSX.Element {
  return (
    <>
      <p className="user-detail__hint">
        Kind:{' '}
        <FilterLink filters={filters} patch={{ kind: null }} active={filters.kind === null}>
          all
        </FilterLink>
        {RBAC_KINDS.map((kind) => (
          <span key={kind}>
            {' · '}
            <FilterLink filters={filters} patch={{ kind }} active={filters.kind === kind}>
              {kind}
            </FilterLink>
          </span>
        ))}
      </p>
      <p className="user-detail__hint">
        Action:{' '}
        <FilterLink filters={filters} patch={{ action: null }} active={filters.action === null}>
          all
        </FilterLink>
        {RBAC_ACTIONS.map((action) => (
          <span key={action}>
            {' · '}
            <FilterLink filters={filters} patch={{ action }} active={filters.action === action}>
              {action}
            </FilterLink>
          </span>
        ))}
      </p>
      <p className="user-detail__hint">
        Sort:{' '}
        <FilterLink filters={filters} patch={{ order: 'desc' }} active={filters.order === 'desc'}>
          newest first
        </FilterLink>
        {' · '}
        <FilterLink filters={filters} patch={{ order: 'asc' }} active={filters.order === 'asc'}>
          oldest first
        </FilterLink>
      </p>
    </>
  );
}

function FilterLink({
  filters,
  patch,
  active,
  children,
}: {
  readonly filters: HistoryFilters;
  readonly patch: Partial<HistoryFilters>;
  readonly active: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  if (active) return <strong aria-current="true">{children}</strong>;
  // Any filter change restarts pagination — a cursor is only valid for
  // the query it was minted against.
  return <Link href={historyHref({ ...filters, cursor: null, ...patch })}>{children}</Link>;
}

function HistoryList({
  list,
  filters,
}: {
  readonly list: AuditEventsListResponse;
  readonly filters: HistoryFilters;
}): React.JSX.Element {
  if (list.events.length === 0) {
    return (
      <div className="user-empty">
        <p>
          No RBAC changes recorded
          {filters.action !== null || filters.kind !== null ? ' for these filters' : ' yet'}. Events
          land here as role, assignment, and approval mutations flow through the audit pipeline.
        </p>
      </div>
    );
  }
  return (
    <>
      <ul className="concierge-event-list">
        {list.events.map((event) => (
          <HistoryRow key={event.id} event={event} />
        ))}
      </ul>
      {list.nextCursor !== null && (
        <p className="user-detail__hint">
          <Link href={historyHref({ ...filters, cursor: list.nextCursor })}>Older changes →</Link>
        </p>
      )}
    </>
  );
}

function HistoryRow({ event }: { readonly event: AuditEventResponse }): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">{event.action}</span>
        <span className="user-row__chip">{event.resourceKind}</span>
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="When">
          <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
        </FactItem>
        <FactItem label="Actor">
          {event.actorUserId === null ? (
            <>system (automated)</>
          ) : (
            <span title={event.actorRole ?? undefined}>{event.actorUserId}</span>
          )}
        </FactItem>
        <FactItem label="Resource">
          <code>{event.resourceId}</code>
        </FactItem>
      </dl>
      <ChangeDiff before={event.beforeJson} after={event.afterJson} />
    </li>
  );
}

/**
 * Before/after rendering: when both snapshots are plain objects, show
 * only the top-level fields that changed (created / archived rows show
 * every field of the present side); the full snapshots stay one
 * disclosure away for auditors who need the raw record.
 */
function ChangeDiff({
  before,
  after,
}: {
  readonly before: unknown;
  readonly after: unknown;
}): React.JSX.Element {
  const changes = diffEntries(before, after);
  return (
    <div className="user-detail__section">
      {changes.length === 0 ? (
        <p className="user-detail__hint">No field-level diff available.</p>
      ) : (
        <dl className="concierge-detail__facts">
          {changes.map((change) => (
            <FactItem key={change.key} label={change.key}>
              {change.before !== undefined && (
                <>
                  <del>{change.before}</del>
                  {' → '}
                </>
              )}
              <ins>{change.after ?? '—'}</ins>
            </FactItem>
          ))}
        </dl>
      )}
      <details>
        <summary>Raw before / after</summary>
        <pre>{JSON.stringify({ before: before ?? null, after: after ?? null }, null, 2)}</pre>
      </details>
    </div>
  );
}

interface DiffEntry {
  readonly key: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

/** Top-level changed keys between two maybe-object snapshots. */
function diffEntries(before: unknown, after: unknown): readonly DiffEntry[] {
  const beforeMap = asRecord(before);
  const afterMap = asRecord(after);
  if (beforeMap === null && afterMap === null) return [];

  const keys = [...new Set([...Object.keys(beforeMap ?? {}), ...Object.keys(afterMap ?? {})])];
  const entries: DiffEntry[] = [];
  for (const key of keys) {
    const beforeValue = beforeMap?.[key];
    const afterValue = afterMap?.[key];
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
    entries.push({
      key,
      before: beforeMap === null ? undefined : renderValue(beforeValue),
      after: afterMap === null ? undefined : renderValue(afterValue),
    });
  }
  return entries;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
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

function readFilters(
  search: Record<string, string | string[] | undefined> | undefined,
): HistoryFilters {
  const kindRaw = single(search?.['kind']);
  const actionRaw = single(search?.['action']);
  const orderRaw = single(search?.['order']);
  const cursorRaw = single(search?.['cursor']);
  return {
    kind: (RBAC_KINDS as readonly string[]).includes(kindRaw ?? '') ? (kindRaw as RbacKind) : null,
    action: (RBAC_ACTIONS as readonly string[]).includes(actionRaw ?? '')
      ? (actionRaw as RbacAction)
      : null,
    order: orderRaw === 'asc' ? 'asc' : 'desc',
    cursor: cursorRaw !== undefined && cursorRaw.length > 0 ? cursorRaw : null,
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Serialize the filters back into this page's URL. */
function historyHref(filters: HistoryFilters): string {
  const params = new URLSearchParams();
  if (filters.kind !== null) params.set('kind', filters.kind);
  if (filters.action !== null) params.set('action', filters.action);
  if (filters.order !== 'desc') params.set('order', filters.order);
  if (filters.cursor !== null) params.set('cursor', filters.cursor);
  const qs = params.toString();
  return qs.length > 0 ? `/roles/history?${qs}` : '/roles/history';
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchHistory(filters: HistoryFilters): Promise<AuditEventsListResponse | null> {
  const params = new URLSearchParams();
  params.set('resourceKinds', filters.kind ?? RBAC_KINDS.join(','));
  if (filters.action !== null) params.set('action', filters.action);
  params.set('order', filters.order);
  if (filters.cursor !== null) params.set('cursor', filters.cursor);
  const result = await callGateway<unknown>(
    `/api/v1/admin/audit/events/by-resource-kind?${params.toString()}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AuditEventsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
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
