import { describe, expect, it } from 'vitest';

import { SEARCH_RESULT_CLICKED_POSITION_MAX } from '../events';
import {
  RecordSearchClickRequestSchema,
  RecordSearchClickResponseSchema,
} from '../http/search-click.schema';

/**
 * Contract tests for the search result-click ingest pair (TS-217-prep-4b).
 * The request is what the family-portal beacon sends to
 * `POST /api/v1/search/clicks`; the response is the best-effort ack.
 */
describe('RecordSearchClickRequest', () => {
  const valid = { searchId: 'evt_search_1', providerId: 'prv_123', position: 0 };

  it('accepts a valid payload', () => {
    expect(RecordSearchClickRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts the position cap', () => {
    expect(
      RecordSearchClickRequestSchema.safeParse({
        ...valid,
        position: SEARCH_RESULT_CLICKED_POSITION_MAX,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(RecordSearchClickRequestSchema.safeParse({ ...valid, actorUserId: 'no' }).success).toBe(
      false,
    );
  });

  it('rejects an empty searchId / providerId', () => {
    expect(RecordSearchClickRequestSchema.safeParse({ ...valid, searchId: '' }).success).toBe(
      false,
    );
    expect(RecordSearchClickRequestSchema.safeParse({ ...valid, providerId: '' }).success).toBe(
      false,
    );
  });

  it('rejects a negative / non-integer / over-cap position', () => {
    expect(RecordSearchClickRequestSchema.safeParse({ ...valid, position: -1 }).success).toBe(
      false,
    );
    expect(RecordSearchClickRequestSchema.safeParse({ ...valid, position: 2.5 }).success).toBe(
      false,
    );
    expect(
      RecordSearchClickRequestSchema.safeParse({
        ...valid,
        position: SEARCH_RESULT_CLICKED_POSITION_MAX + 1,
      }).success,
    ).toBe(false);
  });
});

describe('RecordSearchClickResponse', () => {
  it('accepts { accepted: true | false }', () => {
    expect(RecordSearchClickResponseSchema.safeParse({ accepted: true }).success).toBe(true);
    expect(RecordSearchClickResponseSchema.safeParse({ accepted: false }).success).toBe(true);
  });

  it('rejects unknown fields + a non-boolean accepted', () => {
    expect(RecordSearchClickResponseSchema.safeParse({ accepted: 'yes' }).success).toBe(false);
    expect(RecordSearchClickResponseSchema.safeParse({ accepted: true, extra: 1 }).success).toBe(
      false,
    );
  });
});
