'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  ContentAuthorResponseSchema,
  CreateContentAuthorRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

import { buildSocialLinks } from './social-links';

/**
 * Server action for creating a content author profile (TS-283; PRD §10.10).
 *
 * Re-validates via the contract schema, mints a fresh `Idempotency-Key`
 * (CLAUDE.md §3.3), forwards through the gateway BFF (which re-gates
 * `content:edit` + re-validates), then redirects to the new author's editor.
 */

const LIST_PATH = '/content/authors';
const GW_AUTHORS = '/api/v1/admin/content/authors';

export async function createAuthorAction(formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {
    userId: stringField(formData, 'userId'),
    displayName: stringField(formData, 'displayName'),
    ...(stringField(formData, 'bio') !== null && { bio: stringField(formData, 'bio') }),
    ...(stringField(formData, 'photoAssetKey') !== null && {
      photoAssetKey: stringField(formData, 'photoAssetKey'),
    }),
  };

  const social = buildSocialLinks(formData);
  if (social !== null) body['socialLinks'] = social;

  const validated = CreateContentAuthorRequestSchema.safeParse(body);
  if (!validated.success) redirect(`${LIST_PATH}/new?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(GW_AUTHORS, {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': `admin-content-author-create-${randomUUID()}` },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    const parsed = ContentAuthorResponseSchema.safeParse(result.body);
    if (!parsed.success) redirect(`${LIST_PATH}/new?action=err&code=service-warning`);
    revalidatePath(LIST_PATH);
    redirect(`${LIST_PATH}/${encodeURIComponent(parsed.data.author.id)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) redirect(`${LIST_PATH}/new?action=err&code=conflict`);
    redirect(`${LIST_PATH}/new?action=err&code=bad-request`);
  }
  redirect(`${LIST_PATH}/new?action=err&code=service-warning`);
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}
