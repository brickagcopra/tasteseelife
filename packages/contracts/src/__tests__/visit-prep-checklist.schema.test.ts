import { describe, expect, it } from 'vitest';

import type {
  InternalSeniorPrepSnapshotResponse,
  MemoryRecipe,
  VisitPrepChecklistBooking,
  VisitPrepChecklistResponse,
  VisitPrepChecklistSenior,
} from '../http';
import {
  InternalSeniorPrepSnapshotResponseSchema,
  VisitPrepChecklistBookingSchema,
  VisitPrepChecklistResponseSchema,
  VisitPrepChecklistSeniorSchema,
  VISIT_PREP_MEMORY_RECIPES_MAX,
} from '../http';

const sampleRecipe = (id: string, requested: boolean): MemoryRecipe => ({
  id,
  seniorId: 'senior_abc',
  title: 'Sunday roast',
  description: 'A warm, comforting meal Mom remembers from her childhood.',
  source: 'family_contribution',
  cuisineTag: 'american',
  imageKey: null,
  requestedForUpcomingVisit: requested,
  contributedByUserId: 'user_xyz',
  sortPosition: 0,
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z',
});

const sampleSenior: VisitPrepChecklistSenior = {
  seniorId: 'senior_abc',
  dietaryTags: ['low_sodium', 'soft_textures'],
  allergenTags: ['peanut', 'shellfish'],
  languageTags: ['en-US', 'es'],
  mobilityLevel: 'aided_cane',
  dementiaStatus: 'mild_cognitive_impairment',
  intakeCompletedAt: '2026-05-01T12:00:00.000Z',
};

const sampleBooking: VisitPrepChecklistBooking = {
  id: 'booking_1',
  householdId: 'household_1',
  seniorId: 'senior_abc',
  providerId: 'provider_1',
  serviceKind: 'companion_dining',
  status: 'confirmed',
  scheduledStart: '2026-05-22T18:00:00.000Z',
  scheduledEnd: '2026-05-22T20:00:00.000Z',
  acceptWindowExpiresAt: '2026-05-21T19:00:00.000Z',
  onHold: false,
};

describe('VisitPrepChecklistSeniorSchema', () => {
  it('accepts the canonical senior projection', () => {
    expect(VisitPrepChecklistSeniorSchema.safeParse(sampleSenior).success).toBe(true);
  });

  it('accepts a null intakeCompletedAt (intake never completed)', () => {
    const result = VisitPrepChecklistSeniorSchema.safeParse({
      ...sampleSenior,
      intakeCompletedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown dementia status', () => {
    const result = VisitPrepChecklistSeniorSchema.safeParse({
      ...sampleSenior,
      dementiaStatus: 'severe',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown mobility level', () => {
    const result = VisitPrepChecklistSeniorSchema.safeParse({
      ...sampleSenior,
      mobilityLevel: 'jogger',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields (strict)', () => {
    const result = VisitPrepChecklistSeniorSchema.safeParse({
      ...sampleSenior,
      medicalNotes: 'should be rejected — TS-208 excludes sensitive notes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty seniorId', () => {
    const result = VisitPrepChecklistSeniorSchema.safeParse({
      ...sampleSenior,
      seniorId: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('VisitPrepChecklistBookingSchema', () => {
  it('accepts the canonical booking projection', () => {
    expect(VisitPrepChecklistBookingSchema.safeParse(sampleBooking).success).toBe(true);
  });

  it('accepts every booking status (the surface is reachable for confirmed + past visits too)', () => {
    (['pending', 'confirmed', 'in_progress', 'completed', 'canceled', 'declined'] as const).forEach(
      (status) => {
        const result = VisitPrepChecklistBookingSchema.safeParse({
          ...sampleBooking,
          status,
        });
        expect(result.success).toBe(true);
      },
    );
  });

  it('rejects an unknown service kind', () => {
    const result = VisitPrepChecklistBookingSchema.safeParse({
      ...sampleBooking,
      serviceKind: 'cooking_lesson',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields (strict)', () => {
    const result = VisitPrepChecklistBookingSchema.safeParse({
      ...sampleBooking,
      basePriceMinor: 12_500,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a null acceptWindowExpiresAt (back-fill rows pre-TS-205)', () => {
    const result = VisitPrepChecklistBookingSchema.safeParse({
      ...sampleBooking,
      acceptWindowExpiresAt: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('VisitPrepChecklistResponseSchema', () => {
  const sample: VisitPrepChecklistResponse = {
    booking: sampleBooking,
    senior: sampleSenior,
    memoryRecipes: [sampleRecipe('mr_1', true), sampleRecipe('mr_2', false)],
    generatedAt: '2026-05-21T17:00:00.000Z',
  };

  it('accepts the canonical aggregated response', () => {
    expect(VisitPrepChecklistResponseSchema.safeParse(sample).success).toBe(true);
  });

  it('accepts an empty memory recipes array', () => {
    const result = VisitPrepChecklistResponseSchema.safeParse({
      ...sample,
      memoryRecipes: [],
    });
    expect(result.success).toBe(true);
  });

  it(`rejects more than ${VISIT_PREP_MEMORY_RECIPES_MAX} recipes`, () => {
    const overflow = Array.from({ length: VISIT_PREP_MEMORY_RECIPES_MAX + 1 }, (_, idx) =>
      sampleRecipe(`mr_${idx}`, false),
    );
    const result = VisitPrepChecklistResponseSchema.safeParse({
      ...sample,
      memoryRecipes: overflow,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-datetime generatedAt', () => {
    const result = VisitPrepChecklistResponseSchema.safeParse({
      ...sample,
      generatedAt: 'yesterday',
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra top-level fields (strict)', () => {
    const result = VisitPrepChecklistResponseSchema.safeParse({
      ...sample,
      householdAccessInstructions: 'should be rejected — Phase-1 scope',
    });
    expect(result.success).toBe(false);
  });
});

describe('InternalSeniorPrepSnapshotResponseSchema', () => {
  const sample: InternalSeniorPrepSnapshotResponse = {
    senior: sampleSenior,
    memoryRecipes: [sampleRecipe('mr_1', true)],
  };

  it('accepts the canonical internal shape', () => {
    expect(InternalSeniorPrepSnapshotResponseSchema.safeParse(sample).success).toBe(true);
  });

  it('rejects extra fields (strict)', () => {
    const result = InternalSeniorPrepSnapshotResponseSchema.safeParse({
      ...sample,
      booking: sampleBooking,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing memoryRecipes array', () => {
    const result = InternalSeniorPrepSnapshotResponseSchema.safeParse({
      senior: sampleSenior,
    });
    expect(result.success).toBe(false);
  });
});

describe('VISIT_PREP_MEMORY_RECIPES_MAX', () => {
  it('exports a sensible page-size cap', () => {
    expect(VISIT_PREP_MEMORY_RECIPES_MAX).toBe(24);
  });
});
