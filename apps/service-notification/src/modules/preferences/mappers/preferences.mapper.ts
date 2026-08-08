import type { UserPreferencesResponse } from '@taste-and-see/contracts';
import { UserPreferencesResponseSchema } from '@taste-and-see/contracts';

import type { ResolvedUserPreferences } from '../services/preferences.service';

/**
 * Domain → wire DTO mapper for the per-user preferences view. Parses
 * the wire shape back via the contract schema so a future drift between
 * the service-layer projection and the published HTTP contract surfaces
 * at the boundary, not at the consumer (CLAUDE.md §3.3).
 */
export function toUserPreferencesDto(resolved: ResolvedUserPreferences): UserPreferencesResponse {
  return UserPreferencesResponseSchema.parse({
    userId: resolved.userId,
    entries: resolved.entries,
    quietHours: resolved.quietHours,
    seniorMode: resolved.seniorMode,
    updatedAt: resolved.updatedAt ? resolved.updatedAt.toISOString() : null,
  });
}
