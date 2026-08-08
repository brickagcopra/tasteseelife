import { Module } from '@nestjs/common';

import { AssetsController } from './controllers/assets.controller';
import { ScanEventsController } from './controllers/scan-events.controller';
import { SeniorPhotosController } from './controllers/senior-photos.controller';
import { AssetsService } from './services/assets.service';
import { MagicByteDetectorService } from './services/magic-byte-detector.service';
import { SignedUrlIssuerService } from './services/signed-url-issuer.service';

/**
 * TS-110 — assets module.
 *
 * Providers:
 *   - `AssetsService` — orchestration (mint URL, persist, ingest events).
 *   - `SignedUrlIssuerService` — stub-mode-by-default signed-URL minting.
 *   - `MagicByteDetectorService` — pure-TS detector. Exported for the
 *     future media-processor worker (TS-110-followup-1) to consume via
 *     the workspace package; today it's bound here so the integration
 *     test in TS-110-followup-7 can exercise it against the assets
 *     service.
 *
 * Controllers:
 *   - `AssetsController` — owner / admin HTTP surface
 *     (`POST /api/v1/media/upload-urls`, `GET /api/v1/media/assets/:id`,
 *     `GET /api/v1/admin/media/assets`).
 *   - `SeniorPhotosController` — family photo-gallery read surface
 *     (`GET /api/v1/media/seniors/:seniorId/photos`, TS-232). Consent
 *     gating is applied upstream by the api-gateway aggregator.
 *   - `ScanEventsController` — internal HTTP surface
 *     (`POST /api/v1/internal/media/scan-events`).
 */
@Module({
  controllers: [AssetsController, SeniorPhotosController, ScanEventsController],
  providers: [AssetsService, SignedUrlIssuerService, MagicByteDetectorService],
  exports: [AssetsService, SignedUrlIssuerService, MagicByteDetectorService],
})
export class AssetsModule {}
