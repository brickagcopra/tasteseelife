import type { Logger } from '@nestjs/common';
import type { UpsertVisitNotesRequest } from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { BookingStatus } from '../../lifecycle/booking-status';
import {
  VisitNotesService,
  type UpsertVisitNotesInput,
  type VisitNoteRecord,
} from './visit-notes.service';

/**
 * VisitNotesService unit suite (TS-062).
 *
 * Covers the happy path, the lifecycle gate (write rejected when
 * the booking is not in `in_progress` or `completed`), the upsert
 * semantics (first save inserts; second save updates the same row),
 * the not-found shapes, the input-validation guards, and the
 * `recordedByUserId` server-stamp.
 *
 * Uses an in-memory `FakePrisma` mirroring the pattern in
 * `bookings.service.test.ts` (the established service-booking
 * test convention).
 */

interface FakeBookingRow {
  id: string;
  status: BookingStatus;
}

interface FakeVisitNoteRow extends VisitNoteRecord {}

class FakePrisma {
  public bookings: FakeBookingRow[] = [];
  public visitNotes: FakeVisitNoteRow[] = [];
  private idCounter = 0;

  booking = {
    findUnique: vi.fn(
      async (args: {
        where: { id: string };
        select?: Record<string, boolean>;
      }): Promise<{ id: string; status?: BookingStatus } | null> => {
        const row = this.bookings.find((b) => b.id === args.where.id);
        if (row === undefined) return null;
        if (args.select?.['status']) {
          return { id: row.id, status: row.status };
        }
        return { id: row.id };
      },
    ),
  };

