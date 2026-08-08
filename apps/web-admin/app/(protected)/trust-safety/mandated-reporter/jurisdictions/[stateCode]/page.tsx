import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MandatedReporterJurisdictionResponseSchema,
  MeResponseSchema,
  isUsJurisdictionCode,
  type MandatedReporterJurisdictionRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { readDetailParam } from '@/lib/problem-detail';

import { saveJurisdictionAction, setVerificationAction } from '../actions';

export const metadata: Metadata = {
  title: 'Jurisdiction kit — state — Taste & See Admin',
};

/**
 * Per-state mandated-reporter kit editor (TS-303c2c; PDD §16.4).
 *
 * Three rules the layout has to carry, each mirroring how the routes behave:
 *
 * 1. **Editing a verified row withdraws its attestation.** The service clears
 *    `verified` the moment any substantive field changes, because the review
 *    covered the old values and leaving the flag set would let an unreviewed
 *    hotline number pass the filing-prep gate on the strength of a review of
 *    the number it replaced. The form warns before submit rather than after,
 *    and the warning is only shown when it is actually true (the row is
 *    verified today).
 *
 * 2. **Attestation is its own control, never a field on the edit form.** It is
 *    a separate route with a separate audit action and its own attribution.
 *    A checkbox on the save form would let an attestation ride along on an
 *    unrelated change — exactly what the route split exists to prevent.
 *
 * 3. **Withdrawal is first-class, not an undo.** Reporting law changes by
 *    legislative session; a state whose statute has moved must be pulled out
 *    of service, and the control says so in those terms.
 *
 * `notes` is deliberately excluded from the substantive set — working notes
 * are commentary about the row, not a claim the review covered them — so
 * editing notes alone does NOT clear the attestation. The copy says which
 * fields are which, because an operator should be able to predict it.
 */

const PLATFORM_ROLES = [
  { value: 'undetermined', label: 'Undetermined — counsel has not settled this' },
  { value: 'mandated', label: 'Mandated — the platform must report' },
  { value: 'permissive', label: 'Permissive — the platform may report' },
] as const;

export default async function JurisdictionEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ stateCode: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { stateCode: raw } = await params;
  const stateCode = raw.trim().toUpperCase();
  // A non-jurisdiction segment is a 404 here rather than a downstream 400 —
  // the route is addressed by a postal code, and `/jurisdictions/ZZ` is not a
  // resource that could exist.
  if (!isUsJurisdictionCode(stateCode)) notFound();

  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);

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

  const found = await fetchJurisdiction(stateCode);

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
          <Link href="/trust-safety/mandated-reporter/jurisdictions" className="dash-logout">
            Back to kit
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Jurisdiction kit — {stateCode}</h1>

        {banner !== null && <ActionBanner banner={banner} />}

        {found === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load this state&apos;s kit. The trust &amp; safety service may be
            unreachable — do not read this as &ldquo;no row exists&rdquo;.
          </p>
        ) : (
          <Editor stateCode={stateCode} record={found === 'missing' ? null : found} />
        )}
      </main>
    </div>
  );
}

