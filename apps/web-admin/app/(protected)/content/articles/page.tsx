import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ArticlesListResponseSchema,
  MeResponseSchema,
  type ArticleRecord,
  type ArticlesListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Content — articles — Taste & See Admin',
};

/**
 * Blog / help-center article list (TS-281; PRD §10.10; PDD §19.1). The web-admin
 * authoring surface over the service-content article write API (TS-284-followup-3)
 * via the gateway BFF. Page-gated on `content:read`; the gateway + service-content
 * re-enforce it (defence-in-depth).
 */
export default async function ArticlesPage({
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
        <ServiceWarning />
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasPermission(me, 'content:read')) redirect('/dashboard/no-access');

  const canEdit = hasPermission(me, 'content:edit');
  const list = await fetchArticles();

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
          <Link href="/dashboard" className="dash-logout">
            Back to console
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Content — articles</h1>
        <p>
          Blog posts and help-center articles. Authoring is dual-mode (rich text or Markdown); a
          draft goes live when you publish a version. Gated on <code>content:read</code> (editing on{' '}
          <code>content:edit</code>, publishing on <code>content:publish</code>).
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        {canEdit && (
          <p className="user-detail__hint">
            <Link href="/content/articles/new">+ New article</Link>
          </p>
        )}

        <section className="user-detail__section">
          <h2>All articles</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load articles right now. The content service may be unreachable.
            </p>
          ) : (
            <ArticleList list={list} />
          )}
        </section>
      </main>
    </div>
  );
}

function ArticleList({ list }: { readonly list: ArticlesListResponse }): React.JSX.Element {
  if (list.articles.length === 0) {
    return (
      <div className="user-empty">
        <p>No articles yet.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.articles.map((article) => (
        <ArticleRow key={article.id} article={article} />
      ))}
    </ul>
  );
}

function ArticleRow({ article }: { readonly article: ArticleRecord }): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <Link
          href={`/content/articles/${encodeURIComponent(article.id)}`}
          className="concierge-event-card__title"
        >
          {article.title}
        </Link>
        <StatusChip status={article.status} />
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Slug">
          <code>{article.slug}</code>
        </FactItem>
        {article.categoryId !== null && <FactItem label="Category">{article.categoryId}</FactItem>}
        <FactItem label="Updated">{formatDateTime(article.updatedAt)}</FactItem>
      </dl>
      <p className="user-detail__hint">
        <Link href={`/content/articles/${encodeURIComponent(article.id)}`}>Open editor →</Link>
      </p>
    </li>
  );
}

function StatusChip({ status }: { readonly status: ArticleRecord['status'] }): React.JSX.Element {
  const cls =
    status === 'published'
      ? 'user-row__chip user-row__chip--ok'
      : status === 'archived'
        ? 'user-row__chip user-row__chip--warn'
        : 'user-row__chip';
  return <span className={cls}>{status}</span>;
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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
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

async function fetchArticles(): Promise<ArticlesListResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/content/articles');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = ArticlesListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function ServiceWarning(): React.JSX.Element {
  return (
    <main className="dash-main">
      <h1>We&apos;re having a moment</h1>
      <p>Our service is briefly unreachable. Please refresh in a few seconds.</p>
    </main>
  );
}
