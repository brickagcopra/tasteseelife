import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { SEARCH_RESULT_CLICKED, type SearchResultClicked } from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Emits the `search.result_clicked` analytics event (TS-217-prep-4b) when the
 * family-portal reports a click on a search result.
 *
 * **Best-effort by construction.** A click is telemetry, never a
 * correctness-bearing write — there is no business transaction to append the
 * event atomically with (the same situation as the `search.performed` producer,
 * `SearchAnalyticsEmitter`). The emit runs OFF any critical path: every failure
 * (Postgres unreachable, the tenant-scope gate, a payload that fails registry
 * validation) is logged at `warn` and swallowed, and the caller returns 202 to
 * the client regardless. Losing a click on a transient blip must never surface
 * an error to the family-portal beacon.
 *
 * **The event's own id vs. the correlation token.** Each click gets its OWN
 * `eventId` (minted here with `randomUUID` — one outbox row per click), distinct
 * from the `searchId` correlation token it carries. The CTR funnel is the join
 * `search.result_clicked.searchId === search.performed.eventId`
 * (TS-217-prep-4a).
 *
 * Returns whether the event was durably appended so the controller can report
 * `accepted` honestly; a `false` is informational only (the request still
 * succeeds).
 */
@Injectable()
export class SearchClickEmitter {
  private readonly log = new Logger(SearchClickEmitter.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
  ) {}

  async emitSearchResultClicked(input: {
    readonly searchId: string;
    readonly actorUserId: string;
    readonly providerId: string;
    readonly position: number;
  }): Promise<boolean> {
    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload: SearchResultClicked = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      searchId: input.searchId,
      actorUserId: input.actorUserId,
      providerId: input.providerId,
      position: input.position,
    };

    try {
      const result = await this.outbox.append(this.prisma as unknown as OutboxRawExecutor, {
        eventName: SEARCH_RESULT_CLICKED,
        payload,
        eventId,
        occurredAt,
      });
      if (result.kind !== 'appended') {
        this.log.warn(
          `search.result_clicked payload failed registry validation (best-effort, dropped): ${result.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      // Best-effort: never let analytics telemetry break a click report.
      this.log.warn(
        `search.result_clicked append failed (best-effort, dropped): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }
}
