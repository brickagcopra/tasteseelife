import { describe, expect, it } from 'vitest';

import {
  BOOKING_TIER_GATING_VIOLATION,
  BookingTierGatingModeSchema,
  BookingTierGatingViolationReasonSchema,
  BookingTierGatingViolationSchema,
  eventRegistry,
  getEventSchema,
} from '../events';
import {
  HouseholdSubscriptionTierSchema,
  HouseholdTierSnapshotResponseSchema,
  ProviderTierSnapshotResponseSchema,
  ProviderTierSnapshotTierSchema,
  TIER_SNAPSHOT_SOURCE_EVENT_ID_MAX_LENGTH,
  UpsertHouseholdTierSnapshotRequestSchema,
  UpsertProviderTierSnapshotRequestSchema,
} from '../http';

/**
 * Booking tier-snapshot contract tests (TS-064; PRD §5.1 / §5.2;
 * CLAUDE.md §12).
 *
 * Validates the request / response shapes accept the Phase-1 happy
 * paths and reject structural pitfalls (unknown enum values,
 * oversize source-event ids, missing required fields, stray unknown
 * fields).
 */

describe('HouseholdSubscriptionTierSchema', () => {
  it('accepts the three Phase-1 tiers', () => {
    expect(HouseholdSubscriptionTierSchema.safeParse('tier_1_essential').success).toBe(true);
    expect(HouseholdSubscriptionTierSchema.safeParse('tier_2_companion').success).toBe(true);
    expect(HouseholdSubscriptionTierSchema.safeParse('tier_3_concierge').success).toBe(true);
  });

  it('rejects unknown discriminator values', () => {
    expect(HouseholdSubscriptionTierSchema.safeParse('tier_4').success).toBe(false);
    expect(HouseholdSubscriptionTierSchema.safeParse('TIER_1_ESSENTIAL').success).toBe(false);
    expect(HouseholdSubscriptionTierSchema.safeParse('').success).toBe(false);
  });
});

describe('ProviderTierSnapshotTierSchema', () => {
  it('accepts basic / certified / elite', () => {
    expect(ProviderTierSnapshotTierSchema.safeParse('basic').success).toBe(true);
    expect(ProviderTierSnapshotTierSchema.safeParse('certified').success).toBe(true);
    expect(ProviderTierSnapshotTierSchema.safeParse('elite').success).toBe(true);
  });

  it('rejects unknown discriminator values', () => {
    expect(ProviderTierSnapshotTierSchema.safeParse('platinum').success).toBe(false);
    expect(ProviderTierSnapshotTierSchema.safeParse('BASIC').success).toBe(false);
  });
});

