'use server';

import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';

import { CreateDataSubjectRequestSchema } from '@taste-and-see/contracts';

import { filePrivacyRequest, withdrawPrivacyRequest } from '@/lib/privacy-api';

const PAGE_PATH = '/privacy';

/** Error codes surfaced back to the page via `?action=err&code=`. */
export type PrivacyErrorCode =
  | 'invalid'
  | 'mfa_required'
  | 'duplicate'
  | 'not_found'
  | 'already_closed'
  | 'failed';

/**
 * Privacy Center server actions — provider portal (TS-309d).
 *
 * Errors funnel through `?action=err&code=` rather than a flash cookie: the
 * provider portal has no flash channel (the TS-301b convention).
 *
 * **Only the self-service path is offered here.** A provider asking about
 * their own ACCOUNT is `subjectKind` absent — the contract reads that as "me"
 * and the service stamps the subject from the verified token. A provider
 * asking about their provider-directory PROFILE is a different subject
 * (`subjectKind: 'provider'`, keyed by provider id, which lives in another
 * service's schema), and identity cannot establish that this user is that
 * provider without a cross-service call it is not allowed to make
 * (CLAUDE.md §2.3). Rather than file a request that would sit unverified,
 * this surface asks about the account and the profile question is carved to a
 * followup. The page says so plainly instead of pretending the distinction
 * does not exist.
 */
export async function filePrivacyRequestAction(formData: FormData): Promise<void> {
  const kind = readString(formData, 'kind');
  const note = readString(formData, 'note');

  const validated = CreateDataSubjectRequestSchema.safeParse({
    kind,
    ...(note === '' ? {} : { note }),
  });
  if (!validated.success) {
    redirectWithError('invalid');
  }

  const result = await filePrivacyRequest(validated.data, `privacy-request-${randomUUID()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'mfa_required') {
    redirectWithError('mfa_required');
  }
  if (result.kind === 'conflict') {
    redirectWithError('duplicate');
  }
  if (result.kind !== 'ok') {
    redirectWithError('failed');
  }

  redirect(`${PAGE_PATH}?filed=${encodeURIComponent(result.request.id)}`);
}

export async function withdrawPrivacyRequestAction(formData: FormData): Promise<void> {
  const requestId = readString(formData, 'requestId');
  if (requestId === '') {
    redirectWithError('invalid');
  }

  const result = await withdrawPrivacyRequest(requestId, `privacy-withdraw-${randomUUID()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'not_found') {
    redirectWithError('not_found');
  }
  if (result.kind === 'conflict') {
    redirectWithError('already_closed');
  }
  if (result.kind !== 'ok') {
    redirectWithError('failed');
  }

  redirect(`${PAGE_PATH}?withdrawn=${encodeURIComponent(result.request.id)}`);
}

function redirectWithError(code: PrivacyErrorCode): never {
  redirect(`${PAGE_PATH}?action=err&code=${code}`);
}

function readString(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}
