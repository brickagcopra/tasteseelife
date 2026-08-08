import { describe, expect, it } from 'vitest';

import { ADMIN_MEDIA_RESOLVE_MAX, type ResolvedMediaAsset } from '@taste-and-see/contracts';

import {
  MEDIA_RESOLVE_MAX_CALLS,
  buildResolveQuery,
  describeUnrenderable,
  formatBytes,
  isInlineRenderableMime,
  outcomeLabel,
} from './media-preview';

/**
 * TS-282-followup-5b — the decisions worth pinning on the console side.
 *
 * The page bodies stay out of this lane by design (see `vitest.config.ts`);
 * what is here is what we ask the gateway for, what we are willing to render
 * inline, and what we tell an operator when there is nothing to show.
 */

describe('buildResolveQuery', () => {
  it('returns null rather than making a round-trip for nothing', () => {
    expect(buildResolveQuery([])).toBeNull();
    expect(buildResolveQuery(['', '   '])).toBeNull();
  });

  it('emits one repeated `id` param per key', () => {
    const query = buildResolveQuery(['a', 'b']);
    expect(query?.path).toBe('/api/v1/admin/media/assets/resolve?id=a&id=b');
  });

  it('percent-encodes a legacy key instead of splitting it', () => {
    // Asset-key columns were free text before TS-282-followup-5a, so a stored
    // key may contain a comma, a slash or an ampersand. A comma-joined list
    // would mangle the first into two bogus keys; an unencoded ampersand would
    // smuggle a second parameter.
    const query = buildResolveQuery(['uploads/2026, final.png&id=evil']);
    expect(query?.requested).toEqual(['uploads/2026, final.png&id=evil']);
    expect(query?.path).toBe(
      '/api/v1/admin/media/assets/resolve?id=uploads%2F2026%2C+final.png%26id%3Devil',
    );
  });

  it('de-duplicates keys', () => {
    const query = buildResolveQuery(['a', 'a', 'b', 'a']);
    expect(query?.requested).toEqual(['a', 'b']);
  });

  it('reports what it dropped rather than silently truncating', () => {
    // A console that quietly shows 10 of 14 assets reads as "these are the
    // assets", which is the same species of lie as showing none of them.
    const keys = Array.from({ length: ADMIN_MEDIA_RESOLVE_MAX + 3 }, (_, i) => `a${i}`);
    const query = buildResolveQuery(keys);
    expect(query?.requested).toHaveLength(ADMIN_MEDIA_RESOLVE_MAX);
    expect(query?.dropped).toEqual(['a10', 'a11', 'a12']);
  });
});

describe('isInlineRenderableMime', () => {
  it('accepts images', () => {
    for (const mime of ['image/webp', 'image/jpeg', 'image/PNG', 'image/avif']) {
      expect(isInlineRenderableMime(mime)).toBe(true);
    }
  });

  it('refuses video and documents', () => {
    // Wrapping an `<img>` around a video shows a broken-image icon to the very
    // reviewer meant to be judging the asset — this task's defect in costume.
    for (const mime of ['video/mp4', 'video/webm', 'application/pdf']) {
      expect(isInlineRenderableMime(mime)).toBe(false);
    }
  });
});

describe('describeUnrenderable', () => {
  function unready(status: string): ResolvedMediaAsset {
    return {
      outcome: 'not_ready',
      assetKey: 'k',
      status: status as Extract<ResolvedMediaAsset, { outcome: 'not_ready' }>['status'],
    };
  }

  it('tells a reviewer that an unresolvable key makes the review unperformable', () => {
    // This is the honest, and today the most common, answer: the reviewer who
    // learns it can bounce the creative instead of rubber-stamping it.
    const message = describeUnrenderable({ outcome: 'not_found', assetKey: 'k' });
    expect(message).toMatch(/does not resolve/i);
    expect(message).toMatch(/cannot be performed/i);
  });

  it('never lets an outage read as a missing asset', () => {
    const message = describeUnrenderable({ outcome: 'unavailable', assetKey: 'k' });
    expect(message).toMatch(/could not reach/i);
    expect(message).toMatch(/not a statement about whether the asset exists/i);
  });

  it('does not name the asset kind when refusing a restricted asset', () => {
    const message = describeUnrenderable({ outcome: 'restricted', assetKey: 'k' });
    expect(message).toMatch(/not previewable/i);
    for (const kind of ['senior', 'document', 'certification', 'recipe']) {
      expect(message.toLowerCase()).not.toContain(kind);
    }
  });

  it('separates "we rejected these bytes" from "we have not looked yet"', () => {
    expect(describeUnrenderable(unready('rejected'))).toMatch(/REJECTED/);
    expect(describeUnrenderable(unready('scanning'))).toMatch(/still being scanned/i);
    expect(describeUnrenderable(unready('awaiting_upload'))).toMatch(/has not sent the file/i);
    expect(describeUnrenderable(unready('expired'))).toMatch(/upload it again/i);
  });

  it('has a distinct sentence for every lifecycle status', () => {
    const statuses = [
      'awaiting_upload',
      'uploaded',
      'scanning',
      'ready',
      'rejected',
      'failed',
      'expired',
    ];
    const messages = statuses.map((status) => describeUnrenderable(unready(status)));
    expect(messages.every((m) => m.length > 0)).toBe(true);
    // `uploaded` and `scanning` deliberately share one sentence — from the
    // reviewer's chair they are the same instruction ("wait"). Everything else
    // is distinct.
    expect(new Set(messages).size).toBe(statuses.length - 1);
  });
});

describe('outcomeLabel', () => {
  it('labels each outcome distinctly', () => {
    const labels = [
      outcomeLabel({
        outcome: 'ready',
        assetKey: 'k',
        signedUrl: 'https://x/y',
        expiresAt: null,
        mime: 'image/png',
        width: null,
        height: null,
        fileName: null,
        sizeBytes: null,
      }),
      outcomeLabel({ outcome: 'not_found', assetKey: 'k' }),
      outcomeLabel({ outcome: 'restricted', assetKey: 'k' }),
      outcomeLabel({ outcome: 'unavailable', assetKey: 'k' }),
      outcomeLabel({ outcome: 'not_ready', assetKey: 'k', status: 'rejected' }),
    ];
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[4]).toBe('Not viewable — rejected');
  });
});

describe('formatBytes', () => {
  it('formats, and passes null through', () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(48_000)).toBe('47 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('MEDIA_RESOLVE_MAX_CALLS', () => {
  it('covers the documented maximum creative count with nothing to spare', () => {
    // The campaign detail page lists up to AD_CAMPAIGN_CREATIVES_MAX = 20
    // creatives and resolves ONE hero key each, so 2 calls x 10 ids is exactly
    // enough. An unbounded chunk count is how a summary page quietly becomes 20
    // downstream fan-outs.
    expect(ADMIN_MEDIA_RESOLVE_MAX * MEDIA_RESOLVE_MAX_CALLS).toBe(20);
  });
});
