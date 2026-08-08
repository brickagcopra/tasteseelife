import { Module } from '@nestjs/common';

import { ApplicationsController } from './controllers/applications.controller';
import { ApplicationsMetrics } from './services/applications-metrics';
import { ApplicationsService } from './services/applications.service';
import { AdverseFindingEmitter } from './services/adverse-finding-emitter';
import { BackgroundCheckPayloadCipherService } from './services/background-check-payload-cipher.service';
import { BackgroundCheckService } from './services/background-check.service';
import { CheckrClient } from './services/checkr.client';

/**
 * Applications bounded module — owns the provider-application +
 * Checkr background-check surface (TS-051).
 *
 * Composition:
 *   - `ApplicationsController` — three HTTP endpoints (submit / get-
 *     mine / internal webhook dispatch).
 *   - `ApplicationsService` — application + provider-row
 *     orchestration.
 *   - `BackgroundCheckService` — Checkr lifecycle + at-rest
 *     encryption of webhook payloads.
 *   - `CheckrClient` — thin REST wrapper around api.checkr.com.
 *   - `BackgroundCheckPayloadCipherService` — AES-256-GCM cipher
 *     under an independent key (CLAUDE.md §3.5).
 *
 * No exports today — nothing outside this module consumes
 * application / background-check state directly. Provider-tier
 * promotion (TS-052) will likely read via a thin service surface
 * added here when the consumer arrives.
 */
@Module({
  controllers: [ApplicationsController],
  providers: [
    ApplicationsService,
    BackgroundCheckService,
    CheckrClient,
    BackgroundCheckPayloadCipherService,
    // TS-307a — screens a webhook status change and raises
    // `provider.background_check.adverse_finding` in the caller's transaction.
    AdverseFindingEmitter,
    ApplicationsMetrics,
  ],
})
export class ApplicationsModule {}
