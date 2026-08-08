'use server';

import { revalidatePath } from 'next/cache';
import {
  UpdateProviderPricingRequestSchema,
  UpdateProviderPricingResponseSchema,
  type UpdateProviderPricingRequest,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Pricing-editor server action (TS-204).
 *
 * Forwards a typed `UpdateProviderPricingRequest` to the gateway proxy
 * `PUT /api/v1/providers/:providerId/pricing`. The client form validates
 * the same shape before calling; this action re-validates server-side as
 * defence-in-depth (a tampered client could call it with any payload).
 *
 * Failure modes:
 *   - 403 → "you can only edit your own pricing"
 *   - 404 → "pricing not found" — reload
 *   - 412 → optimistic-concurrency mismatch (mirrors TS-200-followup-5)
 *   - 422 → out-of-band rate or unsupported currency (surfaces the
 *           downstream `detail` so the provider sees the allowed range)
 *   - 5xx / network → generic retry copy
 *
 * On success the action revalidates the pricing page cache so the next
 * render reads the fresh snapshot (including the bumped `updatedAt`
 * the If-Match token rides on).
 */

export interface PricingEditorActionState {
  readonly status: 'idle' | 'success' | 'error';
  readonly message?: string;
}

export const INITIAL_PRICING_EDITOR_STATE: PricingEditorActionState = { status: 'idle' };

export interface UpdatePricingActionInput {
  readonly providerId: string;
  /**
   * The snapshot's `updatedAt` ISO timestamp, forwarded as
   * `If-Match: "<updatedAt>"`. `null` skips the precondition check.
   */
  readonly ifMatch: string | null;
  readonly values: UpdateProviderPricingRequest;
}

export async function updatePricingAction(
  input: UpdatePricingActionInput,
): Promise<PricingEditorActionState> {
  if (typeof input.providerId !== 'string' || input.providerId.length === 0) {
    return {
      status: 'error',
      message: 'We could not identify the profile to edit. Please refresh the page.',
    };
  }

  const parsed = UpdateProviderPricingRequestSchema.safeParse(input.values);
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Please enter a valid hourly rate and try again.',
    };
  }

  const result = await callGateway<unknown>(
    `/api/v1/providers/${encodeURIComponent(input.providerId)}/pricing`,
    {
      method: 'PUT',
      body: parsed.data,
      headers: {
        'idempotency-key': `pricing-${input.providerId}-${Date.now()}`,
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
    return { status: 'error', message: 'Your session has expired. Please sign in again.' };
  }
  if (result.kind === 'client_error') {
    if (result.status === 403) {
      return { status: 'error', message: 'You can only edit your own provider pricing.' };
    }
    if (result.status === 404) {
      return { status: 'error', message: 'Pricing not found. Refresh the page and try again.' };
    }
    if (result.status === 412) {
      revalidatePath('/dashboard/pricing');
      return {
        status: 'error',
        message:
          'Your pricing was updated elsewhere while you were editing. Please reload to see the latest version, then re-apply your change.',
      };
    }
    if (result.status === 422) {
      return { status: 'error', message: extractDetail(result.body) };
    }
    return { status: 'error', message: 'Please double-check the form and try again.' };
  }
  if (result.kind === 'server_error') {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  const responseParse = UpdateProviderPricingResponseSchema.safeParse(result.body);
  if (!responseParse.success) {
    return {
      status: 'error',
      message: 'Rate saved, but we could not refresh the page. Please reload.',
    };
  }

  revalidatePath('/dashboard/pricing');
  return { status: 'success', message: 'Your hourly rate has been saved.' };
}

/**
 * Pull the RFC 7807 `detail` string off a downstream problem-details
 * body so the 422 (out-of-band / unsupported-currency) message reaches
 * the provider verbatim. Falls back to a generic line when the body
 * isn't shaped as expected.
 */
function extractDetail(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.length > 0) {
      return detail;
    }
  }
  return 'That rate is outside the allowed range for your tier. Please adjust it and try again.';
}
