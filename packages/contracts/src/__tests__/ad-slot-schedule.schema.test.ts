import { describe, expect, it } from 'vitest';

import {
  AD_SLOT_SCHEDULE_PRIORITY_MAX,
  AD_SLOT_SCHEDULE_STATUS_TRANSITIONS,
  AD_SLOT_SCHEDULES_LIST_LIMIT_DEFAULT,
  AdPlacementRecordSchema,
  AdSlotScheduleRecordSchema,
  canTransitionAdSlotSchedule,
  CreateAdSlotScheduleRequestSchema,
  isAdSlotScheduleTerminal,
  ListAdSlotSchedulesQuerySchema,
  UpdateAdSlotScheduleRequestSchema,
  type AdSlotScheduleStatus,
} from '../index';

describe('AdPlacementRecordSchema', () => {
  it('parses a placement record', () => {
    const parsed = AdPlacementRecordSchema.parse({
      id: 'plc_1',
      slotCode: 'search_top_tile',
      supportedCreativeKinds: ['sponsored_listing'],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    expect(parsed.slotCode).toBe('search_top_tile');
    expect(parsed.supportedCreativeKinds).toEqual(['sponsored_listing']);
  });

  it('rejects an unknown creative kind', () => {
    expect(() =>
      AdPlacementRecordSchema.parse({
        id: 'plc_1',
        slotCode: 'home_banner',
        supportedCreativeKinds: ['billboard'],
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects an unknown key (strict)', () => {
    expect(() =>
      AdPlacementRecordSchema.parse({
        id: 'plc_1',
        slotCode: 'home_banner',
        supportedCreativeKinds: ['banner'],
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
        rogue: true,
      }),
    ).toThrow();
  });
});

describe('AdSlotScheduleRecordSchema', () => {
  it('parses a schedule record with a null endAt', () => {
    const parsed = AdSlotScheduleRecordSchema.parse({
      id: 'sch_1',
      placementId: 'plc_1',
      campaignId: 'camp_1',
      status: 'active',
      priority: 10,
      startAt: '2026-06-15T00:00:00.000Z',
      endAt: null,
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    expect(parsed.endAt).toBeNull();
    expect(parsed.priority).toBe(10);
  });
});

describe('CreateAdSlotScheduleRequestSchema', () => {
  const base = {
    placementId: 'plc_1',
    campaignId: 'camp_1',
    startAt: '2026-06-15T00:00:00.000Z',
  };

  it('applies priority + status defaults', () => {
    const parsed = CreateAdSlotScheduleRequestSchema.parse(base);
    expect(parsed.priority).toBe(0);
    expect(parsed.status).toBe('scheduled');
    expect(parsed.endAt).toBeUndefined();
  });

  it('accepts an explicit active create with a window', () => {
    const parsed = CreateAdSlotScheduleRequestSchema.parse({
      ...base,
      endAt: '2026-06-16T00:00:00.000Z',
      priority: 5,
      status: 'active',
    });
    expect(parsed.status).toBe('active');
    expect(parsed.endAt).toBe('2026-06-16T00:00:00.000Z');
  });

  it('rejects endAt <= startAt', () => {
    expect(() =>
      CreateAdSlotScheduleRequestSchema.parse({ ...base, endAt: base.startAt }),
    ).toThrow();
  });

  it('rejects a non-initial status (paused)', () => {
    expect(() => CreateAdSlotScheduleRequestSchema.parse({ ...base, status: 'paused' })).toThrow();
  });

  it('rejects a priority over the cap', () => {
    expect(() =>
      CreateAdSlotScheduleRequestSchema.parse({
        ...base,
        priority: AD_SLOT_SCHEDULE_PRIORITY_MAX + 1,
      }),
    ).toThrow();
  });
});

describe('UpdateAdSlotScheduleRequestSchema', () => {
  it('accepts a null endAt to clear the window', () => {
    const parsed = UpdateAdSlotScheduleRequestSchema.parse({ endAt: null });
    expect(parsed.endAt).toBeNull();
  });

  it('rejects an empty patch', () => {
    expect(() => UpdateAdSlotScheduleRequestSchema.parse({})).toThrow();
  });

  it('rejects editing placementId / campaignId', () => {
    expect(() => UpdateAdSlotScheduleRequestSchema.parse({ placementId: 'plc_2' })).toThrow();
    expect(() => UpdateAdSlotScheduleRequestSchema.parse({ campaignId: 'camp_2' })).toThrow();
  });
});

describe('ListAdSlotSchedulesQuerySchema', () => {
  it('defaults the limit and accepts filters', () => {
    const parsed = ListAdSlotSchedulesQuerySchema.parse({ placementId: 'plc_1', status: 'active' });
    expect(parsed.limit).toBe(AD_SLOT_SCHEDULES_LIST_LIMIT_DEFAULT);
    expect(parsed.placementId).toBe('plc_1');
  });

  it('coerces a string limit', () => {
    const parsed = ListAdSlotSchedulesQuerySchema.parse({ limit: '25' });
    expect(parsed.limit).toBe(25);
  });
});

describe('slot-schedule status transitions', () => {
  it('allows scheduled → active and active → completed', () => {
    expect(canTransitionAdSlotSchedule('scheduled', 'active')).toBe(true);
    expect(canTransitionAdSlotSchedule('active', 'completed')).toBe(true);
    expect(canTransitionAdSlotSchedule('paused', 'active')).toBe(true);
  });

  it('forbids scheduled → completed and any move off archived', () => {
    expect(canTransitionAdSlotSchedule('scheduled', 'completed')).toBe(false);
    expect(canTransitionAdSlotSchedule('archived', 'active')).toBe(false);
  });

  it('marks archived terminal and others non-terminal', () => {
    expect(isAdSlotScheduleTerminal('archived')).toBe(true);
    const live: AdSlotScheduleStatus[] = ['scheduled', 'active', 'paused', 'completed'];
    for (const status of live) expect(isAdSlotScheduleTerminal(status)).toBe(false);
  });

  it('every transition target is itself a known status', () => {
    const known = Object.keys(AD_SLOT_SCHEDULE_STATUS_TRANSITIONS) as AdSlotScheduleStatus[];
    for (const [, targets] of Object.entries(AD_SLOT_SCHEDULE_STATUS_TRANSITIONS)) {
      for (const target of targets) expect(known).toContain(target);
    }
  });
});
