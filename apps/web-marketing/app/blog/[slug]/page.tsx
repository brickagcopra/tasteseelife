import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContentMarkdown } from '@taste-and-see/ui';
import type { PublicBlogAuthor } from '@taste-and-see/contracts';

import { BlogShell } from '@/components/blog/blog-shell';
import { DisqusComments } from '@/components/blog/disqus-comments';
import { fetchAllBlogSlugs, fetchBlogArticle } from '@/lib/blog';
import { resolveDisqusEmbed } from '@/lib/comments';

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

interface BlogArticleParams {
  readonly slug: string;
}

/** Prerender every published slug; unknown slugs still render on demand. */
export async function generateStaticParams(): Promise<BlogArticleParams[]> {
  const slugs = await fetchAllBlogSlugs();
  return slugs.map((slug) => ({ slug }));
}

/**
 * TS-282-followup-1 — the stored SEO block becomes the App Router `metadata`
 * export. Null SEO fields fall back to the article's own title / meta
 * description. Social-card images are assetKey references with no public
 * media URL convention yet, so OG/Twitter images are deliberately omitted
 * until one exists.
 */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<BlogArticleParams>;
}): Promise<Metadata> {
  const { slug } = await params;
  const result = await fetchBlogArticle(slug);
  if (!result.ok) return { title: 'Journal — Taste & See' };

  const { article } = result;
  const title = article.seo.seoTitle ?? article.title;
  const description = article.seo.metaDescription ?? undefined;

  return {
    title: `${title} — Taste & See Journal`,
    ...(description !== undefined && { description }),
    alternates: { canonical: article.seo.canonicalUrl ?? `/blog/${article.slug}` },
    openGraph: {
      type: 'article',
      title: article.seo.ogTitle ?? title,
      ...((article.seo.ogDescription ?? description)
        ? { description: article.seo.ogDescription ?? description }
        : {}),
      publishedTime: article.publishedAt,
      ...(article.authors.length > 0 && {
        authors: article.authors.map((a) => a.displayName),
      }),
    },
    twitter: {
      card: article.seo.twitterCard ?? 'summary',
      title: article.seo.twitterTitle ?? title,
      ...((article.seo.twitterDescription ?? description)
        ? { description: article.seo.twitterDescription ?? description }
        : {}),
    },
  };
}

export default async function BlogArticlePage({
  params,
}: {
  readonly params: Promise<BlogArticleParams>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const result = await fetchBlogArticle(slug);

  if (!result.ok) {
    if (result.reason === 'not_found') notFound();
    return (
      <BlogShell>
        <section className="section">
          <div className="wrap blog-article">
            <p className="blog-empty" role="status">
              This story is briefly away from the table. Please check back in a little while.
            </p>
          </div>
        </section>
      </BlogShell>
    );
  }

  const { article } = result;

  // TS-289-followup-1 — Disqus decision runs server-side; the client chunk
  // only ships when every gate (shortname env, config present, provider)
  // passes, and even then nothing contacts Disqus until the reader clicks.
  const disqus = resolveDisqusEmbed({
    comments: article.comments,
    slug: article.slug,
    canonicalUrl: article.seo.canonicalUrl,
    shortname: process.env['NEXT_PUBLIC_DISQUS_SHORTNAME'],
    siteOrigin: process.env['NEXT_PUBLIC_SITE_ORIGIN'],
  });

  return (
    <BlogShell>
      <article className="section">
        <div className="wrap blog-article">
          <div className="blog-card-meta">
            {article.category !== null && (
              <Link className="mono" href={`/blog?category=${article.category.slug}`}>
                {article.category.name}
              </Link>
            )}
            <time className="mono" dateTime={article.publishedAt}>
              {DATE_FORMAT.format(new Date(article.publishedAt))}
            </time>
          </div>

          <h1 className="serif blog-title">{article.title}</h1>

          {article.authors.length > 0 && <Byline authors={article.authors} />}

          <ContentMarkdown markdown={article.body} className="blog-body" />

          {disqus !== null && <DisqusComments config={disqus} />}

          <p style={{ marginTop: 48 }}>
            <Link className="btn btn-ghost" href="/blog">
              Back to the journal
            </Link>
          </p>
        </div>
      </article>
      {article.seo.jsonLd !== null && <JsonLd data={article.seo.jsonLd} />}
    </BlogShell>
  );
}

/** Ordered byline (TS-281-followup-5). Photos are assetKey references with no
 *  public media URL convention yet, so authors render an initials avatar. */
function Byline({ authors }: { readonly authors: readonly PublicBlogAuthor[] }): React.JSX.Element {
  return (
    <ul className="blog-byline" aria-label="Authors">
      {authors.map((author, index) => (
        // Byline position is the identity — the same profile can only appear
        // once per article, but display names are not unique across profiles.
        // eslint-disable-next-line react/no-array-index-key
        <li key={`${index}-${author.displayName}`} className="blog-byline-author">
          <span className="blog-byline-avatar" aria-hidden="true">
            {author.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <span className="blog-byline-name">
              {author.displayName}
              {author.role === 'co_author' && <span className="mono"> · co-author</span>}
            </span>
            {author.bio !== null && <span className="blog-byline-bio">{author.bio}</span>}
            {author.socialLinks !== null && <SocialLinks links={author.socialLinks} />}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SocialLinks({
  links,
}: {
  readonly links: NonNullable<PublicBlogAuthor['socialLinks']>;
}): React.JSX.Element {
  const entries: ReadonlyArray<readonly [string, string | undefined]> = [
    ['Website', links.website],
    ['LinkedIn', links.linkedin],
    ['Twitter', links.twitter],
    ['GitHub', links.github],
  ];
  return (
    <span className="blog-byline-links">
      {entries
        .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
        .map(([label, href]) => (
          <a key={label} href={href} rel="noopener noreferrer" target="_blank">
            {label}
          </a>
        ))}
    </span>
  );
}

/**
 * The editor-authored schema.org JSON-LD block (TS-282-followup-1). The value
 * was validated to be a JSON object at write time (bounded, `content:edit`
 * staff only); it is re-serialized here with every literal angle bracket
 * unicode-escaped (u003c), so the payload can never close its own
 * `<script>` tag or open another element
 * — the one place on this page a raw HTML sink exists, and it never carries
 * Markdown/user content (ADR-0004 §4 posture; article bodies go through
 * `ContentMarkdown`).
 */
function JsonLd({ data }: { readonly data: Record<string, unknown> }): React.JSX.Element {
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c');
  return (
    // eslint-disable-next-line react/no-danger -- JSON-LD requires a raw script body; payload is JSON.stringify-escaped above, never HTML/user content.
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJson }} />
  );
}
