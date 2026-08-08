'use server';

import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';

import { CreateDataSubjectRequestSchema } from '@taste-and-see/contracts';

import { setFlash } from '@/lib/flash';
import { filePrivacyRequest, withdrawPrivacyRequest } from '@/lib/privacy-api';

/**
 * Privacy Center server actions (TS-309d).
 *
 * Two acts, and the interesting one is the first: turning a form into a
 * request that names either the person filling it in or somebody they care
 * for. The form models "about" as a single select whose value is either `me`
 * or a senior id, because asking someone to pick a "subject kind" and then an
 * id is asking them to learn our data model. The action translates:
 *
 *   `me`         → no subject fields at all — the contract reads their absence
 *                  as "me", and stamps the subject from the verified token
 *                  rather than from anything the browser said.
 *   a senior id  → `subjectKind: 'senior'` + that id, which the service marks
 *                  NOT self-service, leaving it at `received` until a human
 *                  establishes the requester may act for that senior.
 *
 * Never send `subjectKind: 'user'` with the caller's own id: it would be the
 * same request expressed as though somebody else's, and it would sit in a
 * queue waiting for a verification the session already provides.
 */

const PAGE = '/privacy';

export async function filePrivacyRequestAction(formData: FormData): Promise<void> {
  const kind = readString(formData, 'kind');
  const about = readString(formData, 'about');
  const note = readString(formData, 'note');

  const subject =
    about === '' || about === 'me' ? {} : { subjectKind: 'senior' as const, subjectId: about };

  const validated = CreateDataSubjectRequestSchema.safeParse({
    kind,
    ...subject,
    ...(note === '' ? {} : { note }),
  });
  if (!validated.success) {
    await setFlash({ kind: 'error', code: 'privacy.invalid' });
    redirect(PAGE);
  }

  const result = await filePrivacyRequest(validated.data, `privacy-request-${randomUUID()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'mfa_required') {
    // Not a generic failure: the person did nothing wrong, and the page has
    // specific copy for it. A token can go stale between render and submit, so
    // this branch stays live even though the page pre-checks.
    await setFlash({ kind: 'error', code: 'privacy.mfa_required' });
    redirect(PAGE);
  }
  if (result.kind === 'conflict') {
    await setFlash({ kind: 'error', code: 'privacy.duplicate' });
    redirect(PAGE);
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'privacy.failed' });
    redirect(PAGE);
  }

  redirect(`${PAGE}?filed=${encodeURIComponent(result.request.id)}`);
}

export async function withdrawPrivacyRequestAction(formData: FormData): Promise<void> {
  const requestId = readString(formData, 'requestId');
  if (requestId === '') {
    await setFlash({ kind: 'error', code: 'privacy.invalid' });
    redirect(PAGE);
  }

  const result = await withdrawPrivacyRequest(requestId, `privacy-withdraw-${randomUUID()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'not_found') {
    // The service answers 404 for someone else's request as well as for one
    // that never existed — deliberately, since confirming existence is itself
    // a disclosure. The portal must not narrow that back down.
    await setFlash({ kind: 'error', code: 'privacy.not_found' });
    redirect(PAGE);
  }
  if (result.kind === 'conflict') {
    await setFlash({ kind: 'error', code: 'privacy.already_closed' });
    redirect(PAGE);
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'privacy.failed' });
    redirect(PAGE);
  }

  redirect(`${PAGE}?withdrawn=${encodeURIComponent(result.request.id)}`);
}

function readString(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}