describe('UpsertHouseholdTierSnapshotRequestSchema', () => {
  const minimal = {
    householdId: 'hh_abc',
    tier: 'tier_2_companion' as const,
    lastSyncedAt: '2026-05-14T10:00:00.000Z',
  };

  it('accepts a minimal request without sourceEventId', () => {
    expect(UpsertHouseholdTierSnapshotRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts a request with sourceEventId', () => {
    expect(
      UpsertHouseholdTierSnapshotRequestSchema.safeParse({
        ...minimal,
        sourceEventId: 'evt_abc123',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown field', () => {
    const result = UpsertHouseholdTierSnapshotRequestSchema.safeParse({
      ...minimal,
      providerId: 'prv_xyz',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', () => {
    expect(
      UpsertHouseholdTierSnapshotRequestSchema.safeParse({
        householdId: 'hh_abc',
        tier: 'tier_3_concierge' as const,
        // lastSyncedAt missing
      }).success,
    ).toBe(false);
  });

  it('rejects an empty householdId', () => {
    expect(
      UpsertHouseholdTierSnapshotRequestSchema.safeParse({ ...minimal, householdId: '' }).success,
    ).toBe(false);
  });

  it('rejects an oversize sourceEventId', () => {
    expect(
      UpsertHouseholdTierSnapshotRequestSchema.safeParse({
        ...minimal,
        sourceEventId: 'x'.repeat(TIER_SNAPSHOT_SOURCE_EVENT_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO lastSyncedAt', () => {
    expect(
      UpsertHouseholdTierSnapshotRequestSchema.safeParse({
        ...minimal,
        lastSyncedAt: '2026-05-14 10:00:00',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown tier value', () => {
    expect(
      UpsertHouseholdTierSnapshotRequestSchema.safeParse({ ...minimal, tier: 'tier_4' }).success,
    ).toBe(false);
  });
});

describe('UpsertProviderTierSnapshotRequestSchema', () => {
  const minimal = {
    providerId: 'prv_xyz',
    tier: 'elite' as const,
    lastSyncedAt: '2026-05-14T10:00:00.000Z',
  };

  it('accepts a minimal request', () => {
    expect(UpsertProviderTierSnapshotRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects an unknown tier', () => {
    expect(
      UpsertProviderTierSnapshotRequestSchema.safeParse({ ...minimal, tier: 'platinum' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      UpsertProviderTierSnapshotRequestSchema.safeParse({ ...minimal, householdId: 'hh_x' })
        .success,
    ).toBe(false);
  });
});

describe('HouseholdTierSnapshotResponseSchema', () => {
  const happy = {
    householdId: 'hh_abc',
    tier: 'tier_3_concierge' as const,
    lastSyncedAt: '2026-05-14T10:00:00.000Z',
    sourceEventId: null,
    createdAt: '2026-05-14T10:00:00.000Z',
    updatedAt: '2026-05-14T10:00:00.000Z',
  };

  it('accepts a row with null sourceEventId', () => {
    expect(HouseholdTierSnapshotResponseSchema.safeParse(happy).success).toBe(true);
  });

  it('accepts a row with populated sourceEventId', () => {
    expect(
      HouseholdTierSnapshotResponseSchema.safeParse({ ...happy, sourceEventId: 'evt_x' }).success,
    ).toBe(true);
  });

  it('rejects an empty sourceEventId string (must be null when absent)', () => {
    expect(
      HouseholdTierSnapshotResponseSchema.safeParse({ ...happy, sourceEventId: '' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(HouseholdTierSnapshotResponseSchema.safeParse({ ...happy, extra: 'oops' }).success).toBe(
      false,
    );
  });
});

describe('ProviderTierSnapshotResponseSchema', () => {
  it('accepts a happy-path response', () => {
    expect(
      ProviderTierSnapshotResponseSchema.safeParse({
        providerId: 'prv_xyz',
        tier: 'elite',
        lastSyncedAt: '2026-05-14T10:00:00.000Z',
        sourceEventId: 'evt_y',
        createdAt: '2026-05-14T10:00:00.000Z',
        updatedAt: '2026-05-14T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});

describe('BookingTierGatingModeSchema', () => {
  it('accepts enforce and advisory', () => {
    expect(BookingTierGatingModeSchema.safeParse('enforce').success).toBe(true);
    expect(BookingTierGatingModeSchema.safeParse('advisory').success).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(BookingTierGatingModeSchema.safeParse('off').success).toBe(false);
  });
});

describe('BookingTierGatingViolationReasonSchema', () => {
  it('accepts the four categorical reasons', () => {
    expect(BookingTierGatingViolationReasonSchema.safeParse('tier_3_requires_elite').success).toBe(
      true,
    );
    expect(
      BookingTierGatingViolationReasonSchema.safeParse('household_snapshot_unknown').success,
    ).toBe(true);
    expect(
      BookingTierGatingViolationReasonSchema.safeParse('provider_snapshot_unknown').success,
    ).toBe(true);
    // TS-220-followup-1 — per-service-kind catalog tier gate.
    expect(
      BookingTierGatingViolationReasonSchema.safeParse('service_kind_requires_higher_tier').success,
    ).toBe(true);
  });

  it('rejects unknown reasons', () => {
    expect(BookingTierGatingViolationReasonSchema.safeParse('snapshot_stale').success).toBe(false);
  });
});

describe('BookingTierGatingViolationSchema', () => {
  const happy = {
    eventId: 'evt_abc',
    occurredAt: '2026-05-14T10:00:00.000Z',
    attemptId: 'bkg_attempt_123',
    mode: 'enforce' as const,
    reason: 'tier_3_requires_elite' as const,
    householdId: 'hh_abc',
    providerId: 'prv_xyz',
    householdTier: 'tier_3_concierge' as const,
    providerTier: 'certified' as const,
    actorUserId: 'usr_actor',
    serviceKind: 'companion_dining' as const,
  };

  it('accepts a fully-populated enforce-mode violation', () => {
    expect(BookingTierGatingViolationSchema.safeParse(happy).success).toBe(true);
  });

  it('accepts a missing-household snapshot variant with null householdTier', () => {
    const variant = {
      ...happy,
      reason: 'household_snapshot_unknown' as const,
      householdTier: null,
    };
    expect(BookingTierGatingViolationSchema.safeParse(variant).success).toBe(true);
  });

  it('accepts a missing-provider snapshot variant with null providerTier', () => {
    const variant = {
      ...happy,
      reason: 'provider_snapshot_unknown' as const,
      providerTier: null,
    };
    expect(BookingTierGatingViolationSchema.safeParse(variant).success).toBe(true);
  });

  it('accepts an advisory-mode violation', () => {
    expect(BookingTierGatingViolationSchema.safeParse({ ...happy, mode: 'advisory' }).success).toBe(
      true,
    );
  });

  it('accepts a service-kind catalog-tier variant (TS-220-followup-1)', () => {
    const variant = {
      ...happy,
      reason: 'service_kind_requires_higher_tier' as const,
      serviceKind: 'memory_meal' as const,
      householdTier: 'tier_1_essential' as const,
      providerTier: 'basic' as const,
    };
    expect(BookingTierGatingViolationSchema.safeParse(variant).success).toBe(true);
  });

  it('rejects unknown fields (PII discipline)', () => {
    expect(
      BookingTierGatingViolationSchema.safeParse({ ...happy, bookingNotes: 'leak' }).success,
    ).toBe(false);
  });

  it('rejects an unknown serviceKind', () => {
    expect(
      BookingTierGatingViolationSchema.safeParse({ ...happy, serviceKind: 'spa_day' }).success,
    ).toBe(false);
  });
});

describe('eventRegistry', () => {
  it('exposes BOOKING_TIER_GATING_VIOLATION', () => {
    expect(BOOKING_TIER_GATING_VIOLATION).toBe('booking.tier_gating_violation');
    expect(eventRegistry[BOOKING_TIER_GATING_VIOLATION]).toBe(BookingTierGatingViolationSchema);
  });

  it('round-trips via getEventSchema(name)', () => {
    expect(getEventSchema('booking.tier_gating_violation')).toBe(BookingTierGatingViolationSchema);
  });
});
