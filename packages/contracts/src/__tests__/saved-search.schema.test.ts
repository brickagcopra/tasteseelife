import { describe, expect, it } from 'vitest';

import type { CreateSavedSearchRequest, SavedSearch } from '../http';
import {
  CreateSavedSearchRequestSchema,
  DeleteSavedSearchResponseSchema,
  GetSavedSearchResponseSchema,
  RunSavedSearchResponseSchema,
  SAVED_SEARCH_ID_MAX_LENGTH,
  SAVED_SEARCH_NAME_MAX_LENGTH,
  SAVED_SEARCH_SENIOR_ID_MAX_LENGTH,
  SAVED_SEARCHES_MAX_PER_OWNER,
  SavedSearchSchema,
  SavedSearchesListResponseSchema,
  UpdateSavedSearchRequestSchema,
} from '../http';

const sampleQuery = {
  query: 'italian',
  sort: 'relevance' as const,
  limit: 20,
};

const sampleSavedSearch: SavedSearch = {
  id: 'ss_abc',
  ownerUserId: 'user_payer',
  seniorId: 'senior_mom',
  name: 'Italian-speaking chefs near Mom',
  query: sampleQuery,
  lastRunAt: '2026-05-21T12:00:00.000Z',
  createdAt: '2026-05-20T11:00:00.000Z',
  updatedAt: '2026-05-21T12:00:00.000Z',
};

describe('SAVED_SEARCH constants', () => {
  it('exports sensible caps', () => {
    expect(SAVED_SEARCH_ID_MAX_LENGTH).toBeGreaterThanOrEqual(24);
    expect(SAVED_SEARCH_NAME_MAX_LENGTH).toBeGreaterThanOrEqual(40);
    expect(SAVED_SEARCH_SENIOR_ID_MAX_LENGTH).toBeGreaterThanOrEqual(24);
    expect(SAVED_SEARCHES_MAX_PER_OWNER).toBeGreaterThanOrEqual(10);
  });
});

describe('SavedSearchSchema', () => {
  it('accepts the canonical sample', () => {
    expect(SavedSearchSchema.safeParse(sampleSavedSearch).success).toBe(true);
  });

  it('accepts null seniorId and null lastRunAt', () => {
    expect(
      SavedSearchSchema.safeParse({
        ...sampleSavedSearch,
        seniorId: null,
        lastRunAt: null,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(SavedSearchSchema.safeParse({ ...sampleSavedSearch, bogus: true }).success).toBe(false);
  });

  it('rejects name longer than the cap', () => {
    expect(
      SavedSearchSchema.safeParse({
        ...sampleSavedSearch,
        name: 'x'.repeat(SAVED_SEARCH_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects empty name', () => {
    expect(SavedSearchSchema.safeParse({ ...sampleSavedSearch, name: '' }).success).toBe(false);
  });

  it('rejects empty ownerUserId', () => {
    expect(SavedSearchSchema.safeParse({ ...sampleSavedSearch, ownerUserId: '' }).success).toBe(
      false,
    );
  });

  it('rejects an invalid query body (the embedded search request schema enforces its own shape)', () => {
    expect(
      SavedSearchSchema.safeParse({
        ...sampleSavedSearch,
        query: { sort: 'distance' }, // distance sort requires geo
      }).success,
    ).toBe(false);
  });
});

describe('CreateSavedSearchRequestSchema', () => {
  const valid: CreateSavedSearchRequest = {
    name: 'Sunday-brunch chefs',
    seniorId: 'senior_mom',
    query: sampleQuery,
  };

  it('accepts a valid request', () => {
    expect(CreateSavedSearchRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an omitted seniorId (generic search)', () => {
    const { seniorId: _unused, ...rest } = valid;
    void _unused;
    expect(CreateSavedSearchRequestSchema.safeParse(rest).success).toBe(true);
  });

  it('accepts null seniorId', () => {
    expect(CreateSavedSearchRequestSchema.safeParse({ ...valid, seniorId: null }).success).toBe(
      true,
    );
  });

  it('rejects an ownerUserId in the body (server-derived)', () => {
    expect(
      CreateSavedSearchRequestSchema.safeParse({ ...valid, ownerUserId: 'user_other' }).success,
    ).toBe(false);
  });

  it('rejects missing name', () => {
    const { name: _unused, ...rest } = valid;
    void _unused;
    expect(CreateSavedSearchRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing query', () => {
    const { query: _unused, ...rest } = valid;
    void _unused;
    expect(CreateSavedSearchRequestSchema.safeParse(rest).success).toBe(false);
  });
});

describe('UpdateSavedSearchRequestSchema', () => {
  it('accepts a name-only patch', () => {
    expect(UpdateSavedSearchRequestSchema.safeParse({ name: 'New name' }).success).toBe(true);
  });

  it('accepts a query-only patch', () => {
    expect(UpdateSavedSearchRequestSchema.safeParse({ query: sampleQuery }).success).toBe(true);
  });

  it('accepts a seniorId clearing patch', () => {
    expect(UpdateSavedSearchRequestSchema.safeParse({ seniorId: null }).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(UpdateSavedSearchRequestSchema.safeParse({ name: 'x', bogus: true }).success).toBe(
      false,
    );
  });

  it('accepts an empty body (service layer rejects)', () => {
    // The contract does not enforce non-empty patches — that is a service-layer
    // concern so the per-service error message can be tailored to the surface.
    expect(UpdateSavedSearchRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe('SavedSearchesListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(SavedSearchesListResponseSchema.safeParse({ savedSearches: [] }).success).toBe(true);
  });

  it('accepts a list of valid rows', () => {
    expect(
      SavedSearchesListResponseSchema.safeParse({
        savedSearches: [sampleSavedSearch],
      }).success,
    ).toBe(true);
  });

  it('rejects an unwrapped array', () => {
    expect(SavedSearchesListResponseSchema.safeParse([sampleSavedSearch]).success).toBe(false);
  });
});

describe('RunSavedSearchResponseSchema', () => {
  it('accepts a valid response', () => {
    expect(RunSavedSearchResponseSchema.safeParse({ savedSearch: sampleSavedSearch }).success).toBe(
      true,
    );
  });

  it('rejects a missing savedSearch field', () => {
    expect(RunSavedSearchResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('GetSavedSearchResponseSchema', () => {
  it('accepts a valid response', () => {
    expect(GetSavedSearchResponseSchema.safeParse({ savedSearch: sampleSavedSearch }).success).toBe(
      true,
    );
  });

  it('rejects a missing savedSearch field', () => {
    expect(GetSavedSearchResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      GetSavedSearchResponseSchema.safeParse({
        savedSearch: sampleSavedSearch,
        bogus: true,
      }).success,
    ).toBe(false);
  });
});

describe('DeleteSavedSearchResponseSchema', () => {
  it('accepts the deleted outcome', () => {
    expect(
      DeleteSavedSearchResponseSchema.safeParse({ outcome: 'deleted', id: 'ss_abc' }).success,
    ).toBe(true);
  });

  it('accepts the not_found outcome', () => {
    expect(
      DeleteSavedSearchResponseSchema.safeParse({ outcome: 'not_found', id: 'ss_abc' }).success,
    ).toBe(true);
  });

  it('rejects an unknown outcome', () => {
    expect(
      DeleteSavedSearchResponseSchema.safeParse({ outcome: 'wat', id: 'ss_abc' }).success,
    ).toBe(false);
  });
});
