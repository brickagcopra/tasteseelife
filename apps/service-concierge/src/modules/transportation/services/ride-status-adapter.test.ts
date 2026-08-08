import { describe, expect, it } from 'vitest';

import { mapVendorRideStatus } from './ride-status-adapter';

/**
 * Unit tests for the vendor ride-status adapter (TS-226). Pins the Phase-1
 * scaffold mapping per vendor + the case-insensitive normalisation + the
 * unrecognised-status → null contract the webhook path relies on.
 */
describe('mapVendorRideStatus', () => {
  it('maps Uber Health booking states to scheduled', () => {
    expect(mapVendorRideStatus('uber_health', 'processing')).toBe('scheduled');
    expect(mapVendorRideStatus('uber_health', 'accepted')).toBe('scheduled');
  });

  it('maps Uber Health en-route / arriving states to in_progress', () => {
    expect(mapVendorRideStatus('uber_health', 'arriving')).toBe('in_progress');
    expect(mapVendorRideStatus('uber_health', 'on_trip')).toBe('in_progress');
  });

  it('maps Uber Health completion + cancellation', () => {
    expect(mapVendorRideStatus('uber_health', 'completed')).toBe('completed');
    expect(mapVendorRideStatus('uber_health', 'rider_canceled')).toBe('canceled');
    expect(mapVendorRideStatus('uber_health', 'no_drivers_available')).toBe('canceled');
  });

  it('maps Lyft lifecycle states', () => {
    expect(mapVendorRideStatus('lyft_health', 'pending')).toBe('scheduled');
    expect(mapVendorRideStatus('lyft_health', 'arrived')).toBe('in_progress');
    expect(mapVendorRideStatus('lyft_health', 'droppedoff')).toBe('completed');
    expect(mapVendorRideStatus('lyft_health', 'canceled')).toBe('canceled');
  });

  it('normalises case + surrounding whitespace', () => {
    expect(mapVendorRideStatus('uber_health', '  COMPLETED ')).toBe('completed');
    expect(mapVendorRideStatus('lyft_health', 'Arrived')).toBe('in_progress');
  });

  it('returns null for an unrecognised raw status', () => {
    expect(mapVendorRideStatus('uber_health', 'gremlin')).toBeNull();
    expect(mapVendorRideStatus('lyft_health', '')).toBeNull();
  });

  it('returns null for the manual provider (no vendor edge)', () => {
    expect(mapVendorRideStatus('manual', 'completed')).toBeNull();
  });

  it('does not cross-map a vendor-specific status to the wrong vendor', () => {
    // `on_trip` is an Uber status; Lyft has no such value.
    expect(mapVendorRideStatus('lyft_health', 'on_trip')).toBeNull();
    // `pickedup` is a Lyft status; Uber has no such value.
    expect(mapVendorRideStatus('uber_health', 'pickedup')).toBeNull();
  });
});
