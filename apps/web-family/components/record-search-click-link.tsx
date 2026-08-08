'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * "View profile" link that fires a best-effort search result-click beacon
 * before navigating (TS-217-prep-4b).
 *
 * When the user opens a provider from a `/providers` results list, this wraps
 * the standard Next `<Link>` and, on click, sends a `navigator.sendBeacon` to
 * the same-origin `/api/search-click` route carrying the `searchId` correlation
 * token (TS-217-prep-4a), the clicked `providerId`, and the zero-based result
 * `position`. The beacon survives the navigation (that's what `sendBeacon` is
 * for) and never blocks or fails it — a click report is telemetry, not a
 * correctness-bearing write.
 *
 * `searchId` is null when the search response carried no correlation token
 * (e.g. the result load failed); in that case the component renders a plain
 * `<Link>` with no beacon. Navigation is never prevented.
 */
export function RecordSearchClickLink({
  href,
  searchId,
  providerId,
  position,
  className,
  children,
}: {
  readonly href: string;
  readonly searchId: string | null;
  readonly providerId: string;
  readonly position: number;
  readonly className?: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  function handleClick(): void {
    if (searchId === null) return;
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    try {
      const payload = JSON.stringify({ searchId, providerId, position });
      navigator.sendBeacon('/api/search-click', new Blob([payload], { type: 'application/json' }));
    } catch {
      // Best-effort: never let a click beacon interfere with navigation.
    }
  }

  return (
    <Link href={href} className={className} onClick={handleClick}>
      {children}
    </Link>
  );
}
