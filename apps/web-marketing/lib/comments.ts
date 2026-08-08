import type { PublicBlogArticle } from '@taste-and-see/contracts';

/**
 * Disqus embed decision (TS-289-followup-1) — the pure gate between an
 * article's public comments config and the client embed.
 *
 * Renders NO comments UI unless every gate passes:
 * - `NEXT_PUBLIC_DISQUS_SHORTNAME` is set (unset = the feature is dark,
 *   config-off posture — the site never advertises a comments section it
 *   cannot load);
 * - the article carries a comments config (the public projection already
 *   serves `null` for comments-dark posts);
 * - the provider is `disqus` (`none` = comments off for this post).
 *
 * `identifier` prefers the editor-set `disqusIdentifier` and falls back to
 * the article slug (stable + unique). `pageUrl` prefers the canonical URL
 * (validated http/https at write time), then `NEXT_PUBLIC_SITE_ORIGIN` +
 * the blog path, else null — Disqus threads key on the identifier, so a
 * missing url degrades gracefully rather than blocking the embed.
 *
 * Kept dependency-free and total. Covered by `comments.test.ts` since
 * TS-303c2b-followup-1b gave this app a unit-test lane; before that its
 * only guarantee was the type checker's exhaustiveness.
 */
export interface DisqusEmbedConfig {
  readonly shortname: string;
  readonly identifier: string;
  readonly pageUrl: string | null;
}

export function resolveDisqusEmbed(input: {
  readonly comments: PublicBlogArticle['comments'];
  readonly slug: string;
  readonly canonicalUrl: string | null;
  readonly shortname: string | undefined;
  readonly siteOrigin: string | undefined;
}): DisqusEmbedConfig | null {
  const shortname = input.shortname?.trim();
  if (shortname === undefined || shortname.length === 0) return null;
  if (input.comments === null || input.comments.provider !== 'disqus') return null;

  const identifier = input.comments.disqusIdentifier ?? input.slug;

  let pageUrl: string | null = null;
  if (input.canonicalUrl !== null && /^https?:\/\//.test(input.canonicalUrl)) {
    pageUrl = input.canonicalUrl;
  } else {
    const origin = input.siteOrigin?.trim().replace(/\/$/, '');
    if (origin !== undefined && /^https?:\/\//.test(origin)) {
      pageUrl = `${origin}/blog/${input.slug}`;
    }
  }

  return { shortname, identifier, pageUrl };
}
