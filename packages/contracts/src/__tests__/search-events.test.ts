import { describe, expect, it } from 'vitest';

import {
  eventRegistry,
  getEventSchema,
  SEARCH_PERFORMED,
  SEARCH_PERFORMED_QUERY_TEXT_MAX_LENGTH,
  SEARCH_RESULT_CLICKED,
  SEARCH_RESULT_CLICKED_ID_MAX_LENGTH,
  SEARCH_RESULT_CLICKED_POSITION_MAX,
  SearchPerformedSchema,
  SearchResultClickedSchema,
} from '../events';

/**
 * Contract tests for the `search.performed` event (TS-217-prep-1).
 *
 * The event is the data backbone for the TS-217 search-relevance
 * dashboard. These tests pin the wire shape (`.strict()`), the
 * envelope, the PII-discipline cap on `queryText`, and the two
 * cross-field invariants (`zeroResults` ⇔ `totalEstimate === 0`;
 * `resultCount <= totalEstimate`).
 */
describe('search.performed registry wiring', () => {
  it('is registered under its dotted constant', () => {
    expect(eventRegistry[SEARCH_PERFORMED]).toBe(SearchPerformedSchema);
    expect(getEventSchema(SEARCH_PERFORMED)).toBe(SearchPerformedSchema);
  });

  it('uses a past-tense dotted name', () => {
    expect(SEARCH_PERFORMED).toBe('search.performed');
    expect(SEARCH_PERFORMED).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});

describe('SearchPerformed event', () => {
  const valid = {
    eventId: 'evt_search_1',
    occurredAt: '2026-06-08T12:00:00.000Z',
    actorUserId: 'user_abc',
    queryText: 'kosher italian chef',
    sort: 'relevance' as const,
    hasGeo: false,
    appliedFilters: ['languages', 'cuisines'] as const,
    filterTiers: ['elite'] as const,
    resultCount: 3,
    totalEstimate: 12,
    zeroResults: false,
    page: 'first' as const,
    liveMode: false,
  };

  it('accepts a valid payload', () => {
    expect(SearchPerformedSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a null queryText (no text query)', () => {
    expect(SearchPerformedSchema.safeParse({ ...valid, queryText: null }).success).toBe(true);
  });

  it('accepts the zero-result shape', () => {
    const parsed = SearchPerformedSchema.safeParse({
      ...valid,
      resultCount: 0,
      totalEstimate: 0,
      zeroResults: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts empty filter facets + tiers', () => {
    expect(
      SearchPerformedSchema.safeParse({ ...valid, appliedFilters: [], filterTiers: [] }).success,
    ).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(SearchPerformedSchema.safeParse({ ...valid, extraField: 'no' }).success).toBe(false);
  });

  it('requires an ISO `occurredAt`', () => {
    expect(SearchPerformedSchema.safeParse({ ...valid, occurredAt: 'now' }).success).toBe(false);
  });

  it('rejects a queryText over the length cap', () => {
    expect(
      SearchPerformedSchema.safeParse({
        ...valid,
        queryText: 'a'.repeat(SEARCH_PERFORMED_QUERY_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown filter-facet key', () => {
    expect(
      SearchPerformedSchema.safeParse({ ...valid, appliedFilters: ['unknown_facet'] }).success,
    ).toBe(false);
  });

  it('rejects an unknown tier value', () => {
    expect(SearchPerformedSchema.safeParse({ ...valid, filterTiers: ['platinum'] }).success).toBe(
      false,
    );
  });

  it('rejects a non-integer / negative resultCount or totalEstimate', () => {
    expect(SearchPerformedSchema.safeParse({ ...valid, resultCount: 1.5 }).success).toBe(false);
    expect(SearchPerformedSchema.safeParse({ ...valid, totalEstimate: -1 }).success).toBe(false);
  });

  it('enforces zeroResults ⇔ totalEstimate === 0', () => {
    // zeroResults=true but totalEstimate>0 → reject.
    expect(
      SearchPerformedSchema.safeParse({
        ...valid,
        resultCount: 0,
        totalEstimate: 5,
        zeroResults: true,
      }).success,
    ).toBe(false);
    // zeroResults=false but totalEstimate===0 → reject.
    expect(
      SearchPerformedSchema.safeParse({
        ...valid,
        resultCount: 0,
        totalEstimate: 0,
        zeroResults: false,
      }).success,
    ).toBe(false);
  });

  it('rejects resultCount greater than totalEstimate', () => {
    expect(
      SearchPerformedSchema.safeParse({ ...valid, resultCount: 13, totalEstimate: 12 }).success,
    ).toBe(false);
  });
});

describe('search.result_clicked registry wiring', () => {
  it('is registered under its dotted constant', () => {
    expect(eventRegistry[SEARCH_RESULT_CLICKED]).toBe(SearchResultClickedSchema);
    expect(getEventSchema(SEARCH_RESULT_CLICKED)).toBe(SearchResultClickedSchema);
  });

  it('uses a past-tense dotted name', () => {
    expect(SEARCH_RESULT_CLICKED).toBe('search.result_clicked');
    expect(SEARCH_RESULT_CLICKED).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});

describe('SearchResultClicked event', () => {
  const valid = {
    eventId: 'evt_click_1',
    occurredAt: '2026-06-09T12:00:00.000Z',
    searchId: 'evt_search_1',
    actorUserId: 'user_abc',
    providerId: 'prv_123',
    position: 0,
  };

  it('accepts a valid payload', () => {
    expect(SearchResultClickedSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts the position cap', () => {
    expect(
      SearchResultClickedSchema.safeParse({
        ...valid,
        position: SEARCH_RESULT_CLICKED_POSITION_MAX,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(SearchResultClickedSchema.safeParse({ ...valid, extraField: 'no' }).success).toBe(false);
  });

  it('requires an ISO `occurredAt`', () => {
    expect(SearchResultClickedSchema.safeParse({ ...valid, occurredAt: 'now' }).success).toBe(
      false,
    );
  });

  it('rejects an empty searchId / providerId', () => {
    expect(SearchResultClickedSchema.safeParse({ ...valid, searchId: '' }).success).toBe(false);
    expect(SearchResultClickedSchema.safeParse({ ...valid, providerId: '' }).success).toBe(false);
  });

  it('rejects a searchId over the id length cap', () => {
    expect(
      SearchResultClickedSchema.safeParse({
        ...valid,
        searchId: 'a'.repeat(SEARCH_RESULT_CLICKED_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects a negative / non-integer / over-cap position', () => {
    expect(SearchResultClickedSchema.safeParse({ ...valid, position: -1 }).success).toBe(false);
    expect(SearchResultClickedSchema.safeParse({ ...valid, position: 1.5 }).success).toBe(false);
    expect(
      SearchResultClickedSchema.safeParse({
        ...valid,
        position: SEARCH_RESULT_CLICKED_POSITION_MAX + 1,
      }).success,
    ).toBe(false);
  });
});
