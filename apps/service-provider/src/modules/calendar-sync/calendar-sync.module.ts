import { Module } from '@nestjs/common';

import { CalendarSyncController } from './controllers/calendar-sync.controller';
import { CalendarSyncMetrics } from './services/calendar-sync-metrics';
import { CalendarSyncService } from './services/calendar-sync.service';
import { CalendarTokenCipherService } from './services/calendar-token-cipher.service';
import { GoogleCalendarAdapter } from './services/google-calendar.adapter';
import { GOOGLE_CALENDAR_PORT } from './services/google-calendar.port';

/**
 * Calendar-sync bounded module (TS-206) — owns the Google Calendar
 * free/busy sync surface: OAuth connect / callback / manual sync /
 * disconnect / snapshot, the AES-256-GCM refresh-token cipher, and the
 * external busy mirror the availability projection unions.
 *
 * Composition:
 *   - `CalendarSyncController` — HTTP boundary (the OAuth callback is the
 *     one unauthenticated, `runWithoutTenantContext`-wrapped surface).
 *   - `CalendarSyncService` — owns the OAuth flow, the network-outside-
 *     the-transaction sync, the busy-mirror writes, and the
 *     `provider.calendar_synced` outbox emission. Exported so the
 *     discovery module can union the external busy intervals into the
 *     next-7-days availability summary.
 *   - `CalendarTokenCipherService` — independent-key AES-256-GCM cipher
 *     for the at-rest refresh token (CLAUDE.md §3.5).
 *   - `GoogleCalendarAdapter` bound to `GOOGLE_CALENDAR_PORT` — the ONLY
 *     file importing `@googleapis/calendar` (ADR-0003). Swapped for a
 *     fake in unit tests.
 *
 * The new tables (`ProviderCalendarConnection`,
 * `ProviderCalendarExternalBusy`) are per-provider — they flow through
 * the tenant-scoping gate normally (NOT in `AppModule`'s
 * `unscopedModels`).
 */
@Module({
  controllers: [CalendarSyncController],
  providers: [
    CalendarSyncService,
    CalendarSyncMetrics,
    CalendarTokenCipherService,
    { provide: GOOGLE_CALENDAR_PORT, useClass: GoogleCalendarAdapter },
  ],
  exports: [CalendarSyncService],
})
export class CalendarSyncModule {}
