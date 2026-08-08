import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ArticleAuthorsResponseSchema,
  ArticleDetailResponseSchema,
  ContentAuthorsListResponseSchema,
  HelpCategoriesListResponseSchema,
  MeResponseSchema,
  type ArticleAuthor,
  type ArticleComments,
  type ArticleDetail,
  type ArticleSeo,
  type ArticleVersionRecord,
  type ContentAuthorRecord,
  type HelpCategoriesListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

import { ArticleEditorField } from '../../_components/article-editor-field';
import {
  appendArticleVersionAction,
  publishArticleVersionAction,
  sendArticleToNewsletterAction,
  setArticleAuthorsAction,
  updateArticleCommentsAction,
  updateArticleMetadataAction,
  updateArticleSeoAction,
} from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

/** Ordered byline slots the editor renders (matches actions.ts). */
const AUTHOR_SLOTS = 8;

export const metadata: Metadata = {
  title: 'Content — article editor — Taste & See Admin',
};

/**
 * Article editor (TS-281; PRD §10.10; PDD §19.1). Rename / recategorise, append a
 * new draft version (dual-mode rich-text / Markdown, ADR-0004), publish a version
 * live, and browse the append-only version history. Gated on `content:read`;
 * editing affordances render only for `content:edit`, the publish lever only for
 * `content:publish` — the gateway + service-content re-enforce each (defence-in-
 * depth).
 */
export default async function ArticleEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ articleId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { articleId } = await params;
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
  const canPublish = hasPermission(me, 'content:publish');

  const detail = await fetchArticle(articleId);
  if (detail === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Article not found</h1>
          <p className="user-detail__hint">
            <Link href="/content/articles">← Back to articles</Link>
          </p>
        </main>
      </div>
    );
  }
  const categories = await fetchCategories();
  const allAuthors = await fetchAuthors();
  const byline = await fetchArticleAuthors(articleId);
  const latestVersion = detail.versions[0];

  const updateMetadata = updateArticleMetadataAction.bind(null, articleId);
  const updateSeo = updateArticleSeoAction.bind(null, articleId);
  const updateComments = updateArticleCommentsAction.bind(null, articleId);
  const appendVersion = appendArticleVersionAction.bind(null, articleId);
  const setAuthors = setArticleAuthorsAction.bind(null, articleId);
  const sendNewsletter = sendArticleToNewsletterAction.bind(null, articleId);

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
        <h1>{detail.title}</h1>
        <dl className="concierge-detail__facts">
          <FactItem label="Status">{detail.status}</FactItem>
          <FactItem label="Slug">
            <code>{detail.slug}</code>
          </FactItem>
          <FactItem label="Current version">
            {detail.currentVersionId ?? '— none published —'}
          </FactItem>
        </dl>

        {banner !== null && <ActionBanner banner={banner} />}

        {canEdit && (
          <section className="user-detail__section">
            <h2>Metadata</h2>
            <form action={updateMetadata} className="user-detail__action-form concierge-event-form">
              <label className="user-detail__action-label">
                <span>Title</span>
                <input name="title" defaultValue={detail.title} />
              </label>
              <label className="user-detail__action-label">
                <span>Category (empty = uncategorise)</span>
                <select name="categoryId" defaultValue={detail.categoryId ?? ''}>
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
                  Save metadata
                </button>
              </div>
            </form>
          </section>
        )}

        {canEdit && <SeoSection seo={detail.seo} action={updateSeo} />}

        {canEdit && <CommentsSection comments={detail.comments} action={updateComments} />}

        {canPublish && (
          <NewsletterSection
            status={detail.status}
            newsletterSentAt={detail.newsletterSentAt}
            action={sendNewsletter}
          />
        )}

        <AuthorsSection
          byline={byline}
          allAuthors={allAuthors?.authors ?? []}
          canEdit={canEdit}
          action={setAuthors}
        />

        {canEdit && (
          <section className="user-detail__section">
            <h2>Add a version</h2>
            <p className="user-detail__hint">
              Saving creates a new draft revision. It goes live only when you publish it below.
            </p>
            <form action={appendVersion} className="user-detail__action-form concierge-event-form">
              <label className="user-detail__action-label">
                <span>Version title</span>
                <input name="title" required defaultValue={latestVersion?.title ?? detail.title} />
              </label>
              <div className="user-detail__action-label">
                <span>Body</span>
                <ArticleEditorField name="body" defaultValue={latestVersion?.body ?? ''} />
              </div>
              <div className="user-detail__action-row">
                <button type="submit" className="user-detail__action-button">
                  Save version
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="user-detail__section">
          <h2>Version history</h2>
          <VersionHistory detail={detail} articleId={articleId} canPublish={canPublish} />
        </section>
      </main>
    </div>
  );
}

