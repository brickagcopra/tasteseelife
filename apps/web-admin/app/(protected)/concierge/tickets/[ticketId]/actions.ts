'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  AddConciergeTicketNoteRequestSchema,
  ConciergeEscalationTargetSchema,
  ConciergeTicketStatusSchema,
  EscalateConciergeTicketRequestSchema,
  TransitionConciergeTicketRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the concierge ticket-detail surface (TS-224; PRD §10.6;
 * PDD §10.6).
 *
 *   - `transitionTicketAction(ticketId, formData)` — move the ticket to the
 *     selected target status, with an optional note.
 *   - `escalateTicketAction(ticketId, formData)` — set the routing path +
 *     move to `escalated`, with an optional note.
 *   - `addTicketNoteAction(ticketId, formData)` — append an internal note.
 *
 * Each re-validates the payload via the contract schema (defence-in-depth),
 * mints a fresh `Idempotency-Key` per submission (CLAUDE.md §3.3), POSTs
 * through the gateway BFF, then revalidates + redirects back to the ticket
 * with `?action=ok` (or `?action=err&code=…`) for the inline banner.
 */

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

function detailPath(ticketId: string): string {
  return `/concierge/tickets/${encodeURIComponent(ticketId)}`;
}

export async function transitionTicketAction(ticketId: string, formData: FormData): Promise<void> {
  const targetStatusRaw = stringField(formData, 'targetStatus');
  const note = stringField(formData, 'note');

  const targetStatus = ConciergeTicketStatusSchema.safeParse(targetStatusRaw);
  if (!targetStatus.success) return redirectWithError(ticketId, 'invalid-input');

  const body: Record<string, unknown> = { targetStatus: targetStatus.data };
  if (note !== null) body['note'] = note;

  const validated = TransitionConciergeTicketRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(ticketId, 'invalid-input');

  await postAndRedirect(ticketId, 'transition', validated.data);
}

export async function escalateTicketAction(ticketId: string, formData: FormData): Promise<void> {
  const escalationPathRaw = stringField(formData, 'escalationPath');
  const note = stringField(formData, 'note');

  const escalationPath = ConciergeEscalationTargetSchema.safeParse(escalationPathRaw);
  if (!escalationPath.success) return redirectWithError(ticketId, 'invalid-input');

  const body: Record<string, unknown> = { escalationPath: escalationPath.data };
  if (note !== null) body['note'] = note;

  const validated = EscalateConciergeTicketRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(ticketId, 'invalid-input');

  await postAndRedirect(ticketId, 'escalate', validated.data);
}

export async function addTicketNoteAction(ticketId: string, formData: FormData): Promise<void> {
  const noteBody = stringField(formData, 'body');
  if (noteBody === null) return redirectWithError(ticketId, 'invalid-input');

  const validated = AddConciergeTicketNoteRequestSchema.safeParse({ body: noteBody });
  if (!validated.success) return redirectWithError(ticketId, 'invalid-input');

  await postAndRedirect(ticketId, 'notes', validated.data);
}

async function postAndRedirect(
  ticketId: string,
  action: 'transition' | 'escalate' | 'notes',
  body: unknown,
): Promise<void> {
  const idempotencyKey = `admin-concierge-${action}-${ticketId}-${randomUUID()}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/tickets/${encodeURIComponent(ticketId)}/${action}`,
    {
      method: 'POST',
      body,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'ok') {
    revalidatePath(detailPath(ticketId));
    return redirectWithSuccess(ticketId);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(ticketId, 'conflict');
    if (result.status === 404) return redirectWithError(ticketId, 'not-found');
    return redirectWithError(ticketId, 'bad-request');
  }
  return redirectWithError(ticketId, 'service-warning');
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function redirectWithSuccess(ticketId: string): never {
  redirect(`${detailPath(ticketId)}?action=ok`);
}

function redirectWithError(ticketId: string, code: ActionErrorCode): never {
  redirect(`${detailPath(ticketId)}?action=err&code=${code}`);
}
