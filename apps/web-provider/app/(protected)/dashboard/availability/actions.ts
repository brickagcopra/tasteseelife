'use server';

import { revalidatePath } from 'next/cache';
import {
  DeleteProviderAvailabilityResponseSchema,
  PROVIDER_AVAILABILITY_DATE_REGEX,
  PROVIDER_AVAILABILITY_EXCEPTIONS_MAX,
  PROVIDER_AVAILABILITY_TIME_REGEX,
  PROVIDER_AVAILABILITY_WEEKDAY_VALUES,
  PROVIDER_AVAILABILITY_WINDOWS_MAX,
  UpdateProviderAvailabilityRequestSchema,
  UpdateProviderAvailabilityResponseSchema,
  type ProviderAvailabilityException,
  type ProviderAvailabilityWeekday,
  type ProviderAvailabilityWindow,
} from '@taste-and-see/contracts';
import { z } from 'zod';

import { callGateway } from '@/lib/api';

/**
 * Availability-editor server actions (TS-203).
 *
 * Two actions:
 *   - `updateAvailabilityAction` — parses every `windows[i].*` and
 *     `exceptions[i].*` FormData entry, normalises the shape into the
 *     contract's strict JSON body, and forwards it to the gateway
 *     PUT proxy with an `Idempotency-Key`.
 *   - `deleteAvailabilityAction` — forwards a DELETE to the gateway
 *     proxy with an `Idempotency-Key`.
 *
 * Validation lives on three levels (mirrors the TS-200 profile
 * editor):
 *   1. The client editor surfaces inline UI hints as the user types.
 *   2. THIS action parses the FormData with the same Zod schema the
 *      gateway uses — defence-in-depth against a hand-crafted POST.
 *   3. The gateway re-validates with the same schema and forwards a
 *      strict JSON body to the downstream.
 */

export interface AvailabilityEditorActionState {
  readonly status: 'idle' | 'success' | 'error';
  readonly message?: string;
}

export const INITIAL_AVAILABILITY_EDITOR_STATE: AvailabilityEditorActionState = {
  status: 'idle',
};

const ProviderIdSchema = z.string().min(1).max(64);

const WeekdaySchema = z.enum(PROVIDER_AVAILABILITY_WEEKDAY_VALUES);
const TimeSchema = z.string().regex(PROVIDER_AVAILABILITY_TIME_REGEX);
const DateSchema = z.string().regex(PROVIDER_AVAILABILITY_DATE_REGEX);

