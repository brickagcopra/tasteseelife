import type { PublicBlogArticle } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { resolveDisqusEmbed } from './comments';

/**
 * Tests for the Disqus embed gate (TS-289-followup-1), added with this
 * app's first unit-test lane (TS-303c2b-followup-1b).
 *
 * The gate's job is to render NOTHING unless every condition holds. The
 * failure that matters is the permissive one: a comments section that
 * announces itself and then cannot load is worse on a public marketing
 * page than no comments section at all, and the config-off posture
 * (`NEXT_PUBLIC_DISQUS_SHORTNAME` unset = dark) only means anything if
 * every path through here respects it.
 */

type Comments = PublicBlogArticle['comments'];

const DISQUS: Comments = { provider: 'disqus', disqusIdentifier: null } as Comments;

function resolve(overrides: Partial<Parameters<typeof resolveDisqusEmbed>[0]> = {}) {
  return resolveDisqusEmbed({
    comments: DISQUS,
    slug: 'eating-well-at-eighty',
    canonicalUrl: null,
    shortname: 'tasteandsee',
    siteOrigin: 'https://tasteandsee.example',
    ...overrides,
  });
}

describe('resolveDisqusEmbed — the gates', () => {
  it('renders nothing when the shortname is unset (the feature is dark)', () => {
    expect(resolve({ shortname: undefined })).toBeNull();
  });

  it.each(['', '   '])('treats a blank shortname (%j) as unset', (shortname) => {
    // An env var set to the empty string is how a deployment "unsets" one
    // in practice. It must read as dark, not as a shortname.
    expect(resolve({ shortname })).toBeNull();
  });

  it('renders nothing when the article carries no comments config', () => {
    expect(resolve({ comments: null })).toBeNull();
  });

  it("renders nothing when the provider is 'none' — comments off for this post", () => {
    expect(
      resolve({ comments: { provider: 'none', disqusIdentifier: null } as Comments }),
    ).toBeNull();
  });

  it('trims the shortname it passes through', () => {
    expect(resolve({ shortname: '  tasteandsee  ' })?.shortname).toBe('tasteandsee');
  });
});

describe('resolveDisqusEmbed — the identifier', () => {
  it('prefers the editor-set identifier', () => {
    expect(
      resolve({ comments: { provider: 'disqus', disqusIdentifier: 'legacy-123' } as Comments })
        ?.identifier,
    ).toBe('legacy-123');
  });

  it('falls back to the slug, which is stable and unique', () => {
    // Disqus threads key on the identifier, so this is the value that
    // decides whether an existing thread is found or a new empty one is
    // created under the same post.
    expect(resolve()?.identifier).toBe('eating-well-at-eighty');
  });
});

describe('resolveDisqusEmbed — the page url', () => {
  it('prefers the canonical url', () => {
    expect(resolve({ canonicalUrl: 'https://tasteandsee.com/blog/x' })?.pageUrl).toBe(
      'https://tasteandsee.com/blog/x',
    );
  });

  it('falls back to the site origin plus the blog path', () => {
    expect(resolve()?.pageUrl).toBe('https://tasteandsee.example/blog/eating-well-at-eighty');
  });

  it('strips a trailing slash from the origin rather than doubling it', () => {
    expect(resolve({ siteOrigin: 'https://tasteandsee.example/' })?.pageUrl).toBe(
      'https://tasteandsee.example/blog/eating-well-at-eighty',
    );
  });

  it('rejects a non-http(s) canonical url and falls through to the origin', () => {
    expect(resolve({ canonicalUrl: 'javascript:alert(1)' })?.pageUrl).toBe(
      'https://tasteandsee.example/blog/eating-well-at-eighty',
    );
  });

  it('rejects a non-http(s) origin too', () => {
    expect(resolve({ siteOrigin: 'javascript:alert(1)' })?.pageUrl).toBeNull();
  });

  it('STILL EMBEDS with a null page url — the identifier is what threads key on', () => {
    // A missing url degrades gracefully rather than blocking the embed.
    // Suppressing comments because we could not build a canonical URL
    // would lose the thread over a cosmetic field.
    const result = resolve({ canonicalUrl: null, siteOrigin: undefined });

    expect(result).not.toBeNull();
    expect(result?.pageUrl).toBeNull();
    expect(result?.identifier).toBe('eating-well-at-eighty');
  });
});
