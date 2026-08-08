import 'reflect-metadata';

import { BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';
import { InternalRecipientContactsRequestSchema } from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { RecipientContactsService } from '../services/recipient-contacts.service';

import { RecipientContactsController } from './recipient-contacts.controller';

/**
 * Controller-level tests for `RecipientContactsController` (TS-235).
 *
 * Surfaces:
 *   1. Shared-secret enforcement — missing header → 401, wrong value
 *      → 401, same-length-wrong-bytes → 401, correct value → service
 *      called and the parsed response returns.
 *   2. Request validation — the `ZodValidationPipe` rejects a
 *      malformed body with a 400 (exercised directly, since the pipe
 *      is decorator-applied and does not run on a bare method call).
 *   3. Response surface — returns ONLY the requested-fields DTO shape
 *      and never logs an email.
 *   4. Tenant-scope exempt wrap (TS-020-followup-2b) — `User` is a
 *      tenant-scoped model, so the handler must run inside an
 *      `internal-recipient-contacts` exempt frame on every code path.
 */

const SECRET = 'r'.repeat(48);
const HEADER = 'x-internal-api-key';

function makeEnv(): Env {
  return {
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: HEADER,
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: SECRET,
  } as unknown as Env;
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function fakeRequest(headerValue?: string): Request {
  return {
    header: (name: string): string | undefined => (name === HEADER ? headerValue : undefined),
  } as unknown as Request;
}

type ResolveReturn = Awaited<ReturnType<RecipientContactsService['resolveBatch']>>;

function buildController(
  resolveImpl: () => Promise<ResolveReturn> = async () => [
    { userId: 'usr_1', email: 'a@example.com', status: 'active' },
  ],
): {
  controller: RecipientContactsController;
  service: { resolveBatch: ReturnType<typeof vi.fn> };
  store: TenantContextStore;
} {
  const service = { resolveBatch: vi.fn(resolveImpl) };
  const store = makeStore();
  const controller = new RecipientContactsController(
    service as unknown as RecipientContactsService,
    makeEnv(),
    store,
  );
  return { controller, service, store };
}

describe('RecipientContactsController.resolveContacts — shared secret', () => {
  it('rejects a missing shared-secret header with 401', async () => {
    const { controller, service } = buildController();
    await expect(
      controller.resolveContacts({ userIds: ['usr_1'] }, fakeRequest()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.resolveBatch).not.toHaveBeenCalled();
  });

  it('rejects a wrong shared-secret header with 401', async () => {
    const { controller, service } = buildController();
    await expect(
      controller.resolveContacts({ userIds: ['usr_1'] }, fakeRequest('totally-wrong')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.resolveBatch).not.toHaveBeenCalled();
  });

  it('rejects a same-length-but-different-bytes header with 401', async () => {
    const { controller, service } = buildController();
    const wrongSameLength = 'q'.repeat(SECRET.length);
    await expect(
      controller.resolveContacts({ userIds: ['usr_1'] }, fakeRequest(wrongSameLength)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.resolveBatch).not.toHaveBeenCalled();
  });

  it('resolves and returns the parsed response when the secret matches', async () => {
    const { controller, service } = buildController(async () => [
      { userId: 'usr_1', email: 'a@example.com', status: 'active' },
      { userId: 'usr_2', email: 'b@example.com', status: 'suspended' },
    ]);
    const response = await controller.resolveContacts(
      { userIds: ['usr_1', 'usr_2'] },
      fakeRequest(SECRET),
    );
    expect(service.resolveBatch).toHaveBeenCalledOnce();
    expect(service.resolveBatch).toHaveBeenCalledWith(['usr_1', 'usr_2']);
    expect(response).toEqual({
      contacts: [
        { userId: 'usr_1', email: 'a@example.com', status: 'active' },
        { userId: 'usr_2', email: 'b@example.com', status: 'suspended' },
      ],
    });
  });

  it('returns ONLY the contract fields (userId, email, status) on each contact', async () => {
    const { controller } = buildController(async () => [
      { userId: 'usr_1', email: 'a@example.com', status: 'active' },
    ]);
    const response = await controller.resolveContacts({ userIds: ['usr_1'] }, fakeRequest(SECRET));
    const contact = response.contacts[0];
    expect(contact).toBeDefined();
    expect(Object.keys(contact ?? {}).sort()).toEqual(['email', 'status', 'userId']);
  });

  it('rejects (does not silently pass) a service projection carrying an extra field', async () => {
    // Defence-in-depth: the response is parsed through the `.strict()`
    // contract schema at the boundary. If the service ever drifted and
    // handed back an over-broad row (e.g. leaking a column), the parse
    // throws rather than letting the extra field reach the worker.
    const { controller } = buildController(async () => [
      {
        userId: 'usr_1',
        email: 'a@example.com',
        status: 'active',
        passwordHash: 'should-never-appear',
      } as unknown as ResolveReturn[number],
    ]);
    await expect(
      controller.resolveContacts({ userIds: ['usr_1'] }, fakeRequest(SECRET)),
    ).rejects.toThrow();
  });

  it('returns an empty contacts array when nothing resolves', async () => {
    const { controller } = buildController(async () => []);
    const response = await controller.resolveContacts({ userIds: ['usr_x'] }, fakeRequest(SECRET));
    expect(response).toEqual({ contacts: [] });
  });

  it('emits no log lines carrying an email from the controller path', async () => {
    // The controller carries no Logger — observability + the count-only
    // (never email) log line live in `RecipientContactsService`, pinned
    // by its own test. Spying every Logger level proves the controller
    // path emits nothing the (no-op fake) service didn't, so no email
    // can escape from the HTTP boundary into a log line.
    const captured: unknown[] = [];
    const sink = (...args: unknown[]): undefined => {
      captured.push(...args);
      return undefined;
    };
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(sink);
    const debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(sink);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(sink);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(sink);

    const { controller } = buildController(async () => [
      { userId: 'usr_1', email: 'leaky@example.com', status: 'active' },
    ]);
    const response = await controller.resolveContacts({ userIds: ['usr_1'] }, fakeRequest(SECRET));

    // The email is in the RESPONSE (the surface's whole purpose) ...
    expect(response.contacts[0]?.email).toBe('leaky@example.com');
    // ... but it was never written to a log line.
    expect(JSON.stringify(captured)).not.toContain('leaky@example.com');

    logSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('RecipientContactsController request validation (ZodValidationPipe)', () => {
  // The pipe is decorator-applied via `@UsePipes`, so it does not run on
  // a bare method call. Exercise it directly the way nest-common's own
  // pipe tests do — this pins the 400 contract for the route.
  const pipe = new ZodValidationPipe(InternalRecipientContactsRequestSchema);

  it('accepts a well-formed body', () => {
    expect(pipe.transform({ userIds: ['usr_1', 'usr_2'] })).toEqual({
      userIds: ['usr_1', 'usr_2'],
    });
  });

  it('rejects an empty userIds array with 400', () => {
    expect(() => pipe.transform({ userIds: [] })).toThrow(BadRequestException);
  });

  it('rejects a missing userIds field with 400', () => {
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });

  it('rejects unknown fields (strict schema) with 400', () => {
    expect(() => pipe.transform({ userIds: ['usr_1'], extra: 'nope' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects a batch larger than the cap with 400', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `usr_${i}`);
    expect(() => pipe.transform({ userIds: tooMany })).toThrow(BadRequestException);
  });
});

/**
 * Tenant-scope exempt wrap coverage for `resolveContacts`
 * (TS-020-followup-2b).
 *
 * `User` is a tenant-scoped model (NOT in the `AppModule`
 * `unscopedModels` list), so under the `enforce` posture the
 * `prisma.user.findMany` read would raise `MissingRequestContextError`
 * unless the handler runs inside an explicit exempt frame. The handler
 * wraps its body — including the 401 short-circuit — in
 * `runWithoutTenantContext(store, 'internal-recipient-contacts', ...)`.
 *
 * Each test constructs a real `TenantContextStore`, captures the frame
 * the store reports at the collaborator callsite (or via the
 * `request.header` lookup for the 401 short-circuit), and asserts the
 * frame is the exact `{ kind: 'exempt', reason: 'internal-recipient-contacts' }`
 * shape ops will see in the audit log, with no frame leaking past the
 * handler's async lifetime.
 */
describe('RecipientContactsController tenant-scope exempt wrap (TS-020-followup-2b)', () => {
  it('runs the happy path inside an exempt frame with reason "internal-recipient-contacts"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const service = {
      resolveBatch: vi.fn(async () => {
        captured = store.current();
        return [{ userId: 'usr_1', email: 'a@example.com', status: 'active' }];
      }),
    };
    const controller = new RecipientContactsController(
      service as unknown as RecipientContactsService,
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    const response = await controller.resolveContacts({ userIds: ['usr_1'] }, fakeRequest(SECRET));
    expect(store.current()).toBeNull();

    expect(captured).toEqual({ kind: 'exempt', reason: 'internal-recipient-contacts' });
    expect(response.contacts).toHaveLength(1);
  });

  it('runs the missing-secret 401 branch inside the same exempt frame', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    // The 401 short-circuit returns before the service is called, so the
    // captured-frame probe lives on the `request.header` lookup — the
    // shared-secret helper invokes it INSIDE the wrap.
    const request = {
      header: (name: string): string | undefined => {
        if (name === HEADER) {
          captured = store.current();
          return undefined;
        }
        return undefined;
      },
    } as unknown as Request;
    const service = { resolveBatch: vi.fn() };
    const controller = new RecipientContactsController(
      service as unknown as RecipientContactsService,
      makeEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    await expect(
      controller.resolveContacts({ userIds: ['usr_1'] }, request),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(store.current()).toBeNull();

    expect(captured).toEqual({ kind: 'exempt', reason: 'internal-recipient-contacts' });
    expect(service.resolveBatch).not.toHaveBeenCalled();
  });
});
