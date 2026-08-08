import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ContentAuthorsListResponseSchema,
  MeResponseSchema,
  type ContentAuthorRecord,
  type ContentAuthorsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Content — authors — Taste & See Admin',
};

/**
 * Content author-profile list (TS-283; PRD §10.10; PDD §19.1). The web-admin
 * surface over the service-content author write API via the gateway BFF.
 * Page-gated on `content:read`; the gateway + service-content re-enforce it
 * (defence-in-depth).
 */
export default async function AuthorsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
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
  const list = await fetchAuthors();

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
          <Link href="/content/articles" className="dash-logout">
            Back to articles
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Content — authors</h1>
        <p>
          Author profiles power article bylines. Gated on <code>content:read</code> (editing on{' '}
          <code>content:edit</code>).
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        {canEdit && (
          <p className="user-detail__hint">
            <Link href="/content/authors/new">+ New author</Link>
          </p>
        )}

        <section className="user-detail__section">
          <h2>All authors</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load authors right now. The content service may be unreachable.
            </p>
          ) : (
            <AuthorList list={list} />
          )}
        </section>
      </main>
    </div>
  );
}

function AuthorList({ list }: { readonly list: ContentAuthorsListResponse }): React.JSX.Element {
  if (list.authors.length === 0) {
    return (
      <div className="user-empty">
        <p>No authors yet.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.authors.map((author) => (
        <AuthorRow key={author.id} author={author} />
      ))}
    </ul>
  );
}

function AuthorRow({ author }: { readonly author: ContentAuthorRecord }): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <Link
          href={`/content/authors/${encodeURIComponent(author.id)}`}
          className="concierge-event-card__title"
        >
          {author.displayName}
        </Link>
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="User">
          <code>{author.userId}</code>
        </FactItem>
        {author.bio !== null && <FactItem label="Bio">{author.bio}</FactItem>}
      </dl>
      <p className="user-detail__hint">
        <Link href={`/content/authors/${encodeURIComponent(author.id)}`}>Open profile →</Link>
      </p>
    </li>
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

async function fetchAuthors(): Promise<ContentAuthorsListResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/content/authors');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = ContentAuthorsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
