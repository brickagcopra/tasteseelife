'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  CreateArticleVersionRequestSchema,
  PublishArticleVersionRequestSchema,
  SetArticleAuthorsRequestSchema,
  UpdateArticleCommentsRequestSchema,
  UpdateArticleRequestSchema,
  UpdateArticleSeoRequestSchema,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Server actions for the article editor (TS-281; PRD §10.10; PDD §19.1).
 *
 *   - `updateArticleMetadataAction` — rename / (re)categorise (`content:edit`).
 *   - `appendArticleVersionAction`  — save a new draft revision (`content:edit`).
 *                                     Body is canonical Markdown (ADR-0004 §2).
 *   - `publishArticleVersionAction` — flip a version live (`content:publish`).
 *
 * Each re-validates via the contract schema, mints a fresh `Idempotency-Key`
 * (CLAUDE.md §3.3), forwards through the gateway BFF (which re-gates +
 * re-validates), then revalidates + redirects back to the editor with
 * `?action=ok` (or `?action=err&code=…`).
 */

const LIST_PATH = '/content/articles';
const GW_ARTICLES = '/api/v1/admin/content/articles';

type ActionErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'not-found'
  | 'bad-request'
  | 'service-warning';

function detailPath(articleId: string): string {
  return `${LIST_PATH}/${encodeURIComponent(articleId)}`;
}

export async function updateArticleMetadataAction(
  articleId: string,
  formData: FormData,
): Promise<void> {
  const title = stringField(formData, 'title');
  const categoryRaw = formData.get('categoryId');
  // A present-but-empty categoryId field clears the category (null); an absent
  // field leaves it unchanged.
  const body: Record<string, unknown> = {
    ...(title !== null && { title }),
    ...(typeof categoryRaw === 'string' && {
      categoryId: categoryRaw.trim().length === 0 ? null : categoryRaw.trim(),
    }),
  };

  const validated = UpdateArticleRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(articleId, 'invalid-input');

  const result = await send(
    `${GW_ARTICLES}/${encodeURIComponent(articleId)}`,
    'PATCH',
    validated.data,
    'metadata',
    articleId,
  );
  finish(result, articleId);
}

/** SEO string fields — a present-but-empty input clears (null); a value sets it. */
const SEO_STRING_FIELDS = [
  'seoTitle',
  'metaDescription',
  'canonicalUrl',
  'ogTitle',
  'ogDescription',
  'ogImageKey',
  'twitterCard',
  'twitterTitle',
  'twitterDescription',
  'twitterImageKey',
] as const;

export async function updateArticleSeoAction(articleId: string, formData: FormData): Promise<void> {
  const body: Record<string, unknown> = {};
  for (const field of SEO_STRING_FIELDS) {
    const raw = formData.get(field);
    if (typeof raw !== 'string') continue;
    body[field] = raw.trim().length === 0 ? null : raw.trim();
  }

  // JSON-LD: empty clears; otherwise it must parse to an object.
  const jsonLdRaw = formData.get('jsonLd');
  if (typeof jsonLdRaw === 'string') {
    const trimmed = jsonLdRaw.trim();
    if (trimmed.length === 0) {
      body['jsonLd'] = null;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return redirectWithError(articleId, 'invalid-input');
      }
      body['jsonLd'] = parsed;
    }
  }

  const validated = UpdateArticleSeoRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(articleId, 'invalid-input');

  const result = await send(
    `${GW_ARTICLES}/${encodeURIComponent(articleId)}/seo`,
    'PATCH',
    validated.data,
    'seo',
    articleId,
  );
  finish(result, articleId);
}

/**
 * Update the per-post comments config (TS-289; `content:edit`). `enabled` and
 * `provider` post as explicit select values (a bare checkbox does not post when
 * unchecked, so a select keeps the toggle unambiguous); a present-but-empty
 * `disqusIdentifier` clears it (null → the public embed falls back to the slug).
 */
export async function updateArticleCommentsAction(
  articleId: string,
  formData: FormData,
): Promise<void> {
  const body: Record<string, unknown> = {};

  const enabledRaw = formData.get('enabled');
  if (enabledRaw === 'true' || enabledRaw === 'false') body['enabled'] = enabledRaw === 'true';

  const providerRaw = formData.get('provider');
  if (typeof providerRaw === 'string' && providerRaw.trim().length > 0) {
    body['provider'] = providerRaw.trim();
  }

  const identifierRaw = formData.get('disqusIdentifier');
  if (typeof identifierRaw === 'string') {
    body['disqusIdentifier'] = identifierRaw.trim().length === 0 ? null : identifierRaw.trim();
  }

  const validated = UpdateArticleCommentsRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(articleId, 'invalid-input');

  const result = await send(
    `${GW_ARTICLES}/${encodeURIComponent(articleId)}/comments`,
    'PATCH',
    validated.data,
    'comments',
    articleId,
  );
  finish(result, articleId);
}

