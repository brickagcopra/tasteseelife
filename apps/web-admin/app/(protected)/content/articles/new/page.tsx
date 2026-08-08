import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  HelpCategoriesListResponseSchema,
  MeResponseSchema,
  type HelpCategoriesListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

import { createArticleAction } from '../actions';

export const metadata: Metadata = {
  title: 'Content — new article — Taste & See Admin',
};

/**
 * Create-article form (TS-281). Creates the article shell (slug + title +
 * optional category); the first version is added on the editor page. Gated on
 * `content:edit`.
 */
export default async function NewArticlePage({
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

  const categories = await fetchCategories();

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
        <h1>New article</h1>
        <p>
          Create the article, then add and publish its first version on the editor. The slug must be
          lowercase kebab-case and unique.
        </p>

        {errored && (
          <p className="auth-alert" role="alert">
            Couldn&apos;t create the article ({code}). Check the slug is unique + kebab-case.
          </p>
        )}

        <section className="user-detail__section">
          <form
            action={createArticleAction}
            className="user-detail__action-form concierge-event-form"
          >
            <label className="user-detail__action-label">
              <span>Title</span>
              <input name="title" required placeholder="Welcoming the seasons" />
            </label>
            <label className="user-detail__action-label">
              <span>Slug</span>
              <input
                name="slug"
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder="welcoming-the-seasons"
              />
            </label>
            <label className="user-detail__action-label">
              <span>Category (optional)</span>
              <select name="categoryId" defaultValue="">
                <option value="">— none —</option>
                {(categories?.categories ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="user-detail__action-row">
              <button type="submit" className="user-detail__action-button">
                Create article
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

async function fetchCategories(): Promise<HelpCategoriesListResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/content/help-categories');
  if (result.kind !== 'ok') return null;
  const parsed = HelpCategoriesListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
