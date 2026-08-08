import { z } from 'zod';

import {
  SEARCH_RESULT_CLICKED_ID_MAX_LENGTH,
  SEARCH_RESULT_CLICKED_POSITION_MAX,
} from '../events/search';

/**
 * Search result-click ingest contract (TS-217-prep-4b; PRD §10.1, PDD §23.1).
 *
 * The family-portal reports a click on a search result — the user opening a
 * provider from a `/providers` results list — to
 * `POST /api/v1/search/clicks`. `service-search` server-stamps the actor from
 * the access-token context and emits a best-effort `search.result_clicked`
 * event carrying the `searchId` correlation token (TS-217-prep-4a), the clicked
 * `providerId`, and the zero-based result `position`, so `service-analytics`
 * can compute click-through-rate by position.
 *
 * **Best-effort telemetry.** A click is never a correctness-bearing write — the
 * producer swallows append failures (mirroring `search.performed`). The
 * response's `accepted` reflects whether the event was durably appended, but
 * the client (a `navigator.sendBeacon` from the results page) ignores the body;
 * the endpoint never fails a navigation.
 *
 * The request shape mirrors the `search.result_clicked` event payload minus the
 * envelope + the server-stamped `actorUserId`: the client supplies only the
 * three correlation fields it observed in the results UI.
 */

/** Request body for `POST /api/v1/search/clicks`. */
export const RecordSearchClickRequestSchema = z
  .object({
    /**
     * The correlation token the client received on the
     * `SearchProvidersResponse.searchId` (= the originating `search.performed`
     * event's `eventId`; TS-217-prep-4a). The CTR funnel join key.
     */
    searchId: z.string().min(1).max(SEARCH_RESULT_CLICKED_ID_MAX_LENGTH),
    /** The clicked provider's index doc id (soft-FK; CLAUDE.md §2.3). */
    providerId: z.string().min(1).max(SEARCH_RESULT_CLICKED_ID_MAX_LENGTH),
    /** Zero-based rank of the clicked result within the page the user saw. */
    position: z.number().int().min(0).max(SEARCH_RESULT_CLICKED_POSITION_MAX),
  })
  .strict();
export type RecordSearchClickRequest = z.infer<typeof RecordSearchClickRequestSchema>;

/**
 * Response body for `POST /api/v1/search/clicks`. `accepted: true` when the
 * `search.result_clicked` event was durably appended to the outbox;
 * `accepted: false` when the best-effort append was dropped (the click is still
 * acknowledged with a 202 — telemetry loss never fails the request).
 */
export const RecordSearchClickResponseSchema = z
  .object({
    accepted: z.boolean(),
  })
  .strict();
export type RecordSearchClickResponse = z.infer<typeof RecordSearchClickResponseSchema>;
