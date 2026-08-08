'use server';

import { revalidatePath } from 'next/cache';
import {
  UpdateProviderProfileRequestSchema,
  UpdateProviderProfileResponseSchema,
  type UpdateProviderProfileRequest,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Profile-editor server action (TS-200; TS-200-followup-3 refactor).
 *
 * Forwards a typed `UpdateProviderProfileRequest` payload to the
 * gateway proxy `PUT /api/v1/providers/:providerId/profile`. The
 * client-side RHF form (`profile-editor.tsx`) validates the payload
 * with the same Zod schema and calls this action directly with the
 * parsed object — server actions in Next 15 accept arbitrary
 * serialisable arguments. The action re-validates as
 * defence-in-depth (a hand-crafted call from a tampered client
 * could bypass the RHF resolver).
 *
 * Three-layer validation:
 *
 *   1. Client form — `useForm({ resolver: zodResolver(...) })` rejects
 *      invalid input before the submit button enables, surfacing
 *      per-field errors as the user types.
 *   2. THIS action — `UpdateProviderProfileRequestSchema.safeParse`
 *      runs server-side against the exact shape sent over the wire.
 *   3. Gateway / downstream service — re-validates the strict JSON
 *      body and rejects on drift.
 *
 * Failure modes:
 *   - validation error → field-scoped error (rare; RHF should have
 *     caught it client-side)
 *   - 400 → "please double-check the form"
 *   - 403 → "you can only edit your own profile"
 *   - 404 → "profile not found" — the editor refreshes
 *   - 412 → optimistic-concurrency mismatch (TS-200-followup-5) —
 *     prompt to reload the snapshot
 *   - 5xx / network → generic retry copy
 *
 * On success the action revalidates the dashboard cache so the
 * next-visit dashboard reads the fresh snapshot.
 */

export interface ProfileEditorActionState {
  readonly status: 'idle' | 'success' | 'error';
  readonly message?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

export const INITIAL_PROFILE_EDITOR_STATE: ProfileEditorActionState = {
  status: 'idle',
};

export interface UpdateProfileActionInput {
  readonly providerId: string;
  /**
   * The `updatedAt` ISO timestamp from the snapshot used to render
   * the editor. Forwarded as `If-Match: "<updatedAt>"`. A `null`
   * value (e.g. test fixture) skips the precondition check.
   */
  readonly ifMatch: string | null;
  readonly values: UpdateProviderProfileRequest;
}

export async function updateProfileAction(
  input: UpdateProfileActionInput,
): Promise<ProfileEditorActionState> {
  if (typeof input.providerId !== 'string' || input.providerId.length === 0) {
    return {
      status: 'error',
      message: 'We could not identify the profile to edit. Please refresh the page.',
    };
  }

  const parsed = UpdateProviderProfileRequestSchema.safeParse(input.values);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path[0];
      if (typeof path === 'string' && fieldErrors[path] === undefined) {
        fieldErrors[path] = issue.message;
      }
    }
    return {
      status: 'error',
      message: 'Please double-check the form and try again.',
      fieldErrors,
    };
  }

  const result = await callGateway<unknown>(
    `/api/v1/providers/${encodeURIComponent(input.providerId)}/profile`,
    {
      method: 'PUT',
      body: parsed.data,
      headers: {
        // Server actions retry deterministically on transient
        // failures; the Idempotency-Key collapses any retried
        // submission against the cached upstream response.
        'idempotency-key': `profile-${input.providerId}-${Date.now()}`,
        // TS-200-followup-5: stamp `If-Match` with the snapshot's
        // `updatedAt` so a concurrent edit (other tab / admin) gets
        // a 412 instead of being silently overwritten. Quoted per
        // RFC 7232 ETag shape — the downstream accepts both quoted
        // and unquoted forms.
        ...(input.ifMatch !== null &&
          input.ifMatch.length > 0 && { 'if-match': `"${input.ifMatch}"` }),
      },
    },
  );

  if (result.kind === 'network_error') {
    return {
      status: 'error',
      message: 'We could not reach the service. Please try again in a moment.',
    };
  }
  if (result.kind === 'unauthorized') {
    return {
      status: 'error',
      message: 'Your session has expired. Please sign in again.',
    };
  }
  if (result.kind === 'client_error') {
    if (result.status === 403) {
      return {
        status: 'error',
        message: 'You can only edit your own provider profile.',
      };
    }
    if (result.status === 404) {
      return {
        status: 'error',
        message: 'Profile not found. Refresh the page and try again.',
      };
    }
    if (result.status === 412) {
      // TS-200-followup-5: another tab / admin saved a change in
      // between this page-load and this submit. Revalidate so the
      // next render picks up the latest snapshot.
      revalidatePath('/dashboard/profile');
      return {
        status: 'error',
        message:
          'Your profile was updated elsewhere while you were editing. Please reload to see the latest version, then re-apply your changes.',
      };
    }
    return {
      status: 'error',
      message: 'Please double-check the form and try again.',
    };
  }
  if (result.kind === 'server_error') {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  // Validate the response shape so a future drift between the
  // gateway + the contract surfaces at the action layer with a
  // useful message rather than crashing the page.
  const responseParse = UpdateProviderProfileResponseSchema.safeParse(result.body);
  if (!responseParse.success) {
    return {
      status: 'error',
      message: 'Profile saved, but we could not refresh the page. Please reload.',
    };
  }

  revalidatePath('/dashboard/profile');
  return {
    status: 'success',
    message: 'Profile saved.',
  };
}
