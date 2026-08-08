/**
 * Unit tests for `SeniorPhotosController` (TS-232 family photo-gallery
 * read surface) — focused on the controller's narrow responsibilities:
 *
 *   - delegating to `AssetsService.listSeniorPhotos` with the path
 *     `seniorId` + the validated query (limit + optional cursor);
 *   - omitting `cursor` from the service args when absent (so the
 *     downstream `exactOptionalPropertyTypes` contract holds);
 *   - returning the service response unchanged.
 *
 * The `AccessTokenGuard` + the `ZodValidationPipe` are separate concerns
 * (the guard is covered by nest-auth; the query schema by the contracts
 * suite). The controller has NO tenant-scope exempt wrap — it sits behind
 * `AccessTokenGuard` so the `TenantContextInterceptor` seeds a scoped
 * frame from the access-token claims (TS-020-followup-2b rollout for
 * service-media).
 */

import type { SeniorPhotoGalleryQuery, SeniorPhotoGalleryResponse } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { AssetsService } from '../services/assets.service';

import { SeniorPhotosController } from './senior-photos.controller';

interface ListCall {
  readonly seniorId: string;
  readonly args: { readonly limit: number; readonly cursor?: string };
}

class StubAssetsService {
  public calls: ListCall[] = [];
  public listReturn: SeniorPhotoGalleryResponse = {
    seniorId: 's_1',
    photos: [],
    nextCursor: null,
  };

  async listSeniorPhotos(
    seniorId: string,
    args: { limit: number; cursor?: string },
  ): Promise<SeniorPhotoGalleryResponse> {
    this.calls.push({ seniorId, args });
    return this.listReturn;
  }
}

function buildController(): { controller: SeniorPhotosController; stub: StubAssetsService } {
  const stub = new StubAssetsService();
  const controller = new SeniorPhotosController(stub as unknown as AssetsService);
  return { controller, stub };
}

describe('SeniorPhotosController.listSeniorPhotos', () => {
  it('delegates to the service with the seniorId + limit and returns its response', async () => {
    const { controller, stub } = buildController();
    const query: SeniorPhotoGalleryQuery = { limit: 24 };

    const result = await controller.listSeniorPhotos('s_1', query);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.seniorId).toBe('s_1');
    expect(stub.calls[0]!.args).toEqual({ limit: 24 });
    expect(result).toBe(stub.listReturn);
  });

  it('forwards the cursor when present', async () => {
    const { controller, stub } = buildController();
    const query: SeniorPhotoGalleryQuery = { limit: 12, cursor: 'cursor-1' };

    await controller.listSeniorPhotos('s_2', query);

    expect(stub.calls[0]!.args).toEqual({ limit: 12, cursor: 'cursor-1' });
  });

  it('omits the cursor key entirely when absent', async () => {
    const { controller, stub } = buildController();

    await controller.listSeniorPhotos('s_3', { limit: 24 });

    expect('cursor' in stub.calls[0]!.args).toBe(false);
  });
});
