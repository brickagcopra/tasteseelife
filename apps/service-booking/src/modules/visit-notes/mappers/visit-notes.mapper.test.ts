import { describe, expect, it } from 'vitest';

import type { VisitNoteRecord } from '../services/visit-notes.service';
import { toVisitNotesResponse } from './visit-notes.mapper';

describe('toVisitNotesResponse', () => {
  const row: VisitNoteRecord = {
    id: 'vn_abc',
    bookingId: 'bkg_abc',
    mood: 'bright',
    appetite: 'hearty',
    hydration: 'good',
    socialEngagement: 'engaged',
    freeform: 'visit went well',
    photoKeys: ['media_one', 'media_two'],
    recordedByUserId: 'usr_provider_1',
    recordedAt: new Date('2026-05-14T18:30:00.000Z'),
    createdAt: new Date('2026-05-14T18:30:00.000Z'),
    updatedAt: new Date('2026-05-14T18:35:00.000Z'),
  };

  it('converts every field to the response shape', () => {
    const dto = toVisitNotesResponse(row);
    expect(dto).toEqual({
      bookingId: 'bkg_abc',
      mood: 'bright',
      appetite: 'hearty',
      hydration: 'good',
      socialEngagement: 'engaged',
      freeform: 'visit went well',
      photoKeys: ['media_one', 'media_two'],
      recordedByUserId: 'usr_provider_1',
      recordedAt: '2026-05-14T18:30:00.000Z',
      updatedAt: '2026-05-14T18:35:00.000Z',
    });
  });

  it('preserves null observation fields', () => {
    const dto = toVisitNotesResponse({
      ...row,
      mood: null,
      appetite: null,
      hydration: null,
      socialEngagement: null,
      freeform: null,
      photoKeys: [],
    });
    expect(dto.mood).toBeNull();
    expect(dto.appetite).toBeNull();
    expect(dto.hydration).toBeNull();
    expect(dto.socialEngagement).toBeNull();
    expect(dto.freeform).toBeNull();
    expect(dto.photoKeys).toEqual([]);
  });

  it('defensively copies the photoKeys array', () => {
    const dto = toVisitNotesResponse(row);
    expect(dto.photoKeys).toEqual(['media_one', 'media_two']);
    // Mutating the DTO array must not affect the source row.
    dto.photoKeys.push('media_three' as never);
    expect(row.photoKeys).toEqual(['media_one', 'media_two']);
  });

  it('preserves ISO 8601 round-trip for timestamps', () => {
    const dto = toVisitNotesResponse(row);
    expect(new Date(dto.recordedAt).toISOString()).toBe('2026-05-14T18:30:00.000Z');
    expect(new Date(dto.updatedAt).toISOString()).toBe('2026-05-14T18:35:00.000Z');
  });
});
