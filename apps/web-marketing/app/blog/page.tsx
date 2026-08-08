import type { Metadata } from 'next';
import Link from 'next/link';
import type { PublicBlogArticleListItem } from '@taste-and-see/contracts';

import { BlogShell } from '@/components/blog/blog-shell';
import { fetchBlogIndex } from '@/lib/blog';

export const metadata: Metadata = {
  title: 'Journal — Taste & See',
  description:
    'Notes from the table — care guides, recipes, and stories of aging well at home, from the Taste & See kitchen and care community.',
  alternates: { canonical: '/blog' },
};

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

interface BlogIndexSearchParams {
  readonly page?: string | string[] | undefined;
  readonly category?: string | string[] | undefined;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pageHref(page: number, category: string | undefined): string {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (category !== undefined) params.set('category', category);
  const qs = params.toString();
  return qs.length > 0 ? `/blog?${qs}` : '/blog';
}

export default async function BlogIndexPage({
  searchParams,
}: {
  readonly searchParams: Promise<BlogIndexSearchParams>;
}): Promise<React.JSX.Element> {
  const raw = await searchParams;
  const pageParam = Number.parseInt(firstValue(raw.page) ?? '1', 10);
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
  const category = firstValue(raw.category);

  const result = await fetchBlogIndex({ page, category });

  return (
    <BlogShell>
      <section className="section">
        <div className="wrap">
          <span className="eyebrow">Journal</span>
          <h1 className="serif blog-title">Notes from the table</h1>
          <p className="blog-lede">
            Care guides, recipes, and stories of aging well at home — written by the chefs,
            companions, and care partners who set the table.
          </p>

          {!result.ok ? (
            <p className="blog-empty" role="status">
              The journal is briefly away from the table. Please check back in a little while.
            </p>
          ) : (
            <>
              {result.data.categories.length > 0 && (
                <nav className="blog-chips" aria-label="Filter by category">
                  <Link
                    className={`blog-chip ${category === undefined ? 'active' : ''}`}
                    href="/blog"
                  >
                    All stories
                  </Link>
                  {result.data.categories.map((c) => (
                    <Link
                      key={c.slug}
                      className={`blog-chip ${category === c.slug ? 'active' : ''}`}
                      href={pageHref(1, c.slug)}
                    >
                      {c.name}
                    </Link>
                  ))}
                </nav>
              )}

              {result.data.articles.length === 0 ? (
                <p className="blog-empty" role="status">
                  Nothing published here just yet — the kettle is on. Come back soon.
                </p>
              ) : (
                <ul className="blog-grid">
                  {result.data.articles.map((article) => (
                    <BlogCard key={article.slug} article={article} />
                  ))}
                </ul>
              )}

              {result.data.totalPages > 1 && (
                <nav className="blog-pagination" aria-label="Journal pages">
                  {page > 1 ? (
                    <Link className="btn btn-ghost" href={pageHref(page - 1, category)}>
                      Newer stories
                    </Link>
                  ) : (
                    <span />
                  )}
                  <span className="mono" aria-current="page">
                    Page {result.data.page} of {result.data.totalPages}
                  </span>
                  {page < result.data.totalPages ? (
                    <Link className="btn btn-ghost" href={pageHref(page + 1, category)}>
                      Older stories
                    </Link>
                  ) : (
                    <span />
                  )}
                </nav>
              )}
            </>
          )}
        </div>
      </section>
    </BlogShell>
  );
}

function BlogCard({ article }: { readonly article: PublicBlogArticleListItem }): React.JSX.Element {
  return (
    <li className="blog-card">
      <article>
        <div className="blog-card-meta">
          {article.category !== null && <span className="mono">{article.category.name}</span>}
          <time className="mono" dateTime={article.publishedAt}>
            {DATE_FORMAT.format(new Date(article.publishedAt))}
          </time>
        </div>
        <h2 className="serif blog-card-title">
          <Link href={`/blog/${article.slug}`}>{article.title}</Link>
        </h2>
        {article.metaDescription !== null && (
          <p className="blog-card-excerpt">{article.metaDescription}</p>
        )}
        {article.primaryAuthor !== null && (
          <p className="blog-card-author">By {article.primaryAuthor.displayName}</p>
        )}
      </article>
    </li>
  );
}
