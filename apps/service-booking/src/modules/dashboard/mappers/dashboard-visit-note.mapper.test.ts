import { describe, expect, it } from 'vitest';

import {
  toDashboardVisitNoteSummary,
  type DashboardVisitNoteRow,
} from './dashboard-visit-note.mapper';

function makeRow(overrides: Partial<DashboardVisitNoteRow> = {}): DashboardVisitNoteRow {
  return {
    mood: 'bright',
    appetite: 'hearty',
    hydration: 'good',
    socialEngagement: 'engaged',
    freeform: 'Shared a memory meal and laughed a lot.',
    photoKeys: ['key_a', 'key_b'],
    recordedAt: new Date('2026-05-18T19:00:00.000Z'),
    ...overrides,
  };
}

describe('toDashboardVisitNoteSummary', () => {
  it('passes the wellness scales + freeform through verbatim', () => {
    const summary = toDashboardVisitNoteSummary(makeRow());
    expect(summary.mood).toBe('bright');
    expect(summary.appetite).toBe('hearty');
    expect(summary.hydration).toBe('good');
    expect(summary.socialEngagement).toBe('engaged');
    expect(summary.freeform).toBe('Shared a memory meal and laughed a lot.');
  });

  it('collapses photoKeys to a photoCount and never exposes the keys', () => {
    const summary = toDashboardVisitNoteSummary(makeRow({ photoKeys: ['a', 'b', 'c'] }));
    expect(summary.photoCount).toBe(3);
    expect(summary as Record<string, unknown>).not.toHaveProperty('photoKeys');
  });

  it('reports photoCount=0 for an empty photo array', () => {
    const summary = toDashboardVisitNoteSummary(makeRow({ photoKeys: [] }));
    expect(summary.photoCount).toBe(0);
  });

  it('serialises recordedAt as an ISO 8601 string', () => {
    const summary = toDashboardVisitNoteSummary(makeRow());
    expect(summary.recordedAt).toBe('2026-05-18T19:00:00.000Z');
  });

  it('preserves null scales and null freeform', () => {
    const summary = toDashboardVisitNoteSummary(
      makeRow({
        mood: null,
        appetite: null,
        hydration: null,
        socialEngagement: null,
        freeform: null,
      }),
    );
    expect(summary.mood).toBeNull();
    expect(summary.freeform).toBeNull();
    expect(summary.photoCount).toBe(2);
  });
});
