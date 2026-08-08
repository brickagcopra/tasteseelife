import { describe, expect, it } from 'vitest';

import {
  CONTENT_LEGAL_EVENT_NOTE_MAX_LENGTH,
  CONTENT_PAGE_MATERIAL_CHANGED,
  ContentPageMaterialChangedSchema,
  eventRegistry,
  getEventSchema,
} from '../events';

/**
 * Contract tests for the `content.page.material_changed` event (TS-285).
 *
 * Pins the wire shape (`.strict()`), the envelope, the bounded fields, and the
 * registry wiring — so a producer edit is a TS/parse error and the
 * `service-notification` consumer (TS-285-followup-1) can map the payload 1:1.
 */
describe('content.page.material_changed registry wiring', () => {
  it('is registered under its dotted constant', () => {
    expect(eventRegistry[CONTENT_PAGE_MATERIAL_CHANGED]).toBe(ContentPageMaterialChangedSchema);
    expect(getEventSchema(CONTENT_PAGE_MATERIAL_CHANGED)).toBe(ContentPageMaterialChangedSchema);
  });

  it('uses a past-tense dotted name', () => {
    expect(CONTENT_PAGE_MATERIAL_CHANGED).toBe('content.page.material_changed');
    expect(CONTENT_PAGE_MATERIAL_CHANGED).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});

describe('ContentPageMaterialChanged event', () => {
  const valid = {
    eventId: 'evt_1',
    occurredAt: '2026-06-30T12:00:00.000Z',
    pageId: 'page_1',
    pageVersionId: 'ver_3',
    slug: 'privacy',
    versionNo: 3,
    effectiveAt: '2026-07-01T00:00:00.000Z',
    materialChangeNote: 'New data-retention window.',
  };

  it('accepts a valid payload', () => {
    expect(ContentPageMaterialChangedSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a null note', () => {
    expect(
      ContentPageMaterialChangedSchema.safeParse({ ...valid, materialChangeNote: null }).success,
    ).toBe(true);
  });

  it('rejects an unknown field (.strict)', () => {
    expect(ContentPageMaterialChangedSchema.safeParse({ ...valid, extra: 'nope' }).success).toBe(
      false,
    );
  });

  it('rejects a non-positive versionNo', () => {
    expect(ContentPageMaterialChangedSchema.safeParse({ ...valid, versionNo: 0 }).success).toBe(
      false,
    );
  });

  it('rejects a note over the byte cap', () => {
    expect(
      ContentPageMaterialChangedSchema.safeParse({
        ...valid,
        materialChangeNote: 'x'.repeat(CONTENT_LEGAL_EVENT_NOTE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects a non-datetime effectiveAt', () => {
    expect(
      ContentPageMaterialChangedSchema.safeParse({ ...valid, effectiveAt: 'yesterday' }).success,
    ).toBe(false);
  });
});
