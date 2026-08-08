import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ContentAuthorResponseSchema,
  MeResponseSchema,
  type AuthorSocialLinks,
  type ContentAuthorRecord,
  type MeResponse,
  type ResolvedMediaAsset,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { resolveAssetKeys } from '@/lib/media-preview';
import { MediaPreviewGrid } from '../../../_components/media-preview';

import { updateAuthorAction } from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Content — author profile — Taste & See Admin',
};

/**
 * Author-profile editor (TS-283). Edit display name, bio, photo, and social
 * links. Gated on `content:read`; the edit form renders only for `content:edit`.
 */
export default async function AuthorEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ authorId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { authorId } = await params;
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
  if (!hasPermission(me, 'content:read')) redirect('/dashboard/no-access');

  const canEdit = hasPermission(me, 'content:edit');
  const author = await fetchAuthor(authorId);
  if (author === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Author not found</h1>
          <p className="user-detail__hint">
            <Link href="/content/authors">← Back to authors</Link>
          </p>
        </main>
      </div>
    );
  }

  const update = updateAuthorAction.bind(null, authorId);
  const social: AuthorSocialLinks = author.socialLinks ?? {};

  // TS-282-followup-5b — the byline photo was rendered as its key string, so an
  // editor could not tell a working reference from a typo. `media:read` is a
  // separate grant from `content:read`; without it we say so rather than
  // showing an empty frame.
  const canPreviewMedia = hasPermission(me, 'media:read');
  const photoPreviews =
    author.photoAssetKey === null || !canPreviewMedia
      ? []
      : await resolveAssetKeys([author.photoAssetKey]);

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
        <h1>{author.displayName}</h1>
        <dl className="concierge-detail__facts">
          <FactItem label="User id">
            <code>{author.userId}</code>
          </FactItem>
        </dl>

        {banner !== null && <ActionBanner banner={banner} />}

        <AuthorPhotoSection
          photoAssetKey={author.photoAssetKey}
          previews={photoPreviews}
          canPreview={canPreviewMedia}
        />

        {canEdit ? (
          <section className="user-detail__section">
            <h2>Profile</h2>
            <p className="user-detail__hint">
              Leave bio / photo / a social link blank to clear it. The user id is immutable.
            </p>
            <form action={update} className="user-detail__action-form concierge-event-form">
              <label className="user-detail__action-label">
                <span>Display name</span>
                <input name="displayName" defaultValue={author.displayName} required />
              </label>
              <label className="user-detail__action-label">
                <span>Bio</span>
                <textarea name="bio" rows={3} defaultValue={author.bio ?? ''} />
              </label>
              <label className="user-detail__action-label">
                <span>Photo (media asset key)</span>
                <input name="photoAssetKey" defaultValue={author.photoAssetKey ?? ''} />
              </label>
              <h3 className="user-detail__subhead">Social links (http/https)</h3>
              <label className="user-detail__action-label">
                <span>Twitter / X</span>
                <input name="social_twitter" type="url" defaultValue={social.twitter ?? ''} />
              </label>
              <label className="user-detail__action-label">
                <span>LinkedIn</span>
                <input name="social_linkedin" type="url" defaultValue={social.linkedin ?? ''} />
              </label>
              <label className="user-detail__action-label">
                <span>GitHub</span>
                <input name="social_github" type="url" defaultValue={social.github ?? ''} />
              </label>
              <label className="user-detail__action-label">
                <span>Website</span>
                <input name="social_website" type="url" defaultValue={social.website ?? ''} />
              </label>
              <div className="user-detail__action-row">
                <button type="submit" className="user-detail__action-button">
                  Save profile
                </button>
              </div>
            </form>
          </section>
        ) : (
          <ReadOnlyProfile author={author} />
        )}
      </main>
    </div>
  );
}

/**
 * The byline photo, as a picture rather than as a key (TS-282-followup-5b).
 *
 * Renders for readers and editors alike: an editor about to change the key
 * needs to see what the current one points at, and a reader reviewing a byline
 * needs the same. `content:read` does not imply `media:read`, so the
 * permission-less case is spelled out instead of leaving a blank panel.
 */
function AuthorPhotoSection({
  photoAssetKey,
  previews,
  canPreview,
}: {
  readonly photoAssetKey: string | null;
  readonly previews: readonly ResolvedMediaAsset[];
  readonly canPreview: boolean;
}): React.JSX.Element | null {
  if (photoAssetKey === null) return null;
  return (
    <section className="user-detail__section">
      <h2>Photo</h2>
      {canPreview ? (
        <MediaPreviewGrid assets={previews} emptyLabel="No photo is set for this author." />
      ) : (
        <>
          <p className="user-detail__hint">
            You do not hold <code>media:read</code>, so the photo cannot be shown here.
          </p>
          <dl className="concierge-detail__facts">
            <FactItem label="Photo key">
              <code>{photoAssetKey}</code>
            </FactItem>
          </dl>
        </>
      )}
    </section>
  );
}

function ReadOnlyProfile({ author }: { readonly author: ContentAuthorRecord }): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Profile</h2>
      <dl className="concierge-detail__facts">
        {author.bio !== null && <FactItem label="Bio">{author.bio}</FactItem>}
        {/* The photo lives in its own section above, rendered rather than
            printed as a key string. */}
      </dl>
    </section>
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

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Saved.
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      Something went wrong ({banner.code}). Please try again.
    </p>
  );
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchAuthor(authorId: string): Promise<ContentAuthorRecord | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/content/authors/${encodeURIComponent(authorId)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = ContentAuthorResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.author : null;
}
