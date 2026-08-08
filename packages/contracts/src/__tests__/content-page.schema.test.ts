import { describe, expect, it } from 'vitest';

import {
  CONTENT_PAGES_LIST_LIMIT_DEFAULT,
  CONTENT_PAGES_LIST_LIMIT_MAX,
  CONTENT_PAGE_BODY_MAX_LENGTH,
  CONTENT_PAGE_SLUG_MAX_LENGTH,
  CONTENT_PAGE_TITLE_MAX_LENGTH,
  ContentStatusSchema,
  CreatePageRequestSchema,
  CreatePageVersionRequestSchema,
  ListPagesQuerySchema,
  PageDetailSchema,
  PageRecordSchema,
  PageVersionRecordSchema,
  PublishPageVersionRequestSchema,
} from '../http/content-page.schema';

describe('ContentStatusSchema mirrors the Prisma enum', () => {
  it('accepts the three lifecycle states', () => {
    for (const v of ['draft', 'published', 'archived']) {
      expect(ContentStatusSchema.parse(v)).toBe(v);
    }
  });

  it('rejects an unknown state', () => {
    expect(ContentStatusSchema.safeParse('deleted').success).toBe(false);
  });
});

describe('CreatePageRequestSchema', () => {
  it('accepts a lowercase kebab-case slug + title', () => {
    const parsed = CreatePageRequestSchema.parse({
      slug: 'privacy-policy',
      title: 'Privacy Policy',
    });
    expect(parsed.slug).toBe('privacy-policy');
  });

  it('rejects an upper-case / spaced slug', () => {
    expect(CreatePageRequestSchema.safeParse({ slug: 'Privacy Policy', title: 'x' }).success).toBe(
      false,
    );
    expect(CreatePageRequestSchema.safeParse({ slug: 'privacy_policy', title: 'x' }).success).toBe(
      false,
    );
    expect(CreatePageRequestSchema.safeParse({ slug: '-leading', title: 'x' }).success).toBe(false);
  });

  it('trims and rejects a blank title', () => {
    expect(CreatePageRequestSchema.safeParse({ slug: 'about', title: '   ' }).success).toBe(false);
  });

  it('rejects an over-long slug / title', () => {
    expect(
      CreatePageRequestSchema.safeParse({
        slug: 'a'.repeat(CONTENT_PAGE_SLUG_MAX_LENGTH + 1),
        title: 'x',
      }).success,
    ).toBe(false);
    expect(
      CreatePageRequestSchema.safeParse({
        slug: 'ok',
        title: 'a'.repeat(CONTENT_PAGE_TITLE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(
      CreatePageRequestSchema.safeParse({ slug: 'about', title: 'About', status: 'published' })
        .success,
    ).toBe(false);
  });
});

describe('CreatePageVersionRequestSchema', () => {
  it('accepts a title + body, rejects effectiveAt (server-stamped at publish)', () => {
    expect(CreatePageVersionRequestSchema.parse({ title: 'v1', body: 'hello' }).body).toBe('hello');
    expect(
      CreatePageVersionRequestSchema.safeParse({
        title: 'v1',
        body: 'hello',
        effectiveAt: '2026-06-30T00:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty body and an over-long body', () => {
    expect(CreatePageVersionRequestSchema.safeParse({ title: 'v1', body: '' }).success).toBe(false);
    expect(
      CreatePageVersionRequestSchema.safeParse({
        title: 'v1',
        body: 'a'.repeat(CONTENT_PAGE_BODY_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('PublishPageVersionRequestSchema', () => {
  it('accepts an empty body (publish now)', () => {
    expect(PublishPageVersionRequestSchema.parse({})).toEqual({});
  });

  it('accepts an explicit ISO effectiveAt', () => {
    const parsed = PublishPageVersionRequestSchema.parse({ effectiveAt: '2026-07-01T00:00:00Z' });
    expect(parsed.effectiveAt).toBe('2026-07-01T00:00:00Z');
  });

  it('rejects a non-ISO effectiveAt and unknown fields', () => {
    expect(PublishPageVersionRequestSchema.safeParse({ effectiveAt: 'soon' }).success).toBe(false);
    expect(PublishPageVersionRequestSchema.safeParse({ now: true }).success).toBe(false);
  });

  it('accepts a material-change publish with a note (TS-285)', () => {
    const parsed = PublishPageVersionRequestSchema.parse({
      isMaterialChange: true,
      materialChangeNote: 'New arbitration clause.',
    });
    expect(parsed.isMaterialChange).toBe(true);
    expect(parsed.materialChangeNote).toBe('New arbitration clause.');
  });

  it('accepts the flag without a note', () => {
    expect(PublishPageVersionRequestSchema.safeParse({ isMaterialChange: true }).success).toBe(
      true,
    );
  });

  it('rejects a note WITHOUT the material-change flag', () => {
    expect(
      PublishPageVersionRequestSchema.safeParse({ materialChangeNote: 'orphan note' }).success,
    ).toBe(false);
    expect(
      PublishPageVersionRequestSchema.safeParse({
        isMaterialChange: false,
        materialChangeNote: 'orphan note',
      }).success,
    ).toBe(false);
  });
});

describe('ListPagesQuerySchema', () => {
  it('defaults the limit and coerces a string', () => {
    expect(ListPagesQuerySchema.parse({}).limit).toBe(CONTENT_PAGES_LIST_LIMIT_DEFAULT);
    expect(ListPagesQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('caps the limit and validates status', () => {
    expect(
      ListPagesQuerySchema.safeParse({ limit: String(CONTENT_PAGES_LIST_LIMIT_MAX + 1) }).success,
    ).toBe(false);
    expect(ListPagesQuerySchema.parse({ status: 'published' }).status).toBe('published');
    expect(ListPagesQuerySchema.safeParse({ status: 'live' }).success).toBe(false);
  });
});

describe('record shapes round-trip', () => {
  const version = {
    id: 'ver_1',
    pageId: 'page_1',
    versionNo: 1,
    title: 'Privacy Policy',
    body: 'We respect your privacy.',
    effectiveAt: null,
    isMaterialChange: false,
    materialChangeNote: null,
    createdBy: 'user_1',
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
  };
  const page = {
    id: 'page_1',
    slug: 'privacy',
    status: 'draft' as const,
    title: 'Privacy Policy',
    currentVersionId: null,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
  };

  it('PageVersionRecordSchema accepts a null + a stamped effectiveAt', () => {
    expect(PageVersionRecordSchema.parse(version).effectiveAt).toBeNull();
    expect(
      PageVersionRecordSchema.parse({ ...version, effectiveAt: '2026-07-01T00:00:00.000Z' })
        .effectiveAt,
    ).toBe('2026-07-01T00:00:00.000Z');
  });

  it('PageRecordSchema + PageDetailSchema round-trip', () => {
    expect(PageRecordSchema.parse(page).slug).toBe('privacy');
    const detail = PageDetailSchema.parse({ ...page, versions: [version] });
    expect(detail.versions).toHaveLength(1);
  });

  it('PageDetailSchema rejects an unknown field', () => {
    expect(PageDetailSchema.safeParse({ ...page, versions: [], extra: 1 }).success).toBe(false);
  });
});
