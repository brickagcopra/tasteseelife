import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MeResponseSchema,
  ORG_SECURITY_POLICY_GLOBAL_SCOPE_ID,
  OrgSecurityPoliciesListResponseSchema,
  type MeResponse,
  type OrgSecurityPoliciesListResponse,
  type OrgSecurityPolicyRecord,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

import { upsertPolicyAction } from './actions';

export const metadata: Metadata = {
  title: 'RBAC — security policies — Taste & See Admin',
};

/**
 * Org security-policy surface (TS-296; CLAUDE.md §3.1; PDD §10.1).
 * Flags keyed by tenant scope id (or the `'global'` sentinel row that
 * governs global-scoped staff). `ssoRequired: true` makes identity
 * refuse a non-SSO-asserted admin login for that scope — and since
 * the SSO provider integration hasn't landed yet, flipping it on
 * locks those staff out until it does. The copy says so plainly.
 *
 * Page-gated `rbac:read`; mutations `rbac:write` (gateway + identity
 * re-enforce both, defence-in-depth). Zero client JS — plain forms.
 */
export default async function SecurityPoliciesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const action = typeof search?.['action'] === 'string' ? search['action'] : null;
  const errCode = typeof search?.['code'] === 'string' ? search['code'] : null;

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
  if (!hasPermission(me, 'rbac:read')) redirect('/dashboard/no-access');

  const canWrite = hasPermission(me, 'rbac:write');
  const list = await fetchPolicies();

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
        <h1>Org security policies</h1>
        <p>
          Sign-in requirements per organization scope. Turning <strong>SSO required</strong> on
          means staff whose admin roles touch that scope can only sign in through single sign-on —
          the row <code>{ORG_SECURITY_POLICY_GLOBAL_SCOPE_ID}</code> governs global-scoped staff.
          Viewing gated on <code>rbac:read</code>, changes on <code>rbac:write</code>.
        </p>
        <p className="auth-alert auth-alert--info" role="note">
          Heads-up: single sign-on itself isn&apos;t connected yet. Requiring SSO for a scope today
          will keep its staff from signing in until the SSO integration lands — best kept off
          outside of testing.
        </p>

        {action === 'ok' && (
          <div className="auth-alert auth-alert--info" role="status">
            Policy saved.
          </div>
        )}
        {action === 'err' && (
          <div className="auth-alert" role="alert">
            {errCode === 'forbidden'
              ? 'You need rbac:write to change security policies.'
              : errCode === 'invalid-input'
                ? 'That scope id did not look right. Letters, digits, dashes, underscores.'
                : 'We could not save that just now. Please try again shortly.'}
          </div>
        )}

        <section className="user-detail__section">
          <h2>Policies</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load policies right now. The identity service may be unreachable.
            </p>
          ) : (
            <PolicyList list={list} canWrite={canWrite} />
          )}
        </section>

        {canWrite && (
          <section className="user-detail__section">
            <h2>Add a scope</h2>
            <form action={upsertPolicyAction} className="user-detail__form">
              <label htmlFor="new-scope-id">
                Scope id (a partner tenant id, or <code>{ORG_SECURITY_POLICY_GLOBAL_SCOPE_ID}</code>
                )
              </label>
              <input
                id="new-scope-id"
                name="scopeId"
                type="text"
                required
                maxLength={64}
                pattern="[a-zA-Z0-9_\-]+"
                autoComplete="off"
              />
              <input type="hidden" name="ssoRequired" value="true" />
              <button type="submit">Add with SSO required</button>
            </form>
          </section>
        )}
      </main>
    </div>
  );
}

function PolicyList({
  list,
  canWrite,
}: {
  readonly list: OrgSecurityPoliciesListResponse;
  readonly canWrite: boolean;
}): React.JSX.Element {
  if (list.policies.length === 0) {
    return (
      <div className="user-empty">
        <p>
          No policies yet — every scope signs in with password + MFA. Add a scope below to require
          SSO for its staff.
        </p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.policies.map((policy) => (
        <PolicyRow key={policy.id} policy={policy} canWrite={canWrite} />
      ))}
    </ul>
  );
}

function PolicyRow({
  policy,
  canWrite,
}: {
  readonly policy: OrgSecurityPolicyRecord;
  readonly canWrite: boolean;
}): React.JSX.Element {
  return (
    <li className="concierge-event-list__item">
      <div>
        <strong>{policy.scopeId}</strong>{' '}
        <span className={policy.ssoRequired ? 'status-chip status-chip--active' : 'status-chip'}>
          {policy.ssoRequired ? 'SSO required' : 'SSO not required'}
        </span>
      </div>
      <div className="user-detail__hint">
        Updated <time dateTime={policy.updatedAt}>{policy.updatedAt.slice(0, 10)}</time>
      </div>
      {canWrite && (
        <form action={upsertPolicyAction}>
          <input type="hidden" name="scopeId" value={policy.scopeId} />
          <input type="hidden" name="ssoRequired" value={policy.ssoRequired ? 'false' : 'true'} />
          <button type="submit">{policy.ssoRequired ? 'Stop requiring SSO' : 'Require SSO'}</button>
        </form>
      )}
    </li>
  );
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchPolicies(): Promise<OrgSecurityPoliciesListResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/org-security-policies');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = OrgSecurityPoliciesListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
