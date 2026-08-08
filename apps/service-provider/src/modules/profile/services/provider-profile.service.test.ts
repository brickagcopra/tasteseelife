import type { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  ProviderProfileService,
  type ProviderProfileTagRow,
  type ProviderRow,
} from './provider-profile.service';

/**
 * Unit tests for `ProviderProfileService.updateProfile` (TS-200).
 *
 * Fakes:
 *   - `FakePrisma` — in-memory store implementing the narrow surface
 *     the service consumes (`provider.findUnique` + `.update`,
 *     `providerProfileTag.findMany` + `.deleteMany` + `.createMany`,
 *     and a `$transaction` callback that runs against the same
 *     delegates). No transactional rollback semantics — the
 *     integration test against real Postgres carries the atomic
 *     guarantee.
 *   - `FakeOutbox` — records every `append` call so tests assert
 *     event-emission shape. Override path injects a
 *     `validation_failed` to exercise the typed-failure surface.
 */

interface FakeOutboxAppendCall {
  readonly eventName: string;
  readonly eventId: string | undefined;
  readonly payload: unknown;
}
interface FakeOutbox {
  readonly calls: FakeOutboxAppendCall[];
  readonly append: ReturnType<typeof vi.fn>;
  setNextValidationFailure(reason: string): void;
}
function buildFakeOutbox(): FakeOutbox {
  const calls: FakeOutboxAppendCall[] = [];
  let nextFailure: string | null = null;
  const append = vi.fn(
    async (
      _tx: unknown,
      args: { eventName: string; eventId?: string; payload: unknown },
    ): Promise<
      | { kind: 'appended'; eventId: string; eventName: string; occurredAt: Date }
      | {
          kind: 'validation_failed';
          eventName: string;
          issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
        }
    > => {
      calls.push({
        eventName: args.eventName,
        eventId: args.eventId,
        payload: args.payload,
      });
      if (nextFailure !== null) {
        const failure = nextFailure;
        nextFailure = null;
        return {
          kind: 'validation_failed',
          eventName: args.eventName,
          issues: [{ path: [], message: failure }],
        };
      }
      return {
        kind: 'appended',
        eventId: args.eventId ?? 'evt_fake',
        eventName: args.eventName,
        occurredAt: new Date('2026-05-20T12:00:00.000Z'),
      };
    },
  );
  return {
    calls,
    append,
    setNextValidationFailure(reason) {
      nextFailure = reason;
    },
  };
}
function asOutboxService(fake: FakeOutbox): OutboxService {
  return { append: fake.append } as unknown as OutboxService;
}

class FakePrisma {
  public providers: ProviderRow[] = [];
  public tags: ProviderProfileTagRow[] = [];

  provider = {
    findUnique: vi.fn(async (args: { where: { id: string } }): Promise<ProviderRow | null> => {
      return this.providers.find((p) => p.id === args.where.id) ?? null;
    }),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: { bio: string | null; dementiaSensitive: boolean };
      }): Promise<ProviderRow> => {
        const idx = this.providers.findIndex((p) => p.id === args.where.id);
        if (idx === -1) throw new Error(`provider ${args.where.id} not found in fake`);
        const target = this.providers[idx];
        if (target === undefined) throw new Error('row missing');
        const next: ProviderRow = {
          ...target,
          bio: args.data.bio,
          dementiaSensitive: args.data.dementiaSensitive,
          updatedAt: new Date('2026-05-20T12:00:01.000Z'),
        };
        this.providers[idx] = next;
        return next;
      },
    ),
  };

  providerProfileTag = {
    findMany: vi.fn(
      async (args: {
        where: { providerId: string };
        select: { kind: true; tag: true };
      }): Promise<ReadonlyArray<{ kind: ProviderProfileTagRow['kind']; tag: string }>> => {
        return this.tags
          .filter((t) => t.providerId === args.where.providerId)
          .map((t) => ({ kind: t.kind, tag: t.tag }));
      },
    ),
    deleteMany: vi.fn(
      async (args: {
        where: { providerId: string; kind: { in: ProviderProfileTagRow['kind'][] } };
      }): Promise<{ count: number }> => {
        const before = this.tags.length;
        this.tags = this.tags.filter(
          (t) => !(t.providerId === args.where.providerId && args.where.kind.in.includes(t.kind)),
        );
        return { count: before - this.tags.length };
      },
    ),
    createMany: vi.fn(
      async (args: { data: ProviderProfileTagRow[] }): Promise<{ count: number }> => {
        for (const row of args.data) {
          this.tags.push({ ...row });
        }
        return { count: args.data.length };
      },
    ),
  };

  $transaction = vi.fn(
    async <T>(
      fn: (tx: {
        provider: FakePrisma['provider'];
        providerProfileTag: FakePrisma['providerProfileTag'];
      }) => Promise<T>,
    ): Promise<T> => {
      return fn({
        provider: this.provider,
        providerProfileTag: this.providerProfileTag,
      });
    },
  );
}

