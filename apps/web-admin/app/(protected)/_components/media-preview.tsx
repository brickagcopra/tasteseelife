import Image from 'next/image';
import type { ResolvedMediaAsset } from '@taste-and-see/contracts';

import {
  describeUnrenderable,
  formatBytes,
  isInlineRenderableMime,
  outcomeLabel,
} from '@/lib/media-preview';

/**
 * Renders resolved media assets on an admin surface (TS-282-followup-5b).
 *
 * **Why this exists.** TS-277a gates ad-creative approval on an accessibility
 * review — alt-text adequacy, WCAG contrast, motion — and this console showed
 * the reviewer `assetKeys.join(', ')`: a comma-separated list of opaque
 * strings. They were approving an image they had never seen. The content
 * author editor had the same shape on its byline photo.
 *
 * **Every tile says something.** A tile that cannot show a picture says which
 * of the four reasons applies, because rendering blank space is the original
 * defect in a nicer typeface, and the four reasons call for four different
 * actions from the operator (bounce it, wait, escalate, retry).
 *
 * **`unoptimized` is deliberate, not laziness.** The src is a short-lived
 * signed delivery URL minted by media-svc for this one read. Routing it
 * through Next's optimizer would cache a derivative keyed on a URL that is
 * already expiring — every hit a miss — and would proxy private media through
 * the admin server. It also means the delivery host, which differs per
 * environment (and is a stub host today), needs no `remotePatterns` entry:
 * `unoptimized` short-circuits before that check. The alt text names the tile
 * as a preview rather than describing the picture, because the whole point is
 * that only the human looking at it can say what it depicts — an invented
 * description here would be the accessibility failure this page reviews.
 */
export function MediaPreviewGrid({
  assets,
  emptyLabel,
}: {
  readonly assets: readonly ResolvedMediaAsset[];
  readonly emptyLabel: string;
}): React.JSX.Element {
  if (assets.length === 0) {
    return (
      <div className="user-empty">
        <p>{emptyLabel}</p>
      </div>
    );
  }
  return (
    <ul className="media-preview__grid">
      {assets.map((asset) => (
        <MediaPreviewTile key={asset.assetKey} asset={asset} />
      ))}
    </ul>
  );
}

function MediaPreviewTile({ asset }: { readonly asset: ResolvedMediaAsset }): React.JSX.Element {
  const renderable = asset.outcome === 'ready' && isInlineRenderableMime(asset.mime);
  return (
    <li className="media-preview__tile">
      <div className="media-preview__frame">
        {asset.outcome === 'ready' && renderable ? (
          <Image
            src={asset.signedUrl}
            alt={`Preview of asset ${asset.assetKey}`}
            fill
            unoptimized
            sizes="320px"
            style={{ objectFit: 'contain' }}
          />
        ) : (
          <span className="media-preview__placeholder" aria-hidden="true">
            {asset.outcome === 'ready' ? 'Not an image' : '—'}
          </span>
        )}
      </div>
      <div className="media-preview__meta">
        <span
          className={
            asset.outcome === 'ready'
              ? 'user-row__chip user-row__chip--ok'
              : 'user-row__chip user-row__chip--warn'
          }
        >
          {outcomeLabel(asset)}
        </span>
        <code className="media-preview__key">{asset.assetKey}</code>
        {asset.outcome === 'ready' ? (
          <>
            <p className="user-detail__hint">
              {asset.mime}
              {asset.width !== null && asset.height !== null
                ? ` · ${asset.width}×${asset.height}px`
                : ''}
              {formatBytes(asset.sizeBytes) !== null ? ` · ${formatBytes(asset.sizeBytes)}` : ''}
            </p>
            {!renderable && (
              <p className="user-detail__hint">
                This asset is not an image, so it cannot be shown inline. Open it to review it.
              </p>
            )}
            {/*
              Opened in a new tab rather than navigated to: the reviewer is
              mid-decision on this page and must not lose the form. `noreferrer`
              keeps the signed URL out of any referer header.
            */}
            <a
              href={asset.signedUrl}
              target="_blank"
              rel="noreferrer"
              className="media-preview__link"
            >
              Open full size
            </a>
            <p className="user-detail__hint">
              This link is a short-lived signed URL — it stops working once it expires
              {asset.expiresAt !== null ? ` (${formatExpiry(asset.expiresAt)})` : ''}. Reload the
              page for a fresh one.
            </p>
          </>
        ) : (
          <p className="user-detail__hint">{describeUnrenderable(asset)}</p>
        )}
      </div>
    </li>
  );
}

/**
 * A single small thumbnail for a SUMMARY surface (TS-282-followup-5b-followup-2).
 *
 * Distinct from `MediaPreviewGrid` on purpose. The grid is a review affordance:
 * a big frame, the pixel dimensions, the expiry, and a sentence explaining any
 * outcome that is not `ready`, because a reviewer is deciding something. This
 * is a list row — the operator is scanning, not judging — so it shows the
 * picture and a short label, and the sentence lives one click away on the
 * review page. Merging the two into one component with a `size` prop would
 * make both worse: the review tile would grow a way to suppress its
 * explanation, which is the one thing it must never do.
 */
export function CreativeAssetThumb({
  asset,
  totalAssets,
}: {
  readonly asset: ResolvedMediaAsset | null;
  readonly totalAssets: number;
}): React.JSX.Element {
  if (totalAssets === 0) return <>—</>;
  const renderable =
    asset !== null && asset.outcome === 'ready' && isInlineRenderableMime(asset.mime);
  return (
    <span className="media-thumb">
      <span className="media-thumb__frame">
        {asset !== null && asset.outcome === 'ready' && renderable ? (
          <Image
            src={asset.signedUrl}
            alt={`Preview of asset ${asset.assetKey}`}
            fill
            unoptimized
            sizes="72px"
            style={{ objectFit: 'contain' }}
          />
        ) : (
          <span className="media-preview__placeholder" aria-hidden="true">
            —
          </span>
        )}
      </span>
      <span className="media-thumb__meta">
        {/* The count is what tells the operator there is more to go and see. */}
        <span>{totalAssets === 1 ? '1 asset' : `${totalAssets} assets`}</span>
        {asset !== null && asset.outcome !== 'ready' && (
          <span className="user-row__chip user-row__chip--warn">{outcomeLabel(asset)}</span>
        )}
      </span>
    </span>
  );
}

/**
 * A banner for the case where the record references more assets than one
 * resolve call may carry. Stated rather than swallowed — see
 * `buildResolveQuery`.
 */
export function MediaPreviewTruncationNotice({
  shown,
  total,
}: {
  readonly shown: number;
  readonly total: number;
}): React.JSX.Element | null {
  if (total <= shown) return null;
  return (
    <p className="auth-alert auth-alert--info" role="status">
      This record references {total} assets; only the first {shown} are shown. The remainder cannot
      be previewed on this page.
    </p>
  );
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}
