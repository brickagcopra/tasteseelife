import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BLOG_REVALIDATE_SECONDS,
  fetchAllBlogSlugs,
  fetchBlogArticle,
  fetchBlogIndex,
} from './blog';

/**
 * Tests for the public blog fetchers (TS-282-followup-3), added with this
 * app's first unit-test lane (TS-303c2b-followup-1b).
 *
 * **The contract under test is that nothing here throws.** `next build`
 * prerenders these pages in CI where no gateway runs, and the marketing
 * site has to keep serving its static sections through a gateway outage —
 * so a regression that lets an exception escape does not surface as a
 * broken blog page, it surfaces as a failed production build. Every case
 * below is one way the upstream can misbehave, and every one of them must
 * resolve to a typed "unavailable" rather than reject.
 *
 * The second property: **a drifted body counts as unavailable, never as
 * renderable data.** This is an anonymous public surface reading from a
 * service that also holds drafts, so parsing it loosely is the shape of a
 * leak, not merely of a rendering bug.
 */

const ORIGINAL_BASE = process.env['API_GATEWAY_BASE_URL'];

/** A list-item as the index serves it — card facts only, no body. */
function listItem(slug: string): unknown {
  return {
    slug,
    title: 'Eating well at eighty',
    publishedAt: '2026-07-01T00:00:00.000Z',
    metaDescription: null,
    category: null,
    primaryAuthor: null,
  };
}

/** A detail article as `/blog/[slug]` serves it. */
function article(slug: string): unknown {
  return {
    slug,
    title: 'Eating well at eighty',
    body: '# Hello',
    publishedAt: '2026-07-01T00:00:00.000Z',
    category: null,
    seo: {
      seoTitle: null,
      metaDescription: null,
      canonicalUrl: null,
      ogTitle: null,
      ogDescription: null,
      ogImageKey: null,
      twitterCard: null,
      twitterTitle: null,
      twitterDescription: null,
      twitterImageKey: null,
      jsonLd: null,
    },
    authors: [],
    comments: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function listBody(slugs: readonly string[], totalPages = 1): unknown {
  return {
    articles: slugs.map(listItem),
    page: 1,
    pageSize: 12,
    totalArticles: slugs.length,
    totalPages,
    categories: [],
  };
}

beforeEach(() => {
  process.env['API_GATEWAY_BASE_URL'] = 'https://gateway.example';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_BASE === undefined) delete process.env['API_GATEWAY_BASE_URL'];
  else process.env['API_GATEWAY_BASE_URL'] = ORIGINAL_BASE;
});

describe('fetchBlogIndex', () => {
  it('returns the parsed page on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(listBody(['a', 'b']))),
    );

    const result = await fetchBlogIndex({ page: 1 });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.articles).toHaveLength(2);
  });

  it('is UNAVAILABLE when no gateway base url is configured — the build machine case', async () => {
    delete process.env['API_GATEWAY_BASE_URL'];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchBlogIndex({ page: 1 })).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is unavailable when the gateway is unreachable, and does NOT throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(fetchBlogIndex({ page: 1 })).resolves.toEqual({ ok: false });
  });

  it('is unavailable on a non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 503)),
    );

    expect(await fetchBlogIndex({ page: 1 })).toEqual({ ok: false });
  });

  it('a DRIFTED body is unavailable, never renderable data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ articles: 'nope' })),
    );

    expect(await fetchBlogIndex({ page: 1 })).toEqual({ ok: false });
  });

  it('carries the page and the category into the query string', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => jsonResponse(listBody([])));
    vi.stubGlobal('fetch', fetchMock);

    await fetchBlogIndex({ page: 3, category: 'nutrition' });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('page=3');
    expect(url).toContain('category=nutrition');
  });

  it('omits the category entirely when absent — never sends an empty filter', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => jsonResponse(listBody([])));
    vi.stubGlobal('fetch', fetchMock);

    await fetchBlogIndex({ page: 1 });

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('category=');
  });

  it('requests with the ISR window so a publish appears within one revalidation', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => jsonResponse(listBody([])));
    vi.stubGlobal('fetch', fetchMock);

    await fetchBlogIndex({ page: 1 });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      next: { revalidate: BLOG_REVALIDATE_SECONDS },
    });
  });
});

describe('fetchBlogArticle', () => {
  it('returns the article on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ article: article('a') })),
    );

    const result = await fetchBlogArticle('a');

    expect(result.ok).toBe(true);
    expect(result.ok && result.article.slug).toBe('a');
  });

  it('DISTINGUISHES not-found from unavailable', async () => {
    // The page renders a 404 for one and a quiet retry state for the
    // other. Collapsing them would tell a reader a published article does
    // not exist because the gateway blinked.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404)),
    );
    expect(await fetchBlogArticle('gone')).toEqual({ ok: false, reason: 'not_found' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 500)),
    );
    expect(await fetchBlogArticle('x')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a drifted body is unavailable, not not-found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ article: { slug: 42 } })),
    );

    expect(await fetchBlogArticle('x')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('does not throw when the gateway is unreachable or unconfigured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(fetchBlogArticle('x')).resolves.toEqual({ ok: false, reason: 'unavailable' });

    delete process.env['API_GATEWAY_BASE_URL'];
    await expect(fetchBlogArticle('x')).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('encodes the slug into the path', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => jsonResponse({}, 404));
    vi.stubGlobal('fetch', fetchMock);

    await fetchBlogArticle('a b/c');

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('a%20b%2Fc');
  });
});

describe('fetchAllBlogSlugs', () => {
  it('walks every page and collects the slugs', async () => {
    const pages = [listBody(['a', 'b'], 2), listBody(['c'], 2)];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = pages[call] ?? listBody([], 2);
        call += 1;
        return jsonResponse(body);
      }),
    );

    expect(await fetchAllBlogSlugs()).toEqual(['a', 'b', 'c']);
  });

  it('returns an EMPTY list when the gateway is unreachable, rather than failing the build', async () => {
    // `generateStaticParams` consumes this. An empty list means "prerender
    // nothing"; a throw means "the production build fails because a
    // service was down".
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(fetchAllBlogSlugs()).resolves.toEqual([]);
  });

  it('keeps what it collected when a later page fails mid-walk', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return call === 1 ? jsonResponse(listBody(['a'], 5)) : jsonResponse({}, 503);
      }),
    );

    expect(await fetchAllBlogSlugs()).toEqual(['a']);
  });

  it('is BOUNDED even if the paging facts misbehave', async () => {
    // A server that always claims more pages must not spin the build
    // machine forever. 100 pages is the documented ceiling.
    const fetchMock = vi.fn(async () => jsonResponse(listBody(['a'], 9_999)));
    vi.stubGlobal('fetch', fetchMock);

    const slugs = await fetchAllBlogSlugs();

    expect(fetchMock).toHaveBeenCalledTimes(100);
    expect(slugs).toHaveLength(100);
  });
});
