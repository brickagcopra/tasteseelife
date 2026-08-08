import type {
  ConciergeRideStatus,
  ConciergeTransportationProvider,
} from '@taste-and-see/contracts';

/**
 * Vendor ride-status adapter (TS-226) — the Phase-3 seam that maps a
 * ride-hailing vendor's raw status string onto our vendor-agnostic domain
 * `ConciergeRideStatus` lifecycle.
 *
 * **Scaffold, not the live vocabulary.** The maps below carry a representative
 * subset of each vendor's documented status values so the webhook path is
 * functional + testable today. The authoritative, exhaustive vocabulary lands
 * with the Uber Health / Lyft Health SDK integration (TS-226-followup, behind
 * its required SDK ADR) — at which point this map is the single place to
 * extend. An unrecognised raw status returns `null`; the caller stores the raw
 * value verbatim but leaves the domain status unchanged (the scaffold degrades
 * rather than guesses).
 *
 * `manual` is intentionally absent: a manually-coordinated ride has no vendor
 * edge, so the webhook controller rejects a `manual` event before reaching the
 * adapter. Asking the adapter to map a `manual` status always returns `null`.
 *
 * Keys are normalised (lowercased + trimmed) so a vendor's `Completed` /
 * `completed` / ` COMPLETED ` all resolve.
 */
const VENDOR_STATUS_MAP: Record<
  ConciergeTransportationProvider,
  Readonly<Record<string, ConciergeRideStatus>>
> = {
  manual: {},
  // Uber Health ride lifecycle (representative subset).
  uber_health: {
    processing: 'scheduled',
    accepted: 'scheduled',
    scheduled: 'scheduled',
    arriving: 'in_progress',
    arrived: 'in_progress',
    in_progress: 'in_progress',
    on_trip: 'in_progress',
    completed: 'completed',
    no_drivers_available: 'canceled',
    driver_canceled: 'canceled',
    rider_canceled: 'canceled',
    canceled: 'canceled',
  },
  // Lyft ride lifecycle (representative subset).
  lyft_health: {
    pending: 'scheduled',
    accepted: 'scheduled',
    scheduled: 'scheduled',
    arrived: 'in_progress',
    pickedup: 'in_progress',
    droppedoff: 'completed',
    completed: 'completed',
    canceled: 'canceled',
  },
};

/**
 * Map a vendor's raw ride-status string onto the domain `ConciergeRideStatus`,
 * or `null` when the value has no mapping for the given provider (caller stores
 * the raw value but leaves the domain status unchanged).
 */
export function mapVendorRideStatus(
  provider: ConciergeTransportationProvider,
  rawStatus: string,
): ConciergeRideStatus | null {
  const normalised = rawStatus.trim().toLowerCase();
  const providerMap = VENDOR_STATUS_MAP[provider];
  return providerMap[normalised] ?? null;
}