function Editor({
  stateCode,
  record,
}: {
  readonly stateCode: string;
  readonly record: MandatedReporterJurisdictionRecord | null;
}): React.JSX.Element {
  const verified = record?.verified ?? false;

  return (
    <>
      <section className="user-detail__section">
        <h2>Status</h2>
        {record === null ? (
          <p className="auth-alert" role="status">
            No kit row exists for {stateCode}. A mandated-reporter case cannot be opened here at all
            — the service 404s — so the statutory clock cannot even be started. Saving below creates
            the row.
          </p>
        ) : verified ? (
          <p className="auth-alert auth-alert--success" role="status">
            Verified{record.verifiedAt !== null && <> on {formatTimestamp(record.verifiedAt)}</>}
            {record.verifiedByUserId !== null && (
              <>
                {' '}
                by <code>{record.verifiedByUserId}</code>
              </>
            )}
            . Cases in {stateCode} can reach filing preparation.
          </p>
        ) : (
          <p className="auth-alert" role="status">
            Not verified. Cases in {stateCode} can be opened — our compliance backlog must never
            stop the statutory clock — but they cannot advance to filing preparation until
            compliance attests to this row.
          </p>
        )}
      </section>

      <section className="user-detail__section">
        <h2>Details</h2>
        <p className="user-detail__hint">
          Transcribe from the counsel-reviewed source. Do not fill these in from memory, from
          another state&apos;s row, or from a web search — a wrong hotline number here is a missed
          elder-abuse report.
        </p>
        {verified && (
          <p className="auth-alert" role="alert">
            <strong>Saving will withdraw this state&apos;s verification.</strong> The attestation
            covers the values as reviewed; changing the agency, phone, portal, statutory window,
            reporting duty, or statute citation means it no longer does, and filing preparation in{' '}
            {stateCode} will be blocked until someone attests again. Editing only the working notes
            — or re-saving without changing anything — leaves the attestation intact.
          </p>
        )}
        <form action={saveJurisdictionAction} className="user-detail__action-form">
          <input type="hidden" name="stateCode" value={stateCode} />

          <label className="user-detail__action-label">
            <span>Receiving agency</span>
            <input type="text" name="agencyName" defaultValue={record?.agencyName ?? ''} />
          </label>

          <label className="user-detail__action-label">
            <span>Reporting hotline</span>
            <input type="text" name="reportingPhone" defaultValue={record?.reportingPhone ?? ''} />
          </label>

          <label className="user-detail__action-label">
            <span>Reporting portal (URL)</span>
            <input type="url" name="reportingUrl" defaultValue={record?.reportingUrl ?? ''} />
          </label>

          <label className="user-detail__action-label">
            <span>Statutory window (hours)</span>
            <input
              type="number"
              name="statutoryDeadlineHours"
              min={1}
              max={8760}
              defaultValue={record?.statutoryDeadlineHours ?? ''}
            />
          </label>
          <p className="user-detail__hint">
            Leave empty when the window is not yet established. Empty is recorded as unknown and
            surfaces on every case in this state as &ldquo;state window not established&rdquo; — a
            guessed number would be worse than a visibly missing one.
          </p>

          <label className="user-detail__action-label">
            <span>Platform&apos;s reporting duty</span>
            <select name="platformRole" defaultValue={record?.platformRole ?? 'undetermined'}>
              {PLATFORM_ROLES.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
          </label>
          <p className="user-detail__hint">
            &ldquo;Undetermined&rdquo; is a to-do for compliance, not a finding that no duty exists.
          </p>

          <label className="user-detail__action-label">
            <span>Statute citation</span>
            <input
              type="text"
              name="statuteCitation"
              defaultValue={record?.statuteCitation ?? ''}
            />
          </label>

          <label className="user-detail__action-label">
            <span>Working notes</span>
            <textarea name="notes" rows={4} defaultValue={record?.notes ?? ''} />
          </label>
          <p className="user-detail__hint">
            Commentary about the row — not part of what an attestation covers, so editing this alone
            does not withdraw verification.
          </p>

          <button type="submit" className="user-detail__action-button">
            {record === null ? `Create the ${stateCode} kit` : 'Save details'}
          </button>
        </form>
      </section>

      {record !== null && (
        <section className="user-detail__section">
          <h2>Attestation</h2>
          <div className="user-detail__actions-grid">
            {!verified && (
              <details className="user-detail__action-card">
                <summary>Attest that this row is correct</summary>
                <form action={setVerificationAction} className="user-detail__action-form">
                  <input type="hidden" name="stateCode" value={stateCode} />
                  <input type="hidden" name="verified" value="true" />
                  <p className="user-detail__hint">
                    You are recording that the agency, hotline, portal, statutory window, and
                    reporting duty above match the counsel-reviewed source for {stateCode}. Your
                    user id is stored with the attestation. This unblocks filing preparation for
                    every case in this state.
                  </p>
                  <label className="user-detail__action-label">
                    <span>Notes (optional — e.g. which source, reviewed when)</span>
                    <textarea name="notes" rows={3} />
                  </label>
                  <button type="submit" className="user-detail__action-button">
                    Attest
                  </button>
                </form>
              </details>
            )}
            {verified && (
              <details className="user-detail__action-card">
                <summary>Withdraw this attestation</summary>
                <form action={setVerificationAction} className="user-detail__action-form">
                  <input type="hidden" name="stateCode" value={stateCode} />
                  <input type="hidden" name="verified" value="false" />
                  <p className="user-detail__hint">
                    Use this when {stateCode}&apos;s reporting law has changed and the row is now
                    stale. Withdrawal takes the state out of service — filing preparation is blocked
                    again — which is the right outcome for a row that may be wrong.
                  </p>
                  <label className="user-detail__action-label">
                    <span>Notes (optional — e.g. what changed)</span>
                    <textarea name="notes" rows={3} />
                  </label>
                  <button type="submit" className="user-detail__action-button">
                    Withdraw
                  </button>
                </form>
              </details>
            )}
          </div>
        </section>
      )}
    </>
  );
}

type Banner =
  | { readonly kind: 'ok'; readonly code: string }
  | { readonly kind: 'err'; readonly detail: string | null };

function readBanner(
  search: Record<string, string | string[] | undefined> | undefined,
): Banner | null {
  if (search === undefined) return null;
  const action = search['action'];
  if (action === 'ok') {
    return { kind: 'ok', code: typeof search['code'] === 'string' ? search['code'] : 'saved' };
  }
  if (action === 'err') return { kind: 'err', detail: readDetailParam(search) };
  return null;
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        {banner.code === 'attested'
          ? 'Attested. Filing preparation is now available in this state.'
          : banner.code === 'withdrawn'
            ? 'Attestation withdrawn. Filing preparation is blocked in this state until it is attested again.'
            : 'Saved. If this row was verified and a substantive field changed, its attestation has been withdrawn — check the status above.'}
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      {banner.detail ?? 'Something went wrong. Nothing was changed. Please try again.'}
    </p>
  );
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

/**
 * `'missing'` (404 — no row for this state yet, so the editor renders as a
 * create form) is distinguished from `null` (service unreachable). Collapsing
 * them would let an outage present as "no kit row exists" and invite an
 * operator to re-enter a row that is already there.
 */
async function fetchJurisdiction(
  stateCode: string,
): Promise<MandatedReporterJurisdictionRecord | 'missing' | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/trust-safety/mandated-reporter/jurisdictions/${encodeURIComponent(stateCode)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'client_error' && result.status === 404) return 'missing';
  if (result.kind !== 'ok') return null;
  const parsed = MandatedReporterJurisdictionResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.jurisdiction : null;
}
