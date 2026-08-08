/**
 * Search result-click beacon receiver (TS-217-prep-4b).
 *
 * The `/providers` results page fires a `navigator.sendBeacon` here when the
 * user opens a provider from a results list (see `RecordSearchClickLink`). The
 * beacon is a SAME-ORIGIN POST so the browser attaches the portal's HttpOnly
 * session cookie automatically; this thin route handler reads that cookie via
 * `callGateway` and forwards the click to the gateway's
 * `POST /api/v1/search/clicks` proxy server-side (the browser cannot attach the
 * session cookie to the cross-origin gateway directly).
 *
 * **Best-effort telemetry.** A click report is never correctness-bearing — the
 * handler ALWAYS returns `204 No Content` (an invalid body, an auth miss, a
 * gateway hiccup are all swallowed). `sendBeacon` ignores the response anyway;
 * losing a click on a transient blip must never surface an error. Route handlers
 * stay thin (CLAUDE.md §8.1) — validation + the gateway hop only, no logic.
 */
import { RecordSearchClickRequestSchema } from '@taste-and-see/contracts';
import { NextResponse } from 'next/server';

import { callGateway } from '../../../lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  // 204 regardless — telemetry loss never fails the beacon (best-effort).
  const noContent = new NextResponse(null, { status: 204 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // sendBeacon may send the JSON as text/plain; fall back to a manual parse.
    try {
      raw = JSON.parse(await request.text());
    } catch {
      return noContent;
    }
  }

  const parsed = RecordSearchClickRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return noContent;
  }

  // Fire-and-forget to the gateway; swallow every outcome.
  await callGateway('/api/v1/search/clicks', {
    method: 'POST',
    body: parsed.data,
  }).catch(() => undefined);

  return noContent;
}
