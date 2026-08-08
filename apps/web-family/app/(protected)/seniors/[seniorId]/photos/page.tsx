import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type { FamilySeniorPhotoGalleryResponse } from '@taste-and-see/contracts';

import { getSeniorPhotos } from '@/lib/senior-photos-api';
import { listMySeniors } from '@/lib/seniors-api';

export const metadata: Metadata = {
  title: 'Photos — Taste & See',
};

/**
 * Consent-gated senior photo gallery (TS-232).
 *
 * Shows the photos a senior has agreed to share with family observers.
 * The gateway aggregator applies the senior's `photos` consent flag
 * (TS-238) — the primary payer + senior always see everything; a family
 * observer sees photos only when the senior has turned sharing on. A
 * `shared: false` response renders a gentle "not shared yet" empty state
 * (default opt-out, CLAUDE.md §12) rather than an error.
 *
 * Auth + reachability: a non-member gets `forbidden` / `not_found` from
 * the underlying consent read, rendered as "we couldn't find that loved
 * one" so a foreign senior id can't be probed.
 *
 * Images use `next/image` with `unoptimized` — the delivery URLs are
 * short-lived, signed, private content; routing them through Next's
 * optimizer would proxy + cache consent-gated photos on the server, which
 * we deliberately avoid.
 */
export default async function SeniorPhotosPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly seniorId: string }>;
  readonly searchParams: Promise<{ readonly cursor?: string }>;
}): Promise<React.JSX.Element> {
  const { seniorId } = await params;
  const { cursor } = await searchParams;

  const [photosResult, seniorsResult] = await Promise.all([
    getSeniorPhotos(seniorId, cursor),
    listMySeniors(),
  ]);

  if (photosResult.kind === 'unauthorized' || seniorsResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  if (photosResult.kind === 'forbidden' || photosResult.kind === 'not_found') {
    return (
      <Shell>
        <h1>We couldn&apos;t find that loved one</h1>
        <p className="providers-empty">
          This profile isn&apos;t in your household, or it may have been removed.{' '}
          <Link href="/seniors" className="link-inline">
            Back to your loved ones
          </Link>
          .
        </p>
      </Shell>
    );
  }

  if (photosResult.kind !== 'ok') {
    return (
      <Shell>
        <h1>We&apos;re having a moment</h1>
        <p className="providers-empty">
          We couldn&apos;t load these photos right now. Please refresh in a moment.
        </p>
      </Shell>
    );
  }

  const gallery = photosResult.gallery;
  const senior =
    seniorsResult.kind === 'ok'
      ? seniorsResult.seniors.find((s) => s.seniorId === seniorId)
      : undefined;
  const name =
    senior !== undefined
      ? senior.displayName !== null && senior.displayName.length > 0
        ? senior.displayName
        : senior.firstName
      : 'your loved one';

  return (
    <Shell>
      <h1>Photos of {name}</h1>
      <p>
        The moments shared from visits — the meals, the smiles, the small joys. New photos appear
        here as they&apos;re shared.
      </p>
      <PhotoGallery seniorId={seniorId} name={name} gallery={gallery} />
    </Shell>
  );
}

function PhotoGallery({
  seniorId,
  name,
  gallery,
}: {
  readonly seniorId: string;
  readonly name: string;
  readonly gallery: FamilySeniorPhotoGalleryResponse;
}): React.JSX.Element {
  if (!gallery.shared) {
    return (
      <div className="photo-empty">
        <p>
          {name} hasn&apos;t chosen to share photos with you yet. If you&apos;d like to see photos
          from visits, ask the account holder or {name} to turn on photo sharing.
        </p>
        <Link href={`/seniors/${encodeURIComponent(seniorId)}/sharing`} className="link-inline">
          Sharing settings
        </Link>
      </div>
    );
  }

  if (gallery.photos.length === 0) {
    return (
      <div className="photo-empty">
        <p>No photos have been shared yet. They&apos;ll appear here after a visit.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="photo-grid">
        {gallery.photos.map((photo) => (
          <li key={photo.id} className="photo-tile">
            <Image
              src={photo.signedDeliveryUrl}
              alt={photo.declaredFileName ?? `A shared photo of ${name}`}
              fill
              unoptimized
              sizes="(max-width: 600px) 50vw, 240px"
              className="photo-tile__img"
            />
          </li>
        ))}
      </ul>
      {gallery.nextCursor !== null ? (
        <p className="photo-more">
          <Link
            href={`/seniors/${encodeURIComponent(seniorId)}/photos?cursor=${encodeURIComponent(
              gallery.nextCursor,
            )}`}
            className="link-inline"
          >
            Load earlier photos
          </Link>
        </p>
      ) : null}
    </>
  );
}

function Shell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/seniors" className="dash-logout">
          Your loved ones
        </Link>
      </header>
      <main className="dash-main">{children}</main>
    </div>
  );
}
