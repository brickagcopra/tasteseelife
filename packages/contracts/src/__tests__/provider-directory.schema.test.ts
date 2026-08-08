import { describe, expect, it } from 'vitest';

import {
  PROVIDER_DIRECTORY_LIMIT_DEFAULT,
  PROVIDER_DIRECTORY_LIMIT_MAX,
  PROVIDER_DIRECTORY_OFFSET_MAX,
  ListProvidersQuerySchema,
  ProviderDirectoryListResponseSchema,
  ProviderDirectoryRowSchema,
} from '../http/provider-directory.schema';

/**
 * Contract tests for the admin provider directory (TS-305c-followup-1).
 *
 * The load-bearing assertions here are the two exclusions and the one
 * default:
 *
 *   1. A directory row must NOT carry `bio` or the media keys. A list
 *      read lands in a browser cache, an RSC payload, and any error
 *      report that captures a response body; the prose belongs on the
 *      360, one click away. `.strict()` turns a future re-widening into
 *      a failing test.
 *
 *   2. `includeArchived` must DEFAULT TO FALSE. The directory is a
 *      working set; an archived provider stays reachable by explicit
 *      opt-in, never by accident.
 *
 *   3. `limit` and `offset` are echoed back as applied, so a clamped
 *      request cannot be mistaken for an honoured one.
 */

const ROW = {
  id: 'prov_1',
  userId: 'usr_1',
  status: 'active',
  tier: 'certified',
  displayName: 'Chef Amara',
  headline: 'Slow-cooked comfort food',
  timeZone: 'America/New_York',
  dementiaSensitive: true,
  createdAt: '2026-01-04T10:00:00.000Z',
  deletedAt: null,
} as const;

describe('ProviderDirectoryRowSchema', () => {
  it('accepts a well-formed row', () => {
    expect(ProviderDirectoryRowSchema.parse(ROW)).toEqual(ROW);
  });

  it('accepts an archived row (non-null deletedAt)', () => {
    const parsed = ProviderDirectoryRowSchema.parse({
      ...ROW,
      status: 'archived',
      deletedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(parsed.deletedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('accepts a null headline', () => {
    expect(ProviderDirectoryRowSchema.parse({ ...ROW, headline: null }).headline).toBeNull();
  });

  it('REJECTS a bio — prose belongs on the 360, not in a list read', () => {
    const result = ProviderDirectoryRowSchema.safeParse({ ...ROW, bio: 'Twenty years of...' });
    expect(result.success).toBe(false);
  });

  it('REJECTS media keys — handles into media storage are not list data', () => {
    expect(
      ProviderDirectoryRowSchema.safeParse({ ...ROW, profilePhotoKey: 'k/1.jpg' }).success,
    ).toBe(false);
    expect(ProviderDirectoryRowSchema.safeParse({ ...ROW, videoIntroKey: 'k/1.mp4' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown status or tier', () => {
    expect(ProviderDirectoryRowSchema.safeParse({ ...ROW, status: 'retired' }).success).toBe(false);
    expect(ProviderDirectoryRowSchema.safeParse({ ...ROW, tier: 'platinum' }).success).toBe(false);
  });

  it('rejects a non-ISO createdAt', () => {
    expect(ProviderDirectoryRowSchema.safeParse({ ...ROW, createdAt: '2026-01-04' }).success).toBe(
      false,
    );
  });
});

describe('ListProvidersQuerySchema', () => {
  it('defaults limit, offset, and includeArchived on an empty query', () => {
    expect(ListProvidersQuerySchema.parse({})).toEqual({
      includeArchived: false,
      limit: PROVIDER_DIRECTORY_LIMIT_DEFAULT,
      offset: 0,
    });
  });

  it('coerces limit and offset from query-string strings', () => {
    const parsed = ListProvidersQuerySchema.parse({ limit: '10', offset: '20' });
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(20);
  });

  it('accepts includeArchived as the string "true" and as a boolean', () => {
    expect(ListProvidersQuerySchema.parse({ includeArchived: 'true' }).includeArchived).toBe(true);
    expect(ListProvidersQuerySchema.parse({ includeArchived: true }).includeArchived).toBe(true);
  });

  it('treats includeArchived="false" as false', () => {
    expect(ListProvidersQuerySchema.parse({ includeArchived: 'false' }).includeArchived).toBe(
      false,
    );
  });

  it('rejects an includeArchived value that is neither "true" nor "false"', () => {
    // A silent coercion of "yes" / "1" to false would hide an archived
    // provider from an operator who believed they had asked for one.
    expect(ListProvidersQuerySchema.safeParse({ includeArchived: 'yes' }).success).toBe(false);
    expect(ListProvidersQuerySchema.safeParse({ includeArchived: '1' }).success).toBe(false);
  });

  it('trims q and rejects a whitespace-only q', () => {
    expect(ListProvidersQuerySchema.parse({ q: '  amara  ' }).q).toBe('amara');
    expect(ListProvidersQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('rejects a q longer than the search bound', () => {
    expect(ListProvidersQuerySchema.safeParse({ q: 'x'.repeat(65) }).success).toBe(false);
  });

  it('rejects a limit above the ceiling rather than clamping it', () => {
    expect(
      ListProvidersQuerySchema.safeParse({ limit: PROVIDER_DIRECTORY_LIMIT_MAX + 1 }).success,
    ).toBe(false);
  });

  it('rejects a zero or negative limit', () => {
    expect(ListProvidersQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListProvidersQuerySchema.safeParse({ limit: -1 }).success).toBe(false);
  });

  it('rejects a deep offset beyond the ceiling', () => {
    expect(
      ListProvidersQuerySchema.safeParse({ offset: PROVIDER_DIRECTORY_OFFSET_MAX + 1 }).success,
    ).toBe(false);
  });

  it('rejects an unknown filter key', () => {
    // `.strict()` here is what makes the gateway able to 400 a typo'd
    // filter instead of quietly returning an unfiltered directory.
    expect(ListProvidersQuerySchema.safeParse({ statuss: 'active' }).success).toBe(false);
  });
});

describe('ProviderDirectoryListResponseSchema', () => {
  it('accepts a populated page and echoes the applied paging', () => {
    const parsed = ProviderDirectoryListResponseSchema.parse({
      providers: [ROW],
      total: 187,
      limit: 25,
      offset: 50,
    });
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.total).toBe(187);
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(50);
  });

  it('accepts an empty page with a non-zero total (paged past the end)', () => {
    expect(
      ProviderDirectoryListResponseSchema.safeParse({
        providers: [],
        total: 3,
        limit: 25,
        offset: 100,
      }).success,
    ).toBe(true);
  });

  it('rejects a missing total — a page with no count makes the operator page blind', () => {
    expect(
      ProviderDirectoryListResponseSchema.safeParse({ providers: [], limit: 25, offset: 0 })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(
      ProviderDirectoryListResponseSchema.safeParse({
        providers: [],
        total: 0,
        limit: 25,
        offset: 0,
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});