export async function appendArticleVersionAction(
  articleId: string,
  formData: FormData,
): Promise<void> {
  const body: Record<string, unknown> = {
    title: stringField(formData, 'title'),
    body: stringField(formData, 'body'),
  };

  const validated = CreateArticleVersionRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(articleId, 'invalid-input');

  const result = await send(
    `${GW_ARTICLES}/${encodeURIComponent(articleId)}/versions`,
    'POST',
    validated.data,
    'version',
    articleId,
  );
  finish(result, articleId);
}

export async function publishArticleVersionAction(
  articleId: string,
  versionId: string,
  formData: FormData,
): Promise<void> {
  const effectiveAt = stringField(formData, 'effectiveAt');
  const body: Record<string, unknown> = {
    ...(effectiveAt !== null && { effectiveAt: new Date(effectiveAt).toISOString() }),
  };

  const validated = PublishArticleVersionRequestSchema.safeParse(body);
  if (!validated.success) return redirectWithError(articleId, 'invalid-input');

  const result = await send(
    `${GW_ARTICLES}/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}/publish`,
    'POST',
    validated.data,
    'publish',
    articleId,
  );
  finish(result, articleId);
}

/** Number of ordered byline slots the editor renders. */
const AUTHOR_SLOTS = 8;

/**
 * Set the article's ordered byline (TS-283; `content:edit`). Reads up to
 * `AUTHOR_SLOTS` ordered `author_<i>` / `role_<i>` slots, collects the non-empty
 * ones in order into the replace-set, and PUTs it. A duplicate author id is
 * caught by the contract schema (→ `invalid-input`) before the call.
 */
export async function setArticleAuthorsAction(
  articleId: string,
  formData: FormData,
): Promise<void> {
  const authors: Array<{ authorId: string; role: string }> = [];
  for (let i = 0; i < AUTHOR_SLOTS; i += 1) {
    const authorId = stringField(formData, `author_${i}`);
    if (authorId === null) continue;
    const role = stringField(formData, `role_${i}`) ?? 'co_author';
    authors.push({ authorId, role });
  }

  const validated = SetArticleAuthorsRequestSchema.safeParse({ authors });
  if (!validated.success) return redirectWithError(articleId, 'invalid-input');

  const result = await send(
    `${GW_ARTICLES}/${encodeURIComponent(articleId)}/authors`,
    'PUT',
    validated.data,
    'authors',
    articleId,
  );
  finish(result, articleId);
}

/**
 * Send a published post to the newsletter (TS-288; `content:publish`). No body —
 * the gateway/service resolve the recipient list. A double-send is guarded
 * downstream (409 `already_sent` → surfaced as a conflict).
 */
export async function sendArticleToNewsletterAction(
  articleId: string,
  _formData: FormData,
): Promise<void> {
  const result = await send(
    `${GW_ARTICLES}/${encodeURIComponent(articleId)}/newsletter`,
    'POST',
    {},
    'newsletter',
    articleId,
  );
  finish(result, articleId);
}

// ─── Shared plumbing ────────────────────────────────────────────────────────

async function send(
  path: string,
  method: 'PATCH' | 'POST' | 'PUT',
  body: unknown,
  surface: string,
  articleId: string,
): Promise<Awaited<ReturnType<typeof callGateway<unknown>>>> {
  const key = `admin-content-${surface}-${articleId}-${randomUUID()}`;
  return callGateway<unknown>(path, { method, body, headers: { 'idempotency-key': key } });
}

function finish(result: Awaited<ReturnType<typeof callGateway<unknown>>>, articleId: string): void {
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'ok') {
    revalidatePath(detailPath(articleId));
    redirect(`${detailPath(articleId)}?action=ok`);
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) return redirectWithError(articleId, 'conflict');
    if (result.status === 404) return redirectWithError(articleId, 'not-found');
    return redirectWithError(articleId, 'bad-request');
  }
  return redirectWithError(articleId, 'service-warning');
}

function stringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function redirectWithError(articleId: string, code: ActionErrorCode): never {
  redirect(`${detailPath(articleId)}?action=err&code=${code}`);
}
