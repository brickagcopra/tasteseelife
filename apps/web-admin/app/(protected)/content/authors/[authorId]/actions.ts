'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { UpdateContentAuthorRequestSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

import { buildSocialLinks } from '../social-links';

/**
 * Update an author profile (TS-283; `content:edit`). A present-but-empty
 * bio / photo / social field CLEARS it (null); social links replace as a whole
 * object (all-blank clears to null). Re-validates via the contract schema, mints
 * a fresh Idempotency-Key, forwards through the gateway, revalidates + redirects.
 */

const LIST_PATH = '/content/authors';
const GW_AUTHORS = '/api/v1/admin/content/authors';

export async function updateAuthorAction(authorId: string, formData: FormData): Promise<void> {
  const detailPath = `${LIST_PATH}/${encodeURIComponent(authorId)}`;

  const body: Record<string, unknown> = {};
  const displayName = stringField(formData, 'displayName');
  if (displayName !== null) body['displayName'] = displayName;

  // bio / photo are present-but-empty = clear (null); absent input = unchanged.
  for (const field of ['bio', 'photoAssetKey'] as const) {
    const raw = formData.get(field);
    if (typeof raw === 'string') body[field] = raw.trim().length === 0 ? null : raw.trim();
  }

  // Social links: the whole object is replaced (all-blank clears to null).
  body['socialLinks'] = buildSocialLinks(formData);

  const validated = UpdateContentAuthorRequestSchema.safeParse(body);
  if (!validated.success) redirect(`${detailPath}?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(`${GW_AUTHORS}/${encodeURIComponent(authorId)}`, {
    method: 'PATCH',
    body: validated.data,
    headers: { 'idempotency-key': `admin-content-author-update-${authorId}-${randomUUID()}` },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(detailPath);
    redirect(`${detailPath}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 404) redirect(`${detailPath}?action=err&code=not-found`);
    redirect(`${detailPath}?action=err&code=bad-request`);
  }
  redirect(`${detailPath}?action=err&code=service-warning`);
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}