function buildPrisma(): FakePrisma {
  return new FakePrisma();
}

const NOW = new Date('2026-05-20T12:00:00.000Z');

function aProviderRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'prov_1',
    userId: 'user_self',
    status: 'active',
    tier: 'certified',
    displayName: 'Chef Sam',
    headline: 'Comfort food specialist',
    bio: 'Cooking for families since 2010.',
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    dementiaSensitive: false,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

describe('ProviderProfileService.updateProfile', () => {
  it('replaces bio + tag sets + dementia flag and emits the outbox event', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.tags = [
      { providerId: 'prov_1', kind: 'language', tag: 'en' },
      { providerId: 'prov_1', kind: 'cuisine', tag: 'french' },
    ];
    const outbox = buildFakeOutbox();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      bio: 'Updated bio.',
      languages: ['en', 'es'],
      cuisines: ['italian'],
      dietaryExpertise: ['low-sodium'],
      dementiaSensitive: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.row.bio).toBe('Updated bio.');
    expect(result.value.row.dementiaSensitive).toBe(true);
    expect(result.value.languages).toEqual(['en', 'es']);
    expect(result.value.cuisines).toEqual(['italian']);
    expect(result.value.dietaryExpertise).toEqual(['low-sodium']);

    expect(outbox.calls).toHaveLength(1);
    const call = outbox.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.eventName).toBe('provider.profile_updated');
    const payload = call.payload as {
      providerId: string;
      changedKinds: readonly string[];
      actorUserId: string;
    };
    expect(payload.providerId).toBe('prov_1');
    expect(payload.actorUserId).toBe('user_self');
    // bio, dementia_sensitive, language, cuisine, dietary_expertise all changed.
    expect([...payload.changedKinds].sort()).toEqual(
      ['bio', 'cuisine', 'dementia_sensitive', 'dietary_expertise', 'language'].sort(),
    );
  });

  it('emits changedKinds with only the kinds that actually differ', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ bio: 'unchanged', dementiaSensitive: false })];
    prisma.tags = [
      { providerId: 'prov_1', kind: 'language', tag: 'en' },
      { providerId: 'prov_1', kind: 'cuisine', tag: 'italian' },
      { providerId: 'prov_1', kind: 'dietary_expertise', tag: 'kosher' },
    ];
    const outbox = buildFakeOutbox();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    // Only `cuisines` differs (`italian` -> `italian` + `french`).
    const result = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      bio: 'unchanged',
      languages: ['en'],
      cuisines: ['italian', 'french'],
      dietaryExpertise: ['kosher'],
      dementiaSensitive: false,
    });

    expect(result.ok).toBe(true);
    expect(outbox.calls).toHaveLength(1);
    const call = outbox.calls[0];
    if (call === undefined) throw new Error('missing call');
    const payload = call.payload as { changedKinds: readonly string[] };
    expect(payload.changedKinds).toEqual(['cuisine']);
  });

  it('short-circuits before the transaction when nothing changed (TS-200-followup-7)', async () => {
    // The pre-transaction `provider.findUnique` + tag `findMany` both
    // fire (we need them to compute `changedKinds`), but `$transaction`
    // and every write delegate stay untouched and `updated_at` is
    // preserved as a reliable freshness signal.
    const persistedUpdatedAt = new Date('2026-04-01T09:00:00.000Z');
    const prisma = buildPrisma();
    prisma.providers = [
      aProviderRow({
        bio: 'same',
        dementiaSensitive: true,
        updatedAt: persistedUpdatedAt,
      }),
    ];
    prisma.tags = [
      { providerId: 'prov_1', kind: 'language', tag: 'en' },
      { providerId: 'prov_1', kind: 'cuisine', tag: 'italian' },
    ];
    const outbox = buildFakeOutbox();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      bio: 'same',
      languages: ['en'],
      cuisines: ['italian'],
      dietaryExpertise: [],
      dementiaSensitive: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // updated_at preserved — the whole point of the short-circuit.
    expect(result.value.row.updatedAt).toEqual(persistedUpdatedAt);
    expect(result.value.languages).toEqual(['en']);
    expect(result.value.cuisines).toEqual(['italian']);
    expect(result.value.dietaryExpertise).toEqual([]);

    // No transactional writes. The pre-read findUnique + tag findMany
    // are expected (they feed the diff); everything else stays at 0.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.provider.update).not.toHaveBeenCalled();
    expect(prisma.providerProfileTag.deleteMany).not.toHaveBeenCalled();
    expect(prisma.providerProfileTag.createMany).not.toHaveBeenCalled();
    expect(outbox.calls).toHaveLength(0);
  });

  it('also short-circuits when the only difference is unsorted / duplicated tag input', async () => {
    // The contract layer rejects intra-kind duplicates at the
    // boundary, but the service-layer `normalizeTags` sort + dedupe
    // means an input like ['en', 'en', 'es'] still hashes identically
    // to a persisted ['en', 'es'] set — and triggers the short-circuit
    // rather than a transactional re-write.
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ bio: null, dementiaSensitive: false })];
    prisma.tags = [
      { providerId: 'prov_1', kind: 'language', tag: 'es' },
      { providerId: 'prov_1', kind: 'language', tag: 'en' },
    ];
    const outbox = buildFakeOutbox();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      bio: null,
      languages: ['en', 'en', 'es'],
      cuisines: [],
      dietaryExpertise: [],
      dementiaSensitive: false,
    });

    expect(result.ok).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.provider.update).not.toHaveBeenCalled();
    expect(outbox.calls).toHaveLength(0);
  });

  it('clears the bio when `null` is supplied', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ bio: 'existing' })];
    const outbox = buildFakeOutbox();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      bio: null,
      languages: [],
      cuisines: [],
      dietaryExpertise: [],
      dementiaSensitive: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.row.bio).toBeNull();
    expect(outbox.calls).toHaveLength(1);
  });

  it('clears all tags atomically when arrays are empty', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.tags = [
      { providerId: 'prov_1', kind: 'language', tag: 'en' },
      { providerId: 'prov_1', kind: 'cuisine', tag: 'french' },
    ];
    const outbox = buildFakeOutbox();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      bio: 'Cooking for families since 2010.',
      languages: [],
      cuisines: [],
      dietaryExpertise: [],
      dementiaSensitive: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.languages).toEqual([]);
    expect(result.value.cuisines).toEqual([]);
    expect(result.value.dietaryExpertise).toEqual([]);
    expect(prisma.tags).toEqual([]);
  });

  it('returns 404 when the provider row does not exist', async () => {
    const prisma = buildPrisma();
    const outbox = buildFakeOutbox();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateProfile({
      providerId: 'prov_missing',
      actorUserId: 'user_self',
      bio: null,
      languages: [],
      cuisines: [],
      dietaryExpertise: [],
      dementiaSensitive: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns 403 when the authenticated user does not own the provider', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ userId: 'user_owner' })];
    const outbox = buildFakeOutbox();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: 'user_attacker',
      bio: 'malicious',
      languages: [],
      cuisines: [],
      dietaryExpertise: [],
      dementiaSensitive: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('forbidden');
    // Nothing was written.
    expect(prisma.providers[0]?.bio).toBe('Cooking for families since 2010.');
    expect(outbox.calls).toHaveLength(0);
  });

  it('rejects empty providerId / actorUserId at the guard boundary', async () => {
    const prisma = buildPrisma();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );

    const r1 = await svc.updateProfile({
      providerId: '',
      actorUserId: 'user_self',
      bio: null,
      languages: [],
      cuisines: [],
      dietaryExpertise: [],
      dementiaSensitive: false,
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.reason).toBe('invalid_request');

    const r2 = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: '',
      bio: null,
      languages: [],
      cuisines: [],
      dietaryExpertise: [],
      dementiaSensitive: false,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.reason).toBe('invalid_request');
  });

  it('surfaces outbox validation failure as a typed error', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    const outbox = buildFakeOutbox();
    outbox.setNextValidationFailure('synthetic failure for test');
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      bio: 'Bio change to trigger emission.',
      languages: [],
      cuisines: [],
      dietaryExpertise: [],
      dementiaSensitive: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    if (result.error.reason !== 'outbox_validation_failed') return;
    expect(result.error.eventName).toBe('provider.profile_updated');
  });

  it('de-dupes a tag array passed by a non-conforming controller bypass', async () => {
    // The contract layer rejects duplicates at the boundary; this
    // covers the defence-in-depth case where the service is invoked
    // directly (e.g. from an in-cluster admin tool).
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    const outbox = buildFakeOutbox();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateProfile({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      bio: 'Cooking for families since 2010.',
      languages: ['en', 'en', 'es'],
      cuisines: [],
      dietaryExpertise: [],
      dementiaSensitive: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.languages).toEqual(['en', 'es']);
  });

  // ─── If-Match optimistic concurrency (TS-200-followup-5) ─────────
  describe('optimistic concurrency via ifMatchUpdatedAt', () => {
    it("writes through when ifMatchUpdatedAt matches the row's updated_at", async () => {
      const persistedUpdatedAt = new Date('2026-04-01T09:00:00.000Z');
      const prisma = buildPrisma();
      prisma.providers = [aProviderRow({ updatedAt: persistedUpdatedAt })];
      const outbox = buildFakeOutbox();
      const svc = new ProviderProfileService(
        prisma as unknown as PrismaService,
        asOutboxService(outbox),
      );

      const result = await svc.updateProfile({
        providerId: 'prov_1',
        actorUserId: 'user_self',
        bio: 'Genuinely fresh edit.',
        languages: ['en'],
        cuisines: [],
        dietaryExpertise: [],
        dementiaSensitive: false,
        ifMatchUpdatedAt: persistedUpdatedAt,
      });

      expect(result.ok).toBe(true);
      expect(prisma.provider.update).toHaveBeenCalled();
      expect(outbox.calls).toHaveLength(1);
    });

    it('refuses with precondition_failed when ifMatchUpdatedAt is stale', async () => {
      const persistedUpdatedAt = new Date('2026-04-01T10:00:00.000Z');
      const clientStale = new Date('2026-04-01T09:00:00.000Z');
      const prisma = buildPrisma();
      prisma.providers = [aProviderRow({ updatedAt: persistedUpdatedAt })];
      const outbox = buildFakeOutbox();
      const svc = new ProviderProfileService(
        prisma as unknown as PrismaService,
        asOutboxService(outbox),
      );

      const result = await svc.updateProfile({
        providerId: 'prov_1',
        actorUserId: 'user_self',
        bio: 'Should not land.',
        languages: ['fr'],
        cuisines: [],
        dietaryExpertise: [],
        dementiaSensitive: true,
        ifMatchUpdatedAt: clientStale,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('precondition_failed');
      if (result.error.reason !== 'precondition_failed') return;
      expect(result.error.providerId).toBe('prov_1');
      // The server's truth surfaces in the failure so the caller can
      // re-render to the latest state.
      expect(result.error.currentUpdatedAt).toEqual(persistedUpdatedAt);
      // No transactional writes when the precondition fails.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.provider.update).not.toHaveBeenCalled();
      expect(outbox.calls).toHaveLength(0);
    });

    it('skips the precondition check when ifMatchUpdatedAt is undefined (backward-compat)', async () => {
      // Pre-TS-200-followup-5 clients send no `If-Match`; the service
      // must still accept the write.
      const prisma = buildPrisma();
      prisma.providers = [aProviderRow()];
      const outbox = buildFakeOutbox();
      const svc = new ProviderProfileService(
        prisma as unknown as PrismaService,
        asOutboxService(outbox),
      );

      const result = await svc.updateProfile({
        providerId: 'prov_1',
        actorUserId: 'user_self',
        bio: 'A change so changedKinds is non-empty.',
        languages: ['en'],
        cuisines: [],
        dietaryExpertise: [],
        dementiaSensitive: false,
        // ifMatchUpdatedAt deliberately omitted.
      });

      expect(result.ok).toBe(true);
    });

    it('precondition runs AFTER 404 (missing row still 404, not 412)', async () => {
      // Defence-in-depth ordering test — if a caller sends a stale
      // If-Match against a non-existent provider, they get the same
      // canonical 404 a non-If-Match call would.
      const prisma = buildPrisma();
      const svc = new ProviderProfileService(
        prisma as unknown as PrismaService,
        asOutboxService(buildFakeOutbox()),
      );

      const result = await svc.updateProfile({
        providerId: 'prov_missing',
        actorUserId: 'user_self',
        bio: null,
        languages: [],
        cuisines: [],
        dietaryExpertise: [],
        dementiaSensitive: false,
        ifMatchUpdatedAt: new Date('2026-04-01T09:00:00.000Z'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('not_found');
    });

    it('precondition runs AFTER 403 (non-owner still 403, not 412)', async () => {
      const prisma = buildPrisma();
      prisma.providers = [aProviderRow({ userId: 'user_owner' })];
      const svc = new ProviderProfileService(
        prisma as unknown as PrismaService,
        asOutboxService(buildFakeOutbox()),
      );

      const result = await svc.updateProfile({
        providerId: 'prov_1',
        actorUserId: 'user_attacker',
        bio: null,
        languages: [],
        cuisines: [],
        dietaryExpertise: [],
        dementiaSensitive: false,
        ifMatchUpdatedAt: new Date('2026-04-01T09:00:00.000Z'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('forbidden');
    });

    it('precondition fires BEFORE the no-op short-circuit (stale wins over no-op)', async () => {
      // A request whose body matches persisted state but whose
      // If-Match is stale must surface as 412, not as the silent
      // no-op success. The freshness mismatch is what the client
      // wants to know about — even if "their" change would have
      // collided with the persisted state, the underlying row has
      // moved out from under them.
      const persistedUpdatedAt = new Date('2026-04-01T10:00:00.000Z');
      const prisma = buildPrisma();
      prisma.providers = [
        aProviderRow({
          bio: 'same',
          dementiaSensitive: false,
          updatedAt: persistedUpdatedAt,
        }),
      ];
      prisma.tags = [{ providerId: 'prov_1', kind: 'language', tag: 'en' }];
      const outbox = buildFakeOutbox();
      const svc = new ProviderProfileService(
        prisma as unknown as PrismaService,
        asOutboxService(outbox),
      );

      const result = await svc.updateProfile({
        providerId: 'prov_1',
        actorUserId: 'user_self',
        bio: 'same',
        languages: ['en'],
        cuisines: [],
        dietaryExpertise: [],
        dementiaSensitive: false,
        ifMatchUpdatedAt: new Date('2026-04-01T09:00:00.000Z'),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('precondition_failed');
    });
  });
});

describe('ProviderProfileService.getProfile', () => {
  it('returns null for a missing provider', async () => {
    const prisma = buildPrisma();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );
    const result = await svc.getProfile('prov_missing');
    expect(result).toBeNull();
  });

  it('returns the materialised snapshot with sorted tag partitions', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.tags = [
      { providerId: 'prov_1', kind: 'language', tag: 'es' },
      { providerId: 'prov_1', kind: 'language', tag: 'en' },
      { providerId: 'prov_1', kind: 'cuisine', tag: 'italian' },
      { providerId: 'prov_other', kind: 'cuisine', tag: 'french' },
    ];
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );

    const result = await svc.getProfile('prov_1');
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.row.id).toBe('prov_1');
    // Tags are sorted; only this provider's rows surface.
    expect(result.languages).toEqual(['en', 'es']);
    expect(result.cuisines).toEqual(['italian']);
    expect(result.dietaryExpertise).toEqual([]);
  });

  it('rejects empty providerId without hitting Prisma', async () => {
    const prisma = buildPrisma();
    const svc = new ProviderProfileService(
      prisma as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );
    const result = await svc.getProfile('');
    expect(result).toBeNull();
    expect(prisma.provider.findUnique).not.toHaveBeenCalled();
  });
});
