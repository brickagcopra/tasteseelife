import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { MeResponseSchema, type MeResponse } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

import { createAuthorAction } from '../actions';

export const metadata: Metadata = {
  title: 'Content — new author — Taste & See Admin',
};

/**
 * Create-author form (TS-283). Creates an author profile (userId + display name +
 * optional bio / photo / social links). Gated on `content:edit`.
 */
export default async function NewAuthorPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const errored = search?.['action'] === 'err';
  const code = typeof search?.['code'] === 'string' ? (search['code'] as string) : 'unknown';

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
  if (!hasPermission(me, 'content:edit')) redirect('/dashboard/no-access');

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — Content</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/content/authors" className="dash-logout">
            Back to authors
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>New author</h1>
        <p>
          Create an author profile. The user id binds this byline to a service-identity account and
          must be unique.
        </p>

        {errored && (
          <p className="auth-alert" role="alert">
            Couldn&apos;t create the author ({code}). Check the user id is unique.
          </p>
        )}

        <section className="user-detail__section">
          <form
            action={createAuthorAction}
            className="user-detail__action-form concierge-event-form"
          >
            <label className="user-detail__action-label">
              <span>User id (service-identity)</span>
              <input name="userId" required placeholder="usr_..." />
            </label>
            <label className="user-detail__action-label">
              <span>Display name</span>
              <input name="displayName" required placeholder="Ada Writer" />
            </label>
            <label className="user-detail__action-label">
              <span>Bio (optional)</span>
              <textarea name="bio" rows={3} />
            </label>
            <label className="user-detail__action-label">
              <span>Photo (media asset key, optional)</span>
              <input name="photoAssetKey" />
            </label>
            <h3 className="user-detail__subhead">Social links (optional, http/https)</h3>
            <label className="user-detail__action-label">
              <span>Twitter / X</span>
              <input name="social_twitter" type="url" />
            </label>
            <label className="user-detail__action-label">
              <span>LinkedIn</span>
              <input name="social_linkedin" type="url" />
            </label>
            <label className="user-detail__action-label">
              <span>GitHub</span>
              <input name="social_github" type="url" />
            </label>
            <label className="user-detail__action-label">
              <span>Website</span>
              <input name="social_website" type="url" />
            </label>
            <div className="user-detail__action-row">
              <button type="submit" className="user-detail__action-button">
                Create author
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
