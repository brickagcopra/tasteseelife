'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ArticleResponseSchema, CreateArticleRequestSchema } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server action for creating a blog/help article shell (TS-281; PRD §10.10).
 *
 * An article is created in `draft` with no version; the author then adds the
 * first renderable revision on the editor page and publishes it. Re-validates via
 * the contract schema, mints a fresh `Idempotency-Key` (CLAUDE.md §3.3), forwards
 * through the gateway BFF (which re-gates `content:edit` + re-validates), then
 * redirects to the new article's editor (`/content/articles/:id`).
 */

const LIST_PATH = '/content/articles';
const GW_ARTICLES = '/api/v1/admin/content/articles';

export async function createArticleAction(formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {
    slug: stringField(formData, 'slug'),
    title: stringField(formData, 'title'),
    ...(stringField(formData, 'categoryId') !== null && {
      categoryId: stringField(formData, 'categoryId'),
    }),
  };

  const validated = CreateArticleRequestSchema.safeParse(body);
  if (!validated.success) redirect(`${LIST_PATH}/new?action=err&code=invalid-input`);

  const result = await callGateway<unknown>(GW_ARTICLES, {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': `admin-content-article-create-${randomUUID()}` },
  });

  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    const parsed = ArticleResponseSchema.safeParse(result.body);
    if (!parsed.success) redirect(`${LIST_PATH}/new?action=err&code=service-warning`);
    revalidatePath(LIST_PATH);
    redirect(`${LIST_PATH}/${encodeURIComponent(parsed.data.article.id)}?action=ok`);
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
