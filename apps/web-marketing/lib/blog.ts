import {
  PublicBlogArticleResponseSchema,
  PublicBlogArticlesListResponseSchema,
  type PublicBlogArticle,
  type PublicBlogArticlesListResponse,
} from '@taste-and-see/contracts';

/**
 * Public blog reads for the marketing site (TS-282-followup-3) — thin
 * server-side fetchers over the gateway's anonymous blog proxy.
 *
 * **ISR posture.** Pages fetch with `next.revalidate` (time-based ISR,
 * {@link BLOG_REVALIDATE_SECONDS}) — a publish appears within one window.
 * Event-driven on-demand revalidation off `content.article.published` is a
 * carved follow-up.
 *
 * **Build-safety.** `next build` prerenders these pages in CI where no gateway
 * runs, and the marketing site must keep building (and serving its static
 * sections) through a gateway outage. Every fetcher therefore resolves to a
 * typed "unavailable" outcome instead of throwing — the pages render an
 * honest quiet state and ISR retries on the next window. Responses are
 * parse-checked against the public contracts; a drifted body counts as
 * unavailable, never as renderable data.
 */

/** Time-based ISR window for all blog pages (seconds). */
export const BLOG_REVALIDATE_SECONDS = 300;

export type BlogIndexResult =
  | { readonly ok: true; readonly data: PublicBlogArticlesListResponse }
  | { readonly ok: false };

export type BlogArticleResult =
  | { readonly ok: true; readonly article: PublicBlogArticle }
  | { readonly ok: false; readonly reason: 'not_found' | 'unavailable' };

function gatewayBaseUrl(): string | null {
  const base = process.env['API_GATEWAY_BASE_URL'];
  return base !== undefined && base.length > 0 ? base.replace(/\/$/, '') : null;
}

/** One page of the published index (+ categories bar facts). */
export async function fetchBlogIndex(input: {
  readonly page: number;
  readonly category?: string | undefined;
}): Promise<BlogIndexResult> {
  const base = gatewayBaseUrl();
  if (base === null) return { ok: false };

  const params = new URLSearchParams({ page: String(input.page) });
  if (input.category !== undefined) params.set('category', input.category);

  try {
    const response = await fetch(`${base}/api/v1/content/blog/articles?${params.toString()}`, {
      headers: { accept: 'application/json' },
      next: { revalidate: BLOG_REVALIDATE_SECONDS },
    });
    if (!response.ok) return { ok: false };
    const parsed = PublicBlogArticlesListResponseSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  } catch {
    // Gateway unreachable (build machine, outage) — quiet state + ISR retry.
    return { ok: false };
  }
}

/** A single published article by slug. */
export async function fetchBlogArticle(slug: string): Promise<BlogArticleResult> {
  const base = gatewayBaseUrl();
  if (base === null) return { ok: false, reason: 'unavailable' };

  try {
    const response = await fetch(
      `${base}/api/v1/content/blog/articles/${encodeURIComponent(slug)}`,
      {
        headers: { accept: 'application/json' },
        next: { revalidate: BLOG_REVALIDATE_SECONDS },
      },
    );
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    const parsed = PublicBlogArticleResponseSchema.safeParse(await response.json());
    return parsed.success
      ? { ok: true, article: parsed.data.article }
      : { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Every published slug (for `generateStaticParams`); empty when unreachable. */
export async function fetchAllBlogSlugs(): Promise<readonly string[]> {
  const slugs: string[] = [];
  let page = 1;
  // Bounded walk — trusts the server's totalPages but never loops past 100
  // pages (1,200 posts) even if the paging facts misbehave.
  for (let i = 0; i < 100; i += 1) {
    const result = await fetchBlogIndex({ page });
    if (!result.ok) break;
    slugs.push(...result.data.articles.map((a) => a.slug));
    if (page >= result.data.totalPages) break;
    page += 1;
  }
  return slugs;
}