export async function updateAvailabilityAction(
  _previous: AvailabilityEditorActionState,
  formData: FormData,
): Promise<AvailabilityEditorActionState> {
  const providerIdParse = ProviderIdSchema.safeParse(formData.get('providerId'));
  if (!providerIdParse.success) {
    return {
      status: 'error',
      message: 'We could not identify the profile to edit. Please refresh the page.',
    };
  }
  const providerId = providerIdParse.data;

  let windows: ProviderAvailabilityWindow[];
  try {
    windows = extractWindows(formData);
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Invalid schedule entry.',
    };
  }

  let exceptions: ProviderAvailabilityException[];
  try {
    exceptions = extractExceptions(formData);
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Invalid blackout date.',
    };
  }

  const parsed = UpdateProviderAvailabilityRequestSchema.safeParse({
    windows,
    exceptions,
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      status: 'error',
      message: first?.message ?? 'Please double-check your schedule and try again.',
    };
  }

  const result = await callGateway<unknown>(
    `/api/v1/providers/${encodeURIComponent(providerId)}/availability`,
    {
      method: 'PUT',
      body: parsed.data,
      headers: {
        'idempotency-key': `availability-${providerId}-${Date.now()}`,
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
        message: 'You can only edit your own availability.',
      };
    }
    if (result.status === 404) {
      return {
        status: 'error',
        message: 'Provider not found. Refresh the page and try again.',
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

  const validated = UpdateProviderAvailabilityResponseSchema.safeParse(result.body);
  if (!validated.success) {
    return {
      status: 'error',
      message: 'Schedule saved, but we could not refresh the page. Please reload.',
    };
  }

  revalidatePath('/dashboard/availability');
  return {
    status: 'success',
    message: 'Schedule saved.',
  };
}

export async function deleteAvailabilityAction(
  _previous: AvailabilityEditorActionState,
  formData: FormData,
): Promise<AvailabilityEditorActionState> {
  const providerIdParse = ProviderIdSchema.safeParse(formData.get('providerId'));
  if (!providerIdParse.success) {
    return {
      status: 'error',
      message: 'We could not identify the profile to edit. Please refresh the page.',
    };
  }
  const providerId = providerIdParse.data;

  const result = await callGateway<unknown>(
    `/api/v1/providers/${encodeURIComponent(providerId)}/availability`,
    {
      method: 'DELETE',
      headers: {
        'idempotency-key': `availability-clear-${providerId}-${Date.now()}`,
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
        message: 'You can only clear your own availability.',
      };
    }
    if (result.status === 404) {
      return {
        status: 'error',
        message: 'Provider not found. Refresh the page and try again.',
      };
    }
    return {
      status: 'error',
      message: 'Please try again in a moment.',
    };
  }
  if (result.kind === 'server_error') {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  const validated = DeleteProviderAvailabilityResponseSchema.safeParse(result.body);
  if (!validated.success) {
    return {
      status: 'error',
      message: 'Schedule cleared, but we could not refresh the page. Please reload.',
    };
  }

  revalidatePath('/dashboard/availability');
  return {
    status: 'success',
    message:
      validated.data.deletedWindowCount === 0 && validated.data.deletedExceptionCount === 0
        ? 'You did not have any schedule on file.'
        : 'Schedule cleared.',
  };
}

function extractWindows(formData: FormData): ProviderAvailabilityWindow[] {
  const windows: ProviderAvailabilityWindow[] = [];
  for (let i = 0; i < PROVIDER_AVAILABILITY_WINDOWS_MAX; i++) {
    const weekdayRaw = formData.get(`windows[${i}].weekday`);
    const startRaw = formData.get(`windows[${i}].startTime`);
    const endRaw = formData.get(`windows[${i}].endTime`);
    if (weekdayRaw === null && startRaw === null && endRaw === null) {
      // No more rows.
      break;
    }
    const weekdayParse = WeekdaySchema.safeParse(weekdayRaw);
    const startParse = TimeSchema.safeParse(startRaw);
    const endParse = TimeSchema.safeParse(endRaw);
    if (!weekdayParse.success) {
      throw new Error(`Window ${i + 1}: weekday is required`);
    }
    if (!startParse.success) {
      throw new Error(`Window ${i + 1}: start time must be HH:MM`);
    }
    if (!endParse.success) {
      throw new Error(`Window ${i + 1}: end time must be HH:MM`);
    }
    const window: { weekday: ProviderAvailabilityWeekday; startTime: string; endTime: string } = {
      weekday: weekdayParse.data,
      startTime: startParse.data,
      endTime: endParse.data,
    };
    windows.push(window);
  }
  return windows;
}

function extractExceptions(formData: FormData): ProviderAvailabilityException[] {
  const exceptions: ProviderAvailabilityException[] = [];
  for (let i = 0; i < PROVIDER_AVAILABILITY_EXCEPTIONS_MAX; i++) {
    const dateRaw = formData.get(`exceptions[${i}].date`);
    if (dateRaw === null) break;
    if (typeof dateRaw !== 'string' || dateRaw.trim().length === 0) {
      // Skip an empty row (the user clicked "Add" and never filled
      // it in) — they may have meant to leave it blank.
      continue;
    }
    const parsed = DateSchema.safeParse(dateRaw);
    if (!parsed.success) {
      throw new Error(`Blackout date ${i + 1}: must be YYYY-MM-DD`);
    }
    exceptions.push({ date: parsed.data });
  }
  return exceptions;
}
