import { UnauthorizedException } from '@nestjs/common';
import type { MySeniorsResponse } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { SeniorsDirectoryController } from './seniors-directory.controller';
import { SeniorsDirectoryService } from '../services/seniors-directory.service';

function makeRequest(userId: string | undefined): RequestWithContext {
  return {
    requestContext:
      userId === undefined ? undefined : ({ userId } as RequestWithContext['requestContext']),
  } as RequestWithContext;
}

describe('SeniorsDirectoryController.list', () => {
  it('forwards the authenticated userId to the service and returns its result', async () => {
    const response: MySeniorsResponse = {
      seniors: [
        {
          seniorId: 'senior_mom',
          householdId: 'hh_1',
          firstName: 'Anna',
          lastName: 'Kowalski',
          displayName: 'Bobchi',
          status: 'active',
        },
      ],
    };
    const listForUser = vi.fn().mockResolvedValue(response);
    const service = { listForUser } as unknown as SeniorsDirectoryService;
    const controller = new SeniorsDirectoryController(service);

    const result = await controller.list(makeRequest('user_payer'));

    expect(listForUser).toHaveBeenCalledWith({ requesterUserId: 'user_payer' });
    expect(result).toBe(response);
  });

  it('throws 401 when the request carries no context (guard misconfiguration)', async () => {
    const listForUser = vi.fn();
    const service = { listForUser } as unknown as SeniorsDirectoryService;
    const controller = new SeniorsDirectoryController(service);

    await expect(controller.list(makeRequest(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(listForUser).not.toHaveBeenCalled();
  });
});

describe('SeniorsDirectoryController idempotency wiring', () => {
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('does NOT mark GET /api/v1/me/seniors as @Idempotent() (read-only)', () => {
    const handler = SeniorsDirectoryController.prototype.list as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });
});
