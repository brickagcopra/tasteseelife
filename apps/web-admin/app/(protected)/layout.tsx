import { redirect } from 'next/navigation';

import { AdminUserDetailResponseSchema, MeResponseSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import {
  readAccessToken,
  readImpersonationAccessToken,
  readImpersonationFamilyId,
} from '@/lib/session';
import { endImpersonationAction } from './impersonation-actions';

/**
 * Authenticated-area layout (TS-123; impersonation banner TS-297).
 *
 * Mirrors `apps/web-provider/app/(protected)/layout.tsx`. The role-
 * specific gate (admin role presence + super_admin Phase-1 landing
 * check) lives at the dashboard render boundary because it needs a
 * full `MeResponse` round-trip the cookie check doesn't require. This
 * layout is the cheap cookie-presence gate — defence in depth against
 * a middleware glitch that allows an empty-cookie request through.
 *
 * **Impersonation banner (TS-297).** When the impersonation cookie
 * pair is present (set by `impersonateUserAction`), the layout renders
 * a persistent "Impersonating …" banner with an End control on every
 * authenticated page. The label is derived by calling `/api/v1/me`
 * WITH THE IMPERSONATION TOKEN — the real end-to-end exercise of the
 * `actorOnBehalfOf` claim (identity mint → gateway verify → MeResponse)
 * — enriched with the target's email via the operator's own admin
 * detail read. The non-impersonating path pays ZERO extra round-trips:
 * both fetches are gated on the cookie's presence.
 */
export default async function ProtectedLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const token = await readAccessToken();
  if (token === null) redirect('/login?expired=1');

  const impersonationFamilyId = await readImpersonationFamilyId();

  return (
    <>
      {impersonationFamilyId !== null && <ImpersonationBanner />}
      {children}
    </>
  );
}

async function ImpersonationBanner(): Promise<React.JSX.Element> {
  const label = await impersonationLabel();
  return (
    <div className="impersonation-banner" role="status" aria-live="polite">
      <span className="impersonation-banner__label">
        Impersonating <strong>{label.target}</strong>
        {label.operator !== null && <> — acting operator {label.operator}</>}. Every action is
        recorded in the audit trail.
      </span>
      <form action={endImpersonationAction}>
        <button type="submit" className="impersonation-banner__end">
          End impersonation
        </button>
      </form>
    </div>
  );
}

/**
 * Resolve the banner label. Best-effort by design: an expired
 * impersonation access token (15-minute TTL inside a 1-hour session)
 * degrades to a generic label — the End control is the part that must
 * keep working, and it runs on the family cookie + operator token.
 */
async function impersonationLabel(): Promise<{
  readonly target: string;
  readonly operator: string | null;
}> {
  const impersonationToken = await readImpersonationAccessToken();
  if (impersonationToken === null) {
    return { target: 'a user (session label unavailable)', operator: null };
  }

  const meResult = await callGateway<unknown>('/api/v1/me', {
    authenticated: false,
    headers: { authorization: `Bearer ${impersonationToken}` },
  });
  if (meResult.kind !== 'ok') {
    return { target: 'a user (session label unavailable)', operator: null };
  }
  const me = MeResponseSchema.safeParse(meResult.body);
  if (!me.success || me.data.actorOnBehalfOf === undefined) {
    return { target: 'a user (session label unavailable)', operator: null };
  }

  // Enrich with the target's email through the OPERATOR's own admin
  // read (user:read); fall back to the raw user id.
  const detailResult = await callGateway<unknown>(
    `/api/v1/admin/users/${encodeURIComponent(me.data.userId)}`,
  );
  if (detailResult.kind === 'ok') {
    const detail = AdminUserDetailResponseSchema.safeParse(detailResult.body);
    if (detail.success) {
      return { target: detail.data.user.email, operator: me.data.actorOnBehalfOf };
    }
  }
  return { target: me.data.userId, operator: me.data.actorOnBehalfOf };
}
