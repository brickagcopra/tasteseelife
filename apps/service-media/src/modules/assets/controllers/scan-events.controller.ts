import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  RecordAssetEventRequestSchema,
  type RecordAssetEventRequest,
  type RecordAssetEventResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { InternalSharedSecretGuard } from '../../../common/guards/internal-shared-secret.guard';
import { AssetsService, RecordAssetEventFailure } from '../services/assets.service';

/**
 * TS-110 — internal scan-event ingest surface.
 *
 * The media-processor worker (TS-110-followup-1) calls this endpoint
 * to report each pipeline stage outcome:
 *
 *   - `upload_completed`  — S3 confirms the bytes are present.
 *   - `magic_byte_passed` — the magic-byte sniffer accepted the bytes.
 *   - `magic_byte_failed` — the magic-byte sniffer rejected the bytes.
 *   - `scan_passed`       — ClamAV cleared the file.
 *   - `scan_failed`       — ClamAV reported infection.
 *   - `process_passed`    — Sharp resize / format-conversion landed.
 *   - `process_failed`    — Sharp crashed (decompression bomb, format
 *     unsupported).
 *   - `expired`           — the upload signed URL TTL lapsed before
 *     S3 reported the object.
 *
 * **Idempotency.** The DB UNIQUE on `(asset_id, event_kind)` is the
 * authoritative dedup mechanism. A retried event for the same pair
 * returns `outcome=replayed` and the existing asset row.
 *
 * **Authentication.** `InternalSharedSecretGuard` pins the route to
 * the configured shared secret. Network-layer isolation (TS-151
 * NetworkPolicy) layers on top.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout).** The
 * `InternalSharedSecretGuard` does NOT seed a `request.requestContext`
 * — the media-processor worker is a cluster-internal caller that does
 * not log in as a Taste & See user. The `TenantContextInterceptor`
 * therefore cannot seed a scoped frame, and the Prisma extension's
 * `enforce` posture would fire `MissingRequestContextError` on the
 * first model touch inside `AssetsService.recordAssetEvent`'s
 * `$transaction`. The handler body wraps in
 * `runWithoutTenantContext(..., 'internal-media-scan-event-record', ...)`
 * so every downstream Prisma operation sees an explicit `exempt` frame.
 * Mirrors the wrap landed in service-audit's `AuditController.recordEvent`
 * (`internal-audit-event-record`) and service-activity's
 * `ActivityController.recordEvent` (`internal-activity-event-record`).
 */
@Controller()
@UseGuards(InternalSharedSecretGuard)
export class ScanEventsController {
  constructor(
    private readonly assets: AssetsService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Post('api/v1/internal/media/scan-events')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(RecordAssetEventRequestSchema))
  async record(@Body() body: RecordAssetEventRequest): Promise<RecordAssetEventResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-media-scan-event-record',
      async () => {
        try {
          return await this.assets.recordAssetEvent(body);
        } catch (err) {
          if (err instanceof RecordAssetEventFailure) {
            if (err.code === 'asset_not_found') {
              throw new NotFoundException({
                type: 'about:blank',
                title: 'Not Found',
                status: HttpStatus.NOT_FOUND,
                detail: err.detail,
              });
            }
            throw new UnprocessableEntityException({
              type: 'about:blank',
              title: 'Unprocessable Entity',
              status: HttpStatus.UNPROCESSABLE_ENTITY,
              detail: err.detail,
              code: err.code,
            });
          }
          throw err;
        }
      },
    );
  }
}