  bookingVisitNote = {
    upsert: vi.fn(
      async (args: {
        where: { bookingId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }): Promise<FakeVisitNoteRow> => {
        const idx = this.visitNotes.findIndex((r) => r.bookingId === args.where.bookingId);
        const recordedAt =
          (args.create['recordedAt'] as Date | undefined) ??
          (args.update['recordedAt'] as Date | undefined) ??
          new Date('2026-05-14T18:30:00.000Z');
        if (idx === -1) {
          this.idCounter += 1;
          const created: FakeVisitNoteRow = {
            id: `vn_fake_${this.idCounter}`,
            bookingId: args.where.bookingId,
            mood: (args.create['mood'] as FakeVisitNoteRow['mood']) ?? null,
            appetite: (args.create['appetite'] as FakeVisitNoteRow['appetite']) ?? null,
            hydration: (args.create['hydration'] as FakeVisitNoteRow['hydration']) ?? null,
            socialEngagement:
              (args.create['socialEngagement'] as FakeVisitNoteRow['socialEngagement']) ?? null,
            freeform: (args.create['freeform'] as string | undefined) ?? null,
            photoKeys: (args.create['photoKeys'] as readonly string[] | undefined) ?? [],
            recordedByUserId: args.create['recordedByUserId'] as string,
            recordedAt,
            createdAt: recordedAt,
            updatedAt: recordedAt,
          };
          this.visitNotes.push(created);
          return created;
        }
        const next: FakeVisitNoteRow = {
          ...this.visitNotes[idx]!,
          mood:
            'mood' in args.update
              ? ((args.update['mood'] as FakeVisitNoteRow['mood']) ?? null)
              : this.visitNotes[idx]!.mood,
          appetite:
            'appetite' in args.update
              ? ((args.update['appetite'] as FakeVisitNoteRow['appetite']) ?? null)
              : this.visitNotes[idx]!.appetite,
          hydration:
            'hydration' in args.update
              ? ((args.update['hydration'] as FakeVisitNoteRow['hydration']) ?? null)
              : this.visitNotes[idx]!.hydration,
          socialEngagement:
            'socialEngagement' in args.update
              ? ((args.update['socialEngagement'] as FakeVisitNoteRow['socialEngagement']) ?? null)
              : this.visitNotes[idx]!.socialEngagement,
          freeform:
            'freeform' in args.update
              ? ((args.update['freeform'] as string | undefined) ?? null)
              : this.visitNotes[idx]!.freeform,
          photoKeys:
            (args.update['photoKeys'] as readonly string[] | undefined) ??
            this.visitNotes[idx]!.photoKeys,
          recordedByUserId:
            (args.update['recordedByUserId'] as string | undefined) ??
            this.visitNotes[idx]!.recordedByUserId,
          recordedAt,
          updatedAt: recordedAt,
        };
        this.visitNotes[idx] = next;
        return next;
      },
    ),
    findUnique: vi.fn(
      async (args: { where: { bookingId: string } }): Promise<FakeVisitNoteRow | null> => {
        return this.visitNotes.find((r) => r.bookingId === args.where.bookingId) ?? null;
      },
    ),
  };
}

function buildSvc(): { service: VisitNotesService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const service = new VisitNotesService(prisma as unknown as PrismaService);
  const log = (service as unknown as { logger: Logger }).logger;
  log.log = vi.fn();
  log.debug = vi.fn();
  log.error = vi.fn();
  log.warn = vi.fn();
  return { service, prisma };
}

const VALID_REQUEST: UpsertVisitNotesRequest = {
  mood: 'bright',
  appetite: 'hearty',
  hydration: 'good',
  socialEngagement: 'engaged',
  freeform: 'Mom enjoyed the visit.',
  photoKeys: ['media_abc'],
};

describe('VisitNotesService.upsert', () => {
  let svc: ReturnType<typeof buildSvc>;
  beforeEach(() => {
    svc = buildSvc();
  });

  it('rejects when actorUserId is empty', async () => {
    const result = await svc.service.upsert({
      actorUserId: '',
      bookingId: 'bkg_1',
      request: VALID_REQUEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_request');
    }
  });

  it('rejects when bookingId is empty', async () => {
    const result = await svc.service.upsert({
      actorUserId: 'usr_provider',
      bookingId: '',
      request: VALID_REQUEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_request');
    }
  });

  it('returns booking_not_found when the booking does not exist', async () => {
    const result = await svc.service.upsert({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_ghost',
      request: VALID_REQUEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('booking_not_found');
    }
  });

  it.each([['pending'], ['confirmed'], ['canceled']] as const)(
    'rejects with invalid_lifecycle_state when the booking is %s',
    async (status) => {
      svc.prisma.bookings.push({ id: 'bkg_1', status });
      const result = await svc.service.upsert({
        actorUserId: 'usr_provider',
        bookingId: 'bkg_1',
        request: VALID_REQUEST,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe('invalid_lifecycle_state');
        if (result.error.reason === 'invalid_lifecycle_state') {
          expect(result.error.bookingStatus).toBe(status);
          expect(result.error.allowed).toEqual(['in_progress', 'completed']);
        }
      }
    },
  );

  it.each([['in_progress'], ['completed']] as const)(
    'accepts an upsert when the booking is %s',
    async (status) => {
      svc.prisma.bookings.push({ id: 'bkg_1', status });
      const result = await svc.service.upsert({
        actorUserId: 'usr_provider',
        bookingId: 'bkg_1',
        request: VALID_REQUEST,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bookingId).toBe('bkg_1');
        expect(result.value.mood).toBe('bright');
        expect(result.value.appetite).toBe('hearty');
        expect(result.value.recordedByUserId).toBe('usr_provider');
        expect(result.value.photoKeys).toEqual(['media_abc']);
      }
    },
  );

  it('inserts the first time and updates on second upsert', async () => {
    svc.prisma.bookings.push({ id: 'bkg_1', status: 'in_progress' });

    const first = await svc.service.upsert({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_1',
      request: { mood: 'neutral', photoKeys: [] },
    });
    expect(first.ok).toBe(true);
    expect(svc.prisma.visitNotes).toHaveLength(1);

    const second = await svc.service.upsert({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_1',
      request: { mood: 'joyful', appetite: 'robust', photoKeys: [] },
    });
    expect(second.ok).toBe(true);
    expect(svc.prisma.visitNotes).toHaveLength(1);
    if (second.ok) {
      expect(second.value.mood).toBe('joyful');
      expect(second.value.appetite).toBe('robust');
    }
  });

  it('stamps the actorUserId as recordedByUserId server-side', async () => {
    svc.prisma.bookings.push({ id: 'bkg_1', status: 'in_progress' });
    const result = await svc.service.upsert({
      actorUserId: 'usr_provider_real',
      bookingId: 'bkg_1',
      request: VALID_REQUEST,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recordedByUserId).toBe('usr_provider_real');
    }
  });

  it('echoes back nullable observation fields when set to null', async () => {
    svc.prisma.bookings.push({ id: 'bkg_1', status: 'in_progress' });
    const result = await svc.service.upsert({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_1',
      request: {
        mood: null,
        appetite: null,
        hydration: null,
        socialEngagement: null,
        freeform: 'narrative only',
        photoKeys: [],
      } as UpsertVisitNotesRequest,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mood).toBeNull();
      expect(result.value.freeform).toBe('narrative only');
    }
  });
});

describe('VisitNotesService.getByBookingId', () => {
  let svc: ReturnType<typeof buildSvc>;
  beforeEach(() => {
    svc = buildSvc();
  });

  it('rejects when actorUserId is empty', async () => {
    const result = await svc.service.getByBookingId({ actorUserId: '', bookingId: 'bkg_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_request');
    }
  });

  it('rejects when bookingId is empty', async () => {
    const result = await svc.service.getByBookingId({ actorUserId: 'usr', bookingId: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_request');
    }
  });

  it('returns booking_not_found when the booking does not exist', async () => {
    const result = await svc.service.getByBookingId({
      actorUserId: 'usr',
      bookingId: 'bkg_ghost',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('booking_not_found');
    }
  });

  it('returns visit_notes_not_found when the booking exists but has no notes', async () => {
    svc.prisma.bookings.push({ id: 'bkg_1', status: 'in_progress' });
    const result = await svc.service.getByBookingId({
      actorUserId: 'usr',
      bookingId: 'bkg_1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('visit_notes_not_found');
    }
  });

  it('returns the row when present', async () => {
    svc.prisma.bookings.push({ id: 'bkg_1', status: 'completed' });
    await svc.service.upsert({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_1',
      request: VALID_REQUEST,
    });
    const result = await svc.service.getByBookingId({
      actorUserId: 'usr_family',
      bookingId: 'bkg_1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bookingId).toBe('bkg_1');
      expect(result.value.mood).toBe('bright');
      expect(result.value.appetite).toBe('hearty');
      expect(result.value.recordedByUserId).toBe('usr_provider');
    }
  });
});

describe('VisitNotesService boundary types', () => {
  it('expose UpsertVisitNotesInput correctly for the controller layer', () => {
    // Compile-time test: this ensures the exported input/output types
    // remain valid against the contract type without needing an actual
    // service instance. If the contract changes shape, this will fail
    // to compile.
    const _input: UpsertVisitNotesInput = {
      actorUserId: 'usr',
      bookingId: 'bkg',
      request: { mood: 'bright', photoKeys: [] } as UpsertVisitNotesRequest,
    };
    expect(_input.actorUserId).toBe('usr');
  });
});
