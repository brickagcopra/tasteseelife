import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { RecipientContactsService, type UserRecordStatus } from './recipient-contacts.service';

/**
 * Service-layer tests for `RecipientContactsService` (TS-235).
 *
 * Surface:
 *   - resolves a batch of ids to `{ userId, email, status }` contacts.
 *   - omits ids that have no matching user row (no synthesised
 *     placeholder).
 *   - projects ONLY `{ id, email, status }` from Prisma (never selects
 *     the password hash into this path).
 *   - maps every identity `UserStatus` enum value to the contract
 *     `UserStatusSchema` value.
 *   - never logs an email address.
 *
 * The controller test (`controllers/recipient-contacts.controller.test.ts`)
 * carries the HTTP-boundary coverage (shared-secret 401, 400, exempt
 * wrap); these tests pin the domain projection.
 */

interface FakeUserRow {
  id: string;
  email: string;
  status: UserRecordStatus;
  // The fake holds a password hash deliberately so a test can assert
  // the service `select` never pulls it into the contact projection.
  passwordHash: string;
}

/**
 * Minimal Prisma fake — supports only the `user.findMany` surface
 * `RecipientContactsService` actually uses, applying the `{ id: { in } }`
 * filter + honouring the `select` projection so a test can prove the
 * password hash never escapes the query. Mirrors the per-test seam
 * pattern in `visit-prep.service.test.ts`.
 */
class FakePrisma {
  public users: FakeUserRow[] = [];
  public lastFindManyArgs: {
    where: { id: { in: string[] } };
    select: Record<string, true>;
  } | null = null;

  user = {
    findMany: async (args: {
      where: { id: { in: string[] } };
      select: Record<string, true>;
    }): Promise<Array<Record<string, unknown>>> => {
      this.lastFindManyArgs = args;
      const ids = new Set(args.where.id.in);
      const matched = this.users.filter((u) => ids.has(u.id));
      // Honour the projection — only the keys the caller selected come
      // back, exactly as Prisma would behave. This is what lets the
      // "never selects the password hash" assertion be meaningful.
      return matched.map((u) => {
        const projected: Record<string, unknown> = {};
        for (const key of Object.keys(args.select)) {
          projected[key] = (u as unknown as Record<string, unknown>)[key];
        }
        return projected;
      });
    },
  };
}

function buildService(): { service: RecipientContactsService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const service = new RecipientContactsService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('RecipientContactsService.resolveBatch', () => {
  it('resolves a batch of ids to contact DTOs', async () => {
    const { service, prisma } = buildService();
    prisma.users = [
      { id: 'usr_1', email: 'a@example.com', status: 'active', passwordHash: 'hash1' },
      { id: 'usr_2', email: 'b@example.com', status: 'suspended', passwordHash: 'hash2' },
    ];

    const contacts = await service.resolveBatch(['usr_1', 'usr_2']);

    expect(contacts).toEqual([
      { userId: 'usr_1', email: 'a@example.com', status: 'active' },
      { userId: 'usr_2', email: 'b@example.com', status: 'suspended' },
    ]);
  });

  it('omits ids with no matching user row (no synthesised placeholder)', async () => {
    const { service, prisma } = buildService();
    prisma.users = [
      { id: 'usr_1', email: 'a@example.com', status: 'active', passwordHash: 'hash1' },
    ];

    const contacts = await service.resolveBatch(['usr_1', 'usr_missing']);

    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.userId).toBe('usr_1');
    expect(contacts.some((c) => c.userId === 'usr_missing')).toBe(false);
  });

  it('returns an empty array for an empty id list without hitting Prisma', async () => {
    const { service, prisma } = buildService();
    const spy = vi.spyOn(prisma.user, 'findMany');

    const contacts = await service.resolveBatch([]);

    expect(contacts).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('projects ONLY { id, email, status } from Prisma — never the password hash', async () => {
    const { service, prisma } = buildService();
    prisma.users = [
      { id: 'usr_1', email: 'a@example.com', status: 'active', passwordHash: 'secret-hash' },
    ];

    const contacts = await service.resolveBatch(['usr_1']);

    // The select must request exactly the three columns.
    expect(prisma.lastFindManyArgs?.select).toEqual({ id: true, email: true, status: true });
    // The DTO carries no password-hash field under any key.
    expect(JSON.stringify(contacts)).not.toContain('secret-hash');
    expect(contacts[0]).not.toHaveProperty('passwordHash');
  });

  it('forwards the id list to the Prisma { id: { in } } filter', async () => {
    const { service, prisma } = buildService();
    prisma.users = [];

    await service.resolveBatch(['usr_a', 'usr_b', 'usr_c']);

    expect(prisma.lastFindManyArgs?.where).toEqual({ id: { in: ['usr_a', 'usr_b', 'usr_c'] } });
  });

  it('maps every identity UserStatus enum value to the contract status', async () => {
    const { service, prisma } = buildService();
    const statuses: readonly UserRecordStatus[] = [
      'pending_verification',
      'active',
      'suspended',
      'deactivated',
    ];
    prisma.users = statuses.map((status, i) => ({
      id: `usr_${i}`,
      email: `user${i}@example.com`,
      status,
      passwordHash: `hash${i}`,
    }));

    const contacts = await service.resolveBatch(statuses.map((_, i) => `usr_${i}`));

    expect(contacts.map((c) => c.status)).toEqual([
      'pending_verification',
      'active',
      'suspended',
      'deactivated',
    ]);
  });

  it('never logs an email address (logs the count only)', async () => {
    const { service, prisma } = buildService();
    prisma.users = [
      { id: 'usr_1', email: 'leaky@example.com', status: 'active', passwordHash: 'h' },
    ];

    // Capture every Logger level so any log line the service emits is
    // recorded regardless of severity. The service logs at `debug`.
    const captured: unknown[] = [];
    const sink = (...args: unknown[]): undefined => {
      captured.push(...args);
      return undefined;
    };
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(sink);
    const debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(sink);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(sink);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(sink);

    await service.resolveBatch(['usr_1']);

    const serialised = JSON.stringify(captured);
    expect(serialised).not.toContain('leaky@example.com');
    // The count IS allowed in the log line — pin that the service
    // carries the non-PII observability shape rather than no log at all.
    expect(serialised).toContain('requestedCount');

    logSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
