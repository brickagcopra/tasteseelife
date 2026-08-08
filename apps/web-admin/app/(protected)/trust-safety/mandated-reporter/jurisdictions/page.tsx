import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MandatedReporterJurisdictionListResponseSchema,
  MeResponseSchema,
  US_JURISDICTION_CODES,
  type MandatedReporterJurisdictionRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Mandated-reporter jurisdiction kit — Taste & See Admin',
};

/**
 * Per-state mandated-reporter workflow kit (TS-303c2c; PDD §16.4 "mandated
 * reporter laws by state — workflow kit per state").
 *
 * **The default view is the backlog, not the catalogue.** The table ships
 * EMPTY and every row starts unverified, because the platform does not author
 * elder-abuse reporting law. Until compliance has reviewed a state against
 * primary sources, no case in that state can reach filing prep. So the useful
 * first screen is "which states are not usable yet", and that is what loads.
 *
 * **States with no row at all are shown too.** A missing row is a harder
 * failure than an unverified one — `openCase` 404s outright, so an operator
 * cannot even start the statutory clock in that state. A list that only
 * rendered what the table contains would show an empty page and imply there is
 * nothing to do.
 */

const VIEWS = [
  { value: '', label: 'Backlog — states not usable yet' },
  { value: 'all', label: 'All states' },
] as const;

export default async function JurisdictionKitPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const showAll = search?.['view'] === 'all';

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
  if (!hasPermission(me, 'trust_safety:write')) redirect('/dashboard/no-access');

  // Always the FULL kit: the backlog view needs to know which states have no
  // row at all, and `?unverifiedOnly=true` cannot tell you that — it returns
  // rows, and a state with no row has none.
  const kit = await fetchKit();

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — mandated reporter</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/trust-safety/mandated-reporter" className="dash-logout">
            Back to cases
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Jurisdiction kit</h1>
        <p>
          The receiving agency, hotline, portal, statutory window, and reporting duty for each
          state. <strong>Taste &amp; See does not author any of this.</strong> Every field is
          transcribed from a counsel-reviewed source and attributed to the statute it rests on. A
          state is unusable for filing preparation until compliance attests that its row matches
          those sources — a wrong hotline number here is a missed elder-abuse report.
        </p>

        <section className="user-detail__section">
          <form
            action="/trust-safety/mandated-reporter/jurisdictions"
            method="GET"
            className="user-detail__action-form"
          >
            <label className="user-detail__action-label">
              <span>Show</span>
              <select name="view" defaultValue={showAll ? 'all' : ''}>
                {VIEWS.map((v) => (
                  <option key={v.value || 'backlog'} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="user-detail__action-button">
              Apply
            </button>
          </form>
        </section>

        {kit === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load the jurisdiction kit. The trust &amp; safety service may be
            unreachable — do not read this as &ldquo;no states are configured&rdquo;.
          </p>
        ) : (
          <KitList kit={kit} showAll={showAll} />
        )}
      </main>
    </div>
  );
}

interface KitRow {
  readonly stateCode: string;
  readonly record: MandatedReporterJurisdictionRecord | null;
}

function KitList({
  kit,
  showAll,
}: {
  readonly kit: readonly MandatedReporterJurisdictionRecord[];
  readonly showAll: boolean;
}): React.JSX.Element {
  const byState = new Map(kit.map((row) => [row.stateCode, row]));
  const rows: KitRow[] = US_JURISDICTION_CODES.map((stateCode) => ({
    stateCode,
    record: byState.get(stateCode) ?? null,
  }));
  const visible = showAll ? rows : rows.filter((r) => r.record === null || !r.record.verified);

  const verifiedCount = kit.filter((r) => r.verified).length;

  return (
    <section className="user-detail__section">
      <h2>
        {showAll ? 'All jurisdictions' : 'Not usable yet'}{' '}
        <span className="user-detail__hint">
          ({verifiedCount} of {US_JURISDICTION_CODES.length} verified)
        </span>
      </h2>
      {visible.length === 0 ? (
        <div className="user-empty">
          <p>Every jurisdiction is verified. Filing preparation is available nationwide.</p>
        </div>
      ) : (
        <ul className="concierge-queue">
          {visible.map((row) => (
            <JurisdictionRow key={row.stateCode} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function JurisdictionRow({ row }: { readonly row: KitRow }): React.JSX.Element {
  const { stateCode, record } = row;
  return (
    <li className="concierge-queue__row">
      <Link
        href={`/trust-safety/mandated-reporter/jurisdictions/${encodeURIComponent(stateCode)}`}
        className="concierge-queue__link"
      >
        <span className="concierge-queue__subject">
          {stateCode}
          {record?.agencyName !== undefined && record?.agencyName !== null && (
            <> — {record.agencyName}</>
          )}
        </span>
        <span className="concierge-queue__meta">
          <span className={statusChipClass(record)}>{statusLabel(record)}</span>
          {record !== null && (
            <span className="user-row__chip">{formatRole(record.platformRole)}</span>
          )}
          {record !== null && record.statutoryDeadlineHours === null && (
            <span className="concierge-sla concierge-sla--overdue">no statutory window</span>
          )}
        </span>
        <span className="concierge-queue__household">
          {record === null
            ? 'No kit row — a case cannot even be opened in this state.'
            : record.statuteCitation !== null
              ? record.statuteCitation
              : 'No statute cited.'}
        </span>
      </Link>
    </li>
  );
}

function statusChipClass(record: MandatedReporterJurisdictionRecord | null): string {
  if (record === null) return 'user-row__chip concierge-chip--escalated';
  return record.verified ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
}

function statusLabel(record: MandatedReporterJurisdictionRecord | null): string {
  if (record === null) return 'no kit row';
  return record.verified ? 'verified' : 'unverified';
}

function formatRole(role: string): string {
  return role === 'undetermined' ? 'duty undetermined' : `${role} reporter`;
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchKit(): Promise<readonly MandatedReporterJurisdictionRecord[] | null> {
  const result = await callGateway<unknown>(
    '/api/v1/admin/trust-safety/mandated-reporter/jurisdictions',
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MandatedReporterJurisdictionListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.jurisdictions : null;
}
