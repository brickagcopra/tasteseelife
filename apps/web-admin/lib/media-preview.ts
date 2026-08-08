import {
  ADMIN_MEDIA_RESOLVE_MAX,
  ResolveMediaAssetsResponseSchema,
  type MediaAssetStatus,
  type ResolvedMediaAsset,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Media preview resolution for the admin console (TS-282-followup-5b).
 *
 * **The defect this closes.** TS-277a gates ad-creative approval on an
 * accessibility review — alt-text adequacy, WCAG contrast, motion — and this
 * console rendered `assetKeys.join(', ')` as literal text. The reviewer was
 * signing off on an image they had never seen. The same string-as-image
 * pattern sat on the content author editor's byline photo.
 *
 * Everything here is a plain function so it lands in the `.ts`-only test lane
 * (see `vitest.config.ts`): the page bodies stay `await fetch` + JSX, and the
 * decisions that actually matter — what we ask for, what we are willing to
 * render inline, and what we tell an operator when we cannot — are tested.
 */

/**
 * Build the query string for `GET /api/v1/admin/media/assets/resolve`.
 *
 * Repeated `id` params rather than a comma-joined list, because a legacy
 * assetKey is unvalidated free text (the columns predate TS-282-followup-5a)
 * and may itself contain a comma.
 *
 * Returns `null` when there is nothing to ask for — a caller must not make a
 * round-trip to resolve an empty list.
 */
export function buildResolveQuery(assetKeys: readonly string[]): {
  readonly path: string;
  readonly requested: readonly string[];
  /**
   * Keys dropped because the request would have exceeded the endpoint's
   * fan-out ceiling. Surfaced rather than silently truncated: a console that
   * quietly shows 10 of 14 assets reads as "these are the assets".
   */
  readonly dropped: readonly string[];
} | null {
  const distinct = [...new Set(assetKeys.filter((key) => key.trim().length > 0))];
  if (distinct.length === 0) return null;

  const requested = distinct.slice(0, ADMIN_MEDIA_RESOLVE_MAX);
  const dropped = distinct.slice(ADMIN_MEDIA_RESOLVE_MAX);
  const params = new URLSearchParams();
  for (const key of requested) params.append('id', key);

  return { path: `/api/v1/admin/media/assets/resolve?${params.toString()}`, requested, dropped };
}

/**
 * Resolve a list of assetKeys into render-ready outcomes.
 *
 * **Never throws and never returns a short list.** Every requested key gets a
 * row back: if the gateway is unreachable, or answers with a body that does
 * not match the contract, the whole batch degrades to `unavailable` rather
 * than disappearing. A missing row would render as blank space, which is the
 * defect this function exists to fix.
 */
export async function resolveAssetKeys(
  assetKeys: readonly string[],
): Promise<readonly ResolvedMediaAsset[]> {
  const query = buildResolveQuery(assetKeys);
  if (query === null) return [];

  const unavailable = (): readonly ResolvedMediaAsset[] =>
    [...query.requested, ...query.dropped].map((assetKey) => ({
      outcome: 'unavailable' as const,
      assetKey,
    }));

  const result = await callGateway<unknown>(query.path);
  if (result.kind !== 'ok') return unavailable();

  const parsed = ResolveMediaAssetsResponseSchema.safeParse(result.body);
  if (!parsed.success) return unavailable();

  // Order and completeness come from the REQUEST, not the response: the
  // console renders one tile per key it asked about, in the order the record
  // lists them, and a key the gateway declined to answer for is `unavailable`
  // rather than absent.
  const byKey = new Map(parsed.data.assets.map((asset) => [asset.assetKey, asset]));
  return [...query.requested, ...query.dropped].map(
    (assetKey) => byKey.get(assetKey) ?? { outcome: 'unavailable' as const, assetKey },
  );
}

/**
 * How many resolve calls one page may make (TS-282-followup-5b-followup-2).
 *
 * The campaign detail page lists up to `AD_CAMPAIGN_CREATIVES_MAX` = 20
 * creatives, so even one key each exceeds the 10-id per-call ceiling. Chunking
 * is the answer; an UNBOUNDED chunk count is not — that is how a summary page
 * quietly becomes 20 downstream fan-outs. Two calls covers the documented
 * maximum with nothing to spare, which is the right amount of slack for a
 * surface whose job is a summary.
 */
export const MEDIA_RESOLVE_MAX_CALLS = 2;

/**
 * Resolve more keys than one call carries, in bounded parallel chunks.
 *
 * Returns the same never-throws, never-short contract as {@link resolveAssetKeys}
 * plus what it refused to ask about, so the caller can say so rather than
 * rendering a shorter list that reads as complete.
 */
export async function resolveAssetKeysBatched(assetKeys: readonly string[]): Promise<{
  readonly assets: readonly ResolvedMediaAsset[];
  readonly dropped: readonly string[];
}> {
  const distinct = [...new Set(assetKeys.filter((key) => key.trim().length > 0))];
  const ceiling = ADMIN_MEDIA_RESOLVE_MAX * MEDIA_RESOLVE_MAX_CALLS;
  const asked = distinct.slice(0, ceiling);
  const dropped = distinct.slice(ceiling);

  const chunks: string[][] = [];
  for (let i = 0; i < asked.length; i += ADMIN_MEDIA_RESOLVE_MAX) {
    chunks.push(asked.slice(i, i + ADMIN_MEDIA_RESOLVE_MAX));
  }

  const settled = await Promise.all(chunks.map(async (chunk) => resolveAssetKeys(chunk)));
  return { assets: settled.flat(), dropped };
}

/**
 * Can this mime be rendered inline in an `<img>`?
 *
 * An ad creative may be a video (`provider_video_intro` is a previewable kind,
 * and nothing stops a future creative kind from being one). Wrapping an
 * `<img>` around a video shows a broken-image icon to the very reviewer who is
 * meant to be judging the asset — the failure this task exists to prevent,
 * wearing a different costume.
 */
export function isInlineRenderableMime(mime: string): boolean {
  return mime.toLowerCase().startsWith('image/');
}

/**
 * Operator-facing copy for an asset that cannot be shown.
 *
 * **Says which reason, always.** Rendering nothing without saying why is the
 * defect restated, and the four reasons call for four different actions:
 * bounce the submission, wait, escalate, or retry.
 */
export function describeUnrenderable(asset: ResolvedMediaAsset): string {
  switch (asset.outcome) {
    case 'ready':
      // Callers branch on `outcome === 'ready'` before asking; this exists so
      // the switch stays exhaustive and a new outcome is a compile error.
      return 'This asset is available.';
    case 'not_found':
      return 'This key does not resolve to a media asset. It may never have referenced the media service — asset keys were free text before they were pinned to a media asset id. The accessibility review cannot be performed against it.';
    case 'restricted':
      return 'This asset is not previewable on the admin console. Its type is not one this surface is allowed to display.';
    case 'unavailable':
      return 'We could not reach the media service for this asset. This is not a statement about whether the asset exists — try again shortly.';
    case 'not_ready':
      return unreadyMessage(asset.status);
  }
}

function unreadyMessage(status: MediaAssetStatus): string {
  switch (status) {
    case 'awaiting_upload':
      return 'The uploader has not sent the file yet, so there is nothing to review.';
    case 'uploaded':
    case 'scanning':
      return 'This asset is still being scanned and processed. It is not viewable until it clears.';
    case 'rejected':
      return 'This asset was REJECTED by the media pipeline — it failed magic-byte, virus, or image-processing checks. The bytes have been deleted.';
    case 'failed':
      return 'Processing this asset failed unexpectedly. It needs an ops retry before it can be reviewed.';
    case 'expired':
      return 'The upload window expired before the file arrived. The submitter has to upload it again.';
    case 'ready':
      // `ready` with no signed URL — the row says it is processed but the
      // service minted no delivery URL. Rare, and worth naming rather than
      // dressing up as one of the states above.
      return 'This asset is marked ready but the media service returned no delivery URL for it.';
  }
}

/**
 * A short label for the chip beside each tile. Deliberately terse and
 * non-judgemental — the sentence in `describeUnrenderable` carries the detail.
 */
export function outcomeLabel(asset: ResolvedMediaAsset): string {
  switch (asset.outcome) {
    case 'ready':
      return 'Available';
    case 'not_found':
      return 'Unresolvable key';
    case 'restricted':
      return 'Not previewable here';
    case 'unavailable':
      return 'Could not load';
    case 'not_ready':
      return `Not viewable — ${asset.status.replace(/_/g, ' ')}`;
  }
}

/** Human-readable byte size for the tile caption. */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Math.round(kib)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}
