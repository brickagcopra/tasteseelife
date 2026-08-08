import { UnauthorizedException } from '@nestjs/common';
import type { InternalHouseholdMembershipsResponse } from '@taste-and-see/contracts';
import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { HouseholdMembershipsService } from '../services/household-memberships.service';
import { HouseholdMembershipsInternalController } from './household-memberships.controller';

/**
 * HouseholdMembershipsInternalController tests (TS-505d2-followup-5).
 *
 * This route is an authorisation input for the api-gateway — its answer
 * becomes a request's household tenant scope — so the shared-secret gate
 * and the exempt tenant frame are the properties that matter, not the
 * projection.
 */

const SECRET = 'm'.repeat(48);
const HEADER = 'x-household-memberships-internal-api-key';

function makeEnv(): Env {
  return {
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: HEADER,
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: SECRET,
  } as unknown as Env;
}

function fakeRequest(headerValue?: string): Request {
  return {
    header: (name: string): string | undefined => (name === HEADER ? headerValue : undefined),
  } as unknown as Request;
}

function sample(): InternalHouseholdMembershipsResponse {
  return {
    memberships: [{ householdId: 'hh_one', memberRole: 'primary_payer' }],
  };
}

describe('HouseholdMembershipsInternalController', () => {
  let service: { listForUser: ReturnType<typeof vi.fn> };
  let store: TenantContextStore;
  let controller: HouseholdMembershipsInternalController;

  beforeEach(() => {
    service = { listForUser: vi.fn().mockResolvedValue(sample()) };
    store = new TenantContextStore();
    controller = new HouseholdMembershipsInternalController(
      service as unknown as HouseholdMembershipsService,
      makeEnv(),
      store,
    );
  });

  describe('shared-secret enforcement', () => {
    it('rejects a request with no secret header', async () => {
      await expect(controller.listForUser('usr_1', fakeRequest())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(service.listForUser).not.toHaveBeenCalled();
    });

    it('rejects a wrong secret', async () => {
      await expect(
        controller.listForUser('usr_1', fakeRequest('x'.repeat(48))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(service.listForUser).not.toHaveBeenCalled();
    });

    it('rejects a secret that is a prefix of the real one', async () => {
      // The length check is the early reject in `isSharedSecretValid`;
      // this pins that a truncated key cannot pass.
      await expect(
        controller.listForUser('usr_1', fakeRequest(SECRET.slice(0, 40))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('accepts the correct secret and returns the parsed response', async () => {
      const result = await controller.listForUser('usr_1', fakeRequest(SECRET));
      expect(result).toEqual(sample());
      expect(service.listForUser).toHaveBeenCalledWith({ userId: 'usr_1' });
    });
  });

  describe('response contract', () => {
    it('an unknown user is a 200 with an empty list, never a 404', async () => {
      // The caller is asking "which households may this user act in", and
      // "none" answers it. A 404 would be indistinguishable from a renamed
      // route at the gateway.
      service.listForUser.mockResolvedValue({ memberships: [] });
      await expect(controller.listForUser('usr_nope', fakeRequest(SECRET))).resolves.toEqual({
        memberships: [],
      });
    });

    it('throws rather than serve a response that fails the contract', async () => {
      // Boundary parse is the leak/drift control: this value becomes an
      // authorisation decision one hop away.
      service.listForUser.mockResolvedValue({
        memberships: [{ householdId: 'hh_one', memberRole: 'primary_payer', secret: 'leaked' }],
      });
      await expect(controller.listForUser('usr_1', fakeRequest(SECRET))).rejects.toThrow();
    });
  });

  describe('tenant-scope exemption', () => {
    it('runs the handler inside an explicit exempt frame and leaves the store clean', async () => {
      let frameDuringCall: unknown;
      service.listForUser.mockImplementation(async () => {
        frameDuringCall = store.current();
        return sample();
      });

      expect(store.current()).toBeNull();
      await controller.listForUser('usr_1', fakeRequest(SECRET));
      expect(store.current()).toBeNull();

      // The exempt frame is structurally required here, not merely
      // convenient: this route is what ESTABLISHES a caller's household
      // scope, so it cannot run inside one.
      expect(frameDuringCall).toEqual({
        kind: 'exempt',
        reason: 'internal-household-memberships',
      });
    });
  });
});

/**
 * `resolveBillingContacts` route tests (TS-042-followup-3a1).
 *
 * The same shared-secret and exempt-frame properties as the sibling route,
 * plus the one that is specific to this surface: the boundary parse is a
 * DISCLOSURE control, because the projection it guards is what keeps a
 * senior's or an observer's user id off a billing path.
 */
describe('HouseholdMembershipsInternalController.resolveBillingContacts', () => {
  const sampleContacts = {
    contacts: [{ householdId: 'hh_one', payerUserIds: ['usr_payer'] }],
  };

  let service: { resolveBillingContacts: ReturnType<typeof vi.fn> };
  let store: TenantContextStore;
  let controller: HouseholdMembershipsInternalController;

  beforeEach(() => {
    service = { resolveBillingContacts: vi.fn().mockResolvedValue(sampleContacts) };
    store = new TenantContextStore();
    controller = new HouseholdMembershipsInternalController(
      service as unknown as HouseholdMembershipsService,
      makeEnv(),
      store,
    );
  });

  it('rejects a request with no secret header, without touching the service', async () => {
    await expect(
      controller.resolveBillingContacts({ householdIds: ['hh_one'] }, fakeRequest()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.resolveBillingContacts).not.toHaveBeenCalled();
  });

  it('rejects a secret that is a prefix of the real one', async () => {
    await expect(
      controller.resolveBillingContacts(
        { householdIds: ['hh_one'] },
        fakeRequest(SECRET.slice(0, 40)),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts the correct secret and returns the parsed response', async () => {
    const result = await controller.resolveBillingContacts(
      { householdIds: ['hh_one'] },
      fakeRequest(SECRET),
    );
    expect(result).toEqual(sampleContacts);
    expect(service.resolveBillingContacts).toHaveBeenCalledWith({ householdIds: ['hh_one'] });
  });

  it('a household with no payer is simply absent, and that is a 200', async () => {
    service.resolveBillingContacts.mockResolvedValue({ contacts: [] });
    await expect(
      controller.resolveBillingContacts({ householdIds: ['hh_nobody'] }, fakeRequest(SECRET)),
    ).resolves.toEqual({ contacts: [] });
  });

  it('refuses to serve a household row carrying an empty payer list', async () => {
    // `.min(1)` on `payerUserIds` makes "resolved, but nobody" unrepresentable
    // — it must be an ABSENT household, which reads as the escalation it is.
    service.resolveBillingContacts.mockResolvedValue({
      contacts: [{ householdId: 'hh_one', payerUserIds: [] }],
    });
    await expect(
      controller.resolveBillingContacts({ householdIds: ['hh_one'] }, fakeRequest(SECRET)),
    ).rejects.toThrow();
  });

  it('refuses to serve a widened projection', async () => {
    // The disclosure control: if the query were later widened to carry a
    // member role or an address, `.strict()` stops it leaving here rather
    // than letting a billing path learn a senior's identity.
    service.resolveBillingContacts.mockResolvedValue({
      contacts: [
        { householdId: 'hh_one', payerUserIds: ['usr_payer'], email: 'someone@example.com' },
      ],
    });
    await expect(
      controller.resolveBillingContacts({ householdIds: ['hh_one'] }, fakeRequest(SECRET)),
    ).rejects.toThrow();
  });

  it('runs inside its own named exempt frame and leaves the store clean', async () => {
    let frameDuringCall: unknown;
    service.resolveBillingContacts.mockImplementation(async () => {
      frameDuringCall = store.current();
      return sampleContacts;
    });

    expect(store.current()).toBeNull();
    await controller.resolveBillingContacts({ householdIds: ['hh_one'] }, fakeRequest(SECRET));
    expect(store.current()).toBeNull();

    // Its own reason string, not the sibling's — the frame reason is what
    // an operator reads when a tenant-gate exemption shows up in a log.
    expect(frameDuringCall).toEqual({
      kind: 'exempt',
      reason: 'internal-household-billing-contacts',
    });
  });
});
