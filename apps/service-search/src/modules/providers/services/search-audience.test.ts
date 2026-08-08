import { AdTargetingAudienceSchema } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { deriveSearchAudience } from './search-audience';

describe('deriveSearchAudience (TS-218b)', () => {
  it('returns a schema-valid, deliberately-empty Phase-1 audience', () => {
    const audience = deriveSearchAudience();
    // Parses against the canonical targeting-audience grammar (TS-273).
    expect(() => AdTargetingAudienceSchema.parse(audience)).not.toThrow();
    expect(audience.behaviorCohorts).toEqual([]);
  });

  it('leaves every single-valued dimension unknown (fail-closed for targeted ads)', () => {
    const audience = deriveSearchAudience();
    // null/undefined for each — only untargeted campaigns deliver in Phase 1.
    expect(audience.geography ?? null).toBeNull();
    expect(audience.persona ?? null).toBeNull();
    expect(audience.tier ?? null).toBeNull();
    expect(audience.householdComposition ?? null).toBeNull();
  });
});
