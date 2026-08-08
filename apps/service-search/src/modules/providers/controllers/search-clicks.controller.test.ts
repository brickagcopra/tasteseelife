import { UnauthorizedException } from '@nestjs/common';
import type { RecordSearchClickRequest } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type { SearchClickEmitter } from '../services/search-click.emitter';
import { SearchClicksController } from './search-clicks.controller';

class FakeEmitter {
  calls: Array<{
    searchId: string;
    actorUserId: string;
    providerId: string;
    position: number;
  }> = [];
  next = true;
  emitSearchResultClicked(input: {
    searchId: string;
    actorUserId: string;
    providerId: string;
    position: number;
  }): Promise<boolean> {
    this.calls.push(input);
    return Promise.resolve(this.next);
  }
}

function makeController(): { controller: SearchClicksController; emitter: FakeEmitter } {
  const emitter = new FakeEmitter();
  const controller = new SearchClicksController(emitter as unknown as SearchClickEmitter);
  return { controller, emitter };
}

function reqWith(userId: string | undefined): RequestWithContext {
  return {
    requestContext: userId === undefined ? undefined : { userId },
  } as unknown as RequestWithContext;
}

const BODY: RecordSearchClickRequest = { searchId: 'srch_1', providerId: 'prv_9', position: 2 };

describe('SearchClicksController.record', () => {
  it('server-stamps the actor and emits search.result_clicked, returning accepted', async () => {
    const { controller, emitter } = makeController();

    const result = await controller.record(reqWith('user_abc'), BODY);

    expect(result).toEqual({ accepted: true });
    expect(emitter.calls).toHaveLength(1);
    // The actor comes from the request context, never the body.
    expect(emitter.calls[0]).toEqual({
      searchId: 'srch_1',
      actorUserId: 'user_abc',
      providerId: 'prv_9',
      position: 2,
    });
  });

  it('reports accepted:false when the best-effort append was dropped', async () => {
    const { controller, emitter } = makeController();
    emitter.next = false;

    const result = await controller.record(reqWith('user_abc'), BODY);

    expect(result).toEqual({ accepted: false });
    expect(emitter.calls).toHaveLength(1);
  });

  it('rejects a request with no authenticated context (defensive 401)', async () => {
    const { controller, emitter } = makeController();

    await expect(controller.record(reqWith(undefined), BODY)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(emitter.calls).toHaveLength(0);
  });
});