function VersionHistory({
  detail,
  articleId,
  canPublish,
}: {
  readonly detail: ArticleDetail;
  readonly articleId: string;
  readonly canPublish: boolean;
}): React.JSX.Element {
  if (detail.versions.length === 0) {
    return (
      <div className="user-empty">
        <p>No versions yet — add one above.</p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {detail.versions.map((version) => (
        <VersionRow
          key={version.id}
          version={version}
          articleId={articleId}
          isCurrent={version.id === detail.currentVersionId}
          canPublish={canPublish}
        />
      ))}
    </ul>
  );
}

function VersionRow({
  version,
  articleId,
  isCurrent,
  canPublish,
}: {
  readonly version: ArticleVersionRecord;
  readonly articleId: string;
  readonly isCurrent: boolean;
  readonly canPublish: boolean;
}): React.JSX.Element {
  const publish = publishArticleVersionAction.bind(null, articleId, version.id);
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">Version {version.versionNo}</span>
        {isCurrent && <span className="user-row__chip user-row__chip--ok">Live</span>}
        {version.effectiveAt !== null && (
          <span className="user-row__chip">Effective {formatDateTime(version.effectiveAt)}</span>
        )}
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Title">{version.title}</FactItem>
        <FactItem label="Saved">{formatDateTime(version.createdAt)}</FactItem>
      </dl>
      {canPublish && !isCurrent && (
        <form action={publish} className="user-detail__action-form">
          <label className="user-detail__action-label">
            <span>Effective at (UTC, optional — blank = now)</span>
            <input type="datetime-local" name="effectiveAt" />
          </label>
          <div className="user-detail__action-row">
            <button type="submit" className="user-detail__action-button">
              Publish this version
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function NewsletterSection({
  status,
  newsletterSentAt,
  action,
}: {
  readonly status: ArticleDetail['status'];
  readonly newsletterSentAt: string | null;
  readonly action: (formData: FormData) => void;
}): React.JSX.Element {
  const isPublished = status === 'published';
  const alreadySent = newsletterSentAt !== null;
  return (
    <section className="user-detail__section">
      <h2>Newsletter</h2>
      <p className="user-detail__hint">
        Send this post to all opt-in newsletter subscribers. Only a published post can be sent, and
        a post can be sent once.
      </p>
      {alreadySent ? (
        <p className="auth-alert auth-alert--info" role="status">
          Sent to the newsletter on {formatDateTime(newsletterSentAt)}.
        </p>
      ) : !isPublished ? (
        <p className="user-detail__hint">Publish a version first to enable sending.</p>
      ) : (
        <form action={action} className="user-detail__action-form">
          <div className="user-detail__action-row">
            <button type="submit" className="user-detail__action-button">
              Send to newsletter
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function AuthorsSection({
  byline,
  allAuthors,
  canEdit,
  action,
}: {
  readonly byline: readonly ArticleAuthor[];
  readonly allAuthors: readonly ContentAuthorRecord[];
  readonly canEdit: boolean;
  readonly action: (formData: FormData) => void;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Byline &amp; authors</h2>
      {byline.length === 0 ? (
        <p className="user-detail__hint">No authors credited yet.</p>
      ) : (
        <ul className="concierge-event-list">
          {byline.map((entry) => (
            <li key={entry.author.id} className="concierge-event-card">
              <div className="concierge-event-card__head">
                <span className="concierge-event-card__title">{entry.author.displayName}</span>
                <span className="user-row__chip">{entry.role}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canEdit && allAuthors.length === 0 && (
        <p className="user-detail__hint">
          No author profiles exist yet. <Link href="/content/authors/new">Create one</Link> to
          credit a byline.
        </p>
      )}

      {canEdit && allAuthors.length > 0 && (
        <form action={action} className="user-detail__action-form concierge-event-form">
          <p className="user-detail__hint">
            Set the ordered byline — slot 1 is the lead. Leave a slot on &ldquo;— none —&rdquo; to
            omit it. Saving replaces the whole byline.
          </p>
          {Array.from({ length: AUTHOR_SLOTS }, (_, i) => {
            const current = byline[i];
            return (
              <div key={i} className="user-detail__action-label">
                <span>Author {i + 1}</span>
                <select name={`author_${i}`} defaultValue={current?.author.id ?? ''}>
                  <option value="">— none —</option>
                  {allAuthors.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName}
                    </option>
                  ))}
                </select>
                <select name={`role_${i}`} defaultValue={current?.role ?? 'co_author'}>
                  <option value="primary">primary</option>
                  <option value="co_author">co_author</option>
                </select>
              </div>
            );
          })}
          <div className="user-detail__action-row">
            <button type="submit" className="user-detail__action-button">
              Save byline
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function CommentsSection({
  comments,
  action,
}: {
  readonly comments: ArticleComments;
  readonly action: (formData: FormData) => void;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Comments</h2>
      <p className="user-detail__hint">
        Per-post reader comments configuration. The comment thread itself appears on the public blog
        post once the public read surface ships (TS-289-followup-1) — until then this only stores
        the configuration. Moderation routes to Trust &amp; Safety.
      </p>
      <form action={action} className="user-detail__action-form concierge-event-form">
        <label className="user-detail__action-label">
          <span>Comments on this post</span>
          <select name="enabled" defaultValue={comments.enabled ? 'true' : 'false'}>
            <option value="false">Off</option>
            <option value="true">On</option>
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Provider</span>
          <select name="provider" defaultValue={comments.provider}>
            <option value="disqus">Disqus</option>
            <option value="none">None (comments off regardless of the toggle)</option>
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Disqus thread identifier (blank = fall back to the article slug)</span>
          <input
            name="disqusIdentifier"
            defaultValue={comments.disqusIdentifier ?? ''}
            maxLength={256}
            placeholder="e.g. blog-welcoming-the-seasons"
          />
        </label>
        <div className="user-detail__action-row">
          <button type="submit" className="user-detail__action-button">
            Save comments config
          </button>
        </div>
      </form>
    </section>
  );
}

function SeoSection({
  seo,
  action,
}: {
  readonly seo: ArticleSeo;
  readonly action: (formData: FormData) => void;
}): React.JSX.Element {
  const jsonLdText = seo.jsonLd === null ? '' : JSON.stringify(seo.jsonLd, null, 2);
  return (
    <section className="user-detail__section">
      <h2>SEO &amp; social</h2>
      <p className="user-detail__hint">
        Search-engine and social-card metadata for this article. Leave a field blank to clear it;
        the public page falls back to the article title and rendered content.
      </p>
      <form action={action} className="user-detail__action-form concierge-event-form">
        <label className="user-detail__action-label">
          <span>SEO title (the &lt;title&gt; tag)</span>
          <input name="seoTitle" defaultValue={seo.seoTitle ?? ''} maxLength={200} />
        </label>
        <label className="user-detail__action-label">
          <span>Meta description (~155 chars recommended)</span>
          <textarea
            name="metaDescription"
            defaultValue={seo.metaDescription ?? ''}
            maxLength={320}
            rows={2}
          />
        </label>
        <label className="user-detail__action-label">
          <span>Canonical URL (absolute http/https)</span>
          <input name="canonicalUrl" type="url" defaultValue={seo.canonicalUrl ?? ''} />
        </label>

        <h3 className="user-detail__subhead">OpenGraph card</h3>
        <label className="user-detail__action-label">
          <span>OG title</span>
          <input name="ogTitle" defaultValue={seo.ogTitle ?? ''} maxLength={200} />
        </label>
        <label className="user-detail__action-label">
          <span>OG description</span>
          <textarea
            name="ogDescription"
            defaultValue={seo.ogDescription ?? ''}
            maxLength={500}
            rows={2}
          />
        </label>
        <label className="user-detail__action-label">
          <span>OG image (media asset key)</span>
          <input name="ogImageKey" defaultValue={seo.ogImageKey ?? ''} maxLength={256} />
        </label>

        <h3 className="user-detail__subhead">Twitter card</h3>
        <label className="user-detail__action-label">
          <span>Card type</span>
          <select name="twitterCard" defaultValue={seo.twitterCard ?? ''}>
            <option value="">— none —</option>
            <option value="summary">summary</option>
            <option value="summary_large_image">summary_large_image</option>
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Twitter title</span>
          <input name="twitterTitle" defaultValue={seo.twitterTitle ?? ''} maxLength={200} />
        </label>
        <label className="user-detail__action-label">
          <span>Twitter description</span>
          <textarea
            name="twitterDescription"
            defaultValue={seo.twitterDescription ?? ''}
            maxLength={500}
            rows={2}
          />
        </label>
        <label className="user-detail__action-label">
          <span>Twitter image (media asset key)</span>
          <input name="twitterImageKey" defaultValue={seo.twitterImageKey ?? ''} maxLength={256} />
        </label>

        <label className="user-detail__action-label">
          <span>JSON-LD structured data (a JSON object)</span>
          <textarea
            name="jsonLd"
            defaultValue={jsonLdText}
            rows={6}
            spellCheck={false}
            placeholder='{ "@context": "https://schema.org", "@type": "Article" }'
          />
        </label>

        <div className="user-detail__action-row">
          <button type="submit" className="user-detail__action-button">
            Save SEO
          </button>
        </div>
      </form>
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

async function fetchArticle(articleId: string): Promise<ArticleDetail | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = ArticleDetailResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.article : null;
}

async function fetchCategories(): Promise<HelpCategoriesListResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/content/help-categories');
  if (result.kind !== 'ok') return null;
  const parsed = HelpCategoriesListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchAuthors(): Promise<{
  readonly authors: readonly ContentAuthorRecord[];
} | null> {
  const result = await callGateway<unknown>('/api/v1/admin/content/authors');
  if (result.kind !== 'ok') return null;
  const parsed = ContentAuthorsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchArticleAuthors(articleId: string): Promise<readonly ArticleAuthor[]> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/content/articles/${encodeURIComponent(articleId)}/authors`,
  );
  if (result.kind !== 'ok') return [];
  const parsed = ArticleAuthorsResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.authors : [];
}
