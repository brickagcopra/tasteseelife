import { expect, test } from '@playwright/test';
import {
  ConciergeTicketsListResponseSchema,
  SubmitConciergeRequestResponseSchema,
  TriggerEmergencyAssistanceResponseSchema,
} from '@taste-and-see/contracts';

import { idempotencyKey } from '../src/actors';
import { registerVerifiedUser } from '../src/auth-flows';
import { gateway } from '../src/gateway-client';
import { seedHouseholdWithMember } from '../src/household-flows';

/**
 * The concierge family surfaces (TS-505d2-followup-5b, concierge half).
 *
 * **Nine of the thirteen handlers TS-505d2-followup-5 unblocked live in
 * `service-concierge`, and not one had ever been reached by a running
 * process.** Every one resolves the acting household from
 * `requestContext.tenantScope`, so every one returned 400 to every real user
 * for its entire existence, while the service's 294 unit tests stayed green.
 * `service-concierge` joins the fleet here for the first time.
 *
 * The two surfaces under test are the ones a family actually touches: the
 * concierge request (submit + list mine) and the emergency escalation. The
 * emergency path is the one CLAUDE.md §12 makes first-class, and it is also
 * the one whose refusal was most costly — a family with an urgent need met a
 * validation error.
 *
 * **PagerDuty is deliberately unconfigured on this fleet.** `PAGERDUTY_ROUTING_KEY`
 * is `.optional()` and the page is best-effort; a suite that paged a real
 * rotation would be a worse defect than the one it was written to catch. The
 * ticket is created either way, which is the contract (whether the page went
 * out is an observability concern, not a family-facing field).
 */

const REQUEST_BODY = {
  kind: 'holiday_dinner' as const,
  subject: 'Thanksgiving dinner for four',
  body: 'Mum would love the whole family round the table. Low-sodium, and she loves a pecan pie.',
};

test.describe('concierge family surfaces', () => {
  test('a household member submits a concierge request and finds it in their own list', async () => {
    const family = await registerVerifiedUser('concierge-family');
    const { householdId } = await seedHouseholdWithMember({ userId: family.userId });

    const submitted = await gateway('/api/v1/concierge/requests', {
      method: 'POST',
      accessToken: family.accessToken,
      idempotencyKey: idempotencyKey(),
      body: REQUEST_BODY,
    });

    expect(submitted.status, submitted.text).toBe(201);
    const created = SubmitConciergeRequestResponseSchema.parse(submitted.body);
    // The household id is an OUTPUT — the body carries no household field
    // (the schema is `.strict()`, so one would be rejected), so this value
    // can only have come from the resolved tenant scope.
    expect(created.ticket.householdId).toBe(householdId);
    expect(created.ticket.kind).toBe('holiday_dinner');

    // **The read is the half that proves the scope is stable across
    // requests.** `GET /requests/me` resolves the household independently,
    // on a fresh request with a fresh membership lookup, and has to land on
    // the same one.
    const listed = await gateway('/api/v1/concierge/requests/me', {
      accessToken: family.accessToken,
    });
    expect(listed.status, listed.text).toBe(200);
    const tickets = ConciergeTicketsListResponseSchema.parse(listed.body).tickets;
    expect(tickets.map((ticket) => ticket.id)).toContain(created.ticket.id);
  });

  test("one household's requests do not appear in another's list", async () => {
    // The scope IS the row-level filter on this surface — there is no
    // household parameter to check, so the only way to be sure the filter
    // works is to have two households and look.
    const first = await registerVerifiedUser('concierge-first');
    const second = await registerVerifiedUser('concierge-second');
    await seedHouseholdWithMember({ userId: first.userId });
    await seedHouseholdWithMember({ userId: second.userId });

    const submitted = await gateway('/api/v1/concierge/requests', {
      method: 'POST',
      accessToken: first.accessToken,
      idempotencyKey: idempotencyKey(),
      body: REQUEST_BODY,
    });
    expect(submitted.status, submitted.text).toBe(201);
    const created = SubmitConciergeRequestResponseSchema.parse(submitted.body);

    const otherList = await gateway('/api/v1/concierge/requests/me', {
      accessToken: second.accessToken,
    });
    expect(otherList.status, otherList.text).toBe(200);
    const tickets = ConciergeTicketsListResponseSchema.parse(otherList.body).tickets;
    expect(tickets.map((ticket) => ticket.id)).not.toContain(created.ticket.id);
    expect(tickets).toEqual([]);
  });

  test('an emergency escalation opens a ticket on the household, at the emergency SLA', async () => {
    const family = await registerVerifiedUser('concierge-emergency');
    const { householdId } = await seedHouseholdWithMember({ userId: family.userId });

    const response = await gateway('/api/v1/concierge/emergency', {
      method: 'POST',
      accessToken: family.accessToken,
      idempotencyKey: idempotencyKey(),
      body: { category: 'medical', note: 'Mum has had a fall and is confused.' },
    });

    expect(response.status, response.text).toBe(201);
    const ticket = TriggerEmergencyAssistanceResponseSchema.parse(response.body).ticket;
    expect(ticket.householdId).toBe(householdId);
    // The three properties the emergency contract fixes: it is an emergency
    // ticket, it is already escalated (nobody triages it into the queue), and
    // it is routed to on-call. A family with an urgent need met a 400 here
    // until this session.
    expect(ticket.kind).toBe('emergency_assistance');
    expect(ticket.status).toBe('escalated');
    expect(ticket.escalationPath).toBe('emergency_on_call');
  });

  test('a user with no household is refused, on both surfaces', async () => {
    // Unchanged, and correct — this is the refusal every family member used
    // to meet. Asserted so a future change that made the scope optional
    // would fail here rather than quietly open the surface.
    const nobody = await registerVerifiedUser('concierge-nobody');

    const submit = await gateway('/api/v1/concierge/requests', {
      method: 'POST',
      accessToken: nobody.accessToken,
      idempotencyKey: idempotencyKey(),
      body: REQUEST_BODY,
    });
    expect(submit.status, submit.text).toBe(400);

    const emergency = await gateway('/api/v1/concierge/emergency', {
      method: 'POST',
      accessToken: nobody.accessToken,
      idempotencyKey: idempotencyKey(),
      body: { category: 'other' },
    });
    expect(emergency.status, emergency.text).toBe(400);
  });
});
