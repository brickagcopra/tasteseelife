import { Module } from '@nestjs/common';

import { ProviderDirectoryController } from './controllers/provider-directory.controller';
import { ProviderDirectoryService } from './services/provider-directory.service';

/**
 * Directory bounded module (TS-305c-followup-1) — owns the admin read
 * that answers "which providers are there".
 *
 * Composition:
 *   - `ProviderDirectoryController` — `GET /api/v1/admin/providers`,
 *     gated `provider:read`.
 *   - `ProviderDirectoryService` — the filtered, ordered page plus the
 *     unpaged count over the same predicate.
 *
 * **Why not a second handler on `ProviderDossierController`.** The two
 * surfaces share a permission and a path prefix, but nothing else: the
 * dossier composes four in-service reads across `ProfileModule` and
 * `CertificationsModule`, while the directory reads one table and
 * imports nothing. Hanging the list off the dossier module would give
 * a single-table read a transitive dependency on the certification and
 * tier services it never calls.
 *
 * Imports nothing — `PrismaService` comes from the global
 * `PrismaModule`. Exports nothing: this is a leaf read surface. If the
 * gateway ever needs it, it goes over HTTP like every other
 * cross-service read (CLAUDE.md §2.3).
 */
@Module({
  controllers: [ProviderDirectoryController],
  providers: [ProviderDirectoryService],
})
export class DirectoryModule {}
