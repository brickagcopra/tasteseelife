'use server';

import { revalidatePath } from 'next/cache';
import {
  DeleteProviderServiceAreasResponseSchema,
  PROVIDER_SERVICE_AREAS_MAX,
  PROVIDER_SERVICE_AREA_LABEL_MAX_LENGTH,
  UpdateProviderServiceAreasRequestSchema,
  UpdateProviderServiceAreasResponseSchema,
  type ProviderServiceAreaInput,
} from '@taste-and-see/contracts';
import { z } from 'zod';

import { callGateway } from '@/lib/api';

/**
 * Service-areas-editor server actions (TS-202).
 *
 * Two actions:
 *   - `updateServiceAreasAction` — parses every `areas[i].label` +
 *     `areas[i].polygon` FormData entry (the polygon is a pasted
 *     GeoJSON document), assembles the contract's strict JSON body,
 *     and forwards it to the gateway PUT proxy with an
 *     `Idempotency-Key`.
 *   - `deleteServiceAreasAction` — forwards a DELETE to the gateway
 *     proxy with an `Idempotency-Key`.
 *
 * Phase-1 editor shape (TS-202): the provider pastes a GeoJSON
 * `Polygon` per area (exported from geojson.io, Mapbox Studio, or a
 * GIS tool). The rich in-browser Mapbox draw widget is deferred to
 * TS-202-followup-1 (needs a frontend mapping-library ADR). The action
 * three-layer-validates (client form → THIS action's Zod parse →
 * downstream service) against the same `UpdateProviderServiceAreasRequest`
 * schema the gateway uses — defence-in-depth against a hand-crafted
 * POST.
 */

export interface ServiceAreasEditorActionState {
  readonly status: 'idle' | 'success' | 'error';
  readonly message?: string;
}

export const INITIAL_SERVICE_AREAS_EDITOR_STATE: ServiceAreasEditorActionState = {
  status: 'idle',
};

const ProviderIdSchema = z.string().min(1).max(64);
const LabelSchema = z.string().min(1).max(PROVIDER_SERVICE_AREA_LABEL_MAX_LENGTH);

export async function updateServiceAreasAction(
  _previous: ServiceAreasEditorActionState,
  formData: FormData,
): Promise<ServiceAreasEditorActionState> {
  const providerIdParse = ProviderIdSchema.safeParse(formData.get('providerId'));
  if (!providerIdParse.success) {
    return {
      status: 'error',
      message: 'We could not identify the profile to edit. Please refresh the page.',
    };
  }
  const providerId = providerIdParse.data;

  let serviceAreas: ProviderServiceAreaInput[];
  try {
    serviceAreas = extractServiceAreas(formData);
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Invalid service area.',
    };
  }

  const parsed = UpdateProviderServiceAreasRequestSchema.safeParse({ serviceAreas });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      status: 'error',
      message: first?.message ?? 'Please double-check your coverage areas and try again.',
    };
  }

  const result = await callGateway<unknown>(
    `/api/v1/providers/${encodeURIComponent(providerId)}/service-areas`,
    {
      method: 'PUT',
      body: parsed.data,
      headers: {
        'idempotency-key': `service-areas-${providerId}-${Date.now()}`,
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
      return { status: 'error', message: 'You can only edit your own coverage areas.' };
    }
    if (result.status === 404) {
      return {
        status: 'error',
        message: 'Provider not found. Refresh the page and try again.',
      };
    }
    return { status: 'error', message: 'Please double-check the form and try again.' };
  }
  if (result.kind === 'server_error') {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  const validated = UpdateProviderServiceAreasResponseSchema.safeParse(result.body);
  if (!validated.success) {
    return {
      status: 'error',
      message: 'Areas saved, but we could not refresh the page. Please reload.',
    };
  }

  revalidatePath('/dashboard/service-areas');
  return { status: 'success', message: 'Coverage areas saved.' };
}

export async function deleteServiceAreasAction(
  _previous: ServiceAreasEditorActionState,
  formData: FormData,
): Promise<ServiceAreasEditorActionState> {
  const providerIdParse = ProviderIdSchema.safeParse(formData.get('providerId'));
  if (!providerIdParse.success) {
    return {
      status: 'error',
      message: 'We could not identify the profile to edit. Please refresh the page.',
    };
  }
  const providerId = providerIdParse.data;

  const result = await callGateway<unknown>(
    `/api/v1/providers/${encodeURIComponent(providerId)}/service-areas`,
    {
      method: 'DELETE',
      headers: {
        'idempotency-key': `service-areas-clear-${providerId}-${Date.now()}`,
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
      return { status: 'error', message: 'You can only clear your own coverage areas.' };
    }
    if (result.status === 404) {
      return {
        status: 'error',
        message: 'Provider not found. Refresh the page and try again.',
      };
    }
    return { status: 'error', message: 'Please try again in a moment.' };
  }
  if (result.kind === 'server_error') {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  const validated = DeleteProviderServiceAreasResponseSchema.safeParse(result.body);
  if (!validated.success) {
    return {
      status: 'error',
      message: 'Areas cleared, but we could not refresh the page. Please reload.',
    };
  }

  revalidatePath('/dashboard/service-areas');
  return {
    status: 'success',
    message:
      validated.data.deletedCount === 0
        ? 'You did not have any coverage areas on file.'
        : 'Coverage areas cleared.',
  };
}

/**
 * Parse the indexed `areas[i].label` / `areas[i].polygon` FormData
 * entries into the contract's `ProviderServiceAreaInput[]` shape. The
 * polygon field carries a pasted GeoJSON document as a JSON string;
 * we `JSON.parse` it and hand the structural object to the contract
 * schema for shape validation (closed ring, lat/lng bounds, caps).
 */
function extractServiceAreas(formData: FormData): ProviderServiceAreaInput[] {
  const areas: ProviderServiceAreaInput[] = [];
  for (let i = 0; i < PROVIDER_SERVICE_AREAS_MAX; i++) {
    const labelRaw = formData.get(`areas[${i}].label`);
    const polygonRaw = formData.get(`areas[${i}].polygon`);
    if (labelRaw === null && polygonRaw === null) {
      // No more rows.
      break;
    }
    if (typeof polygonRaw !== 'string' || polygonRaw.trim().length === 0) {
      // Skip an empty row (the user clicked "Add" and never pasted a
      // polygon) — they may have meant to leave it blank.
      continue;
    }

    let polygon: unknown;
    try {
      polygon = JSON.parse(polygonRaw);
    } catch {
      throw new Error(`Area ${i + 1}: the polygon is not valid GeoJSON (JSON parse failed).`);
    }

    let label: string | undefined;
    if (typeof labelRaw === 'string' && labelRaw.trim().length > 0) {
      const labelParse = LabelSchema.safeParse(labelRaw.trim());
      if (!labelParse.success) {
        throw new Error(
          `Area ${i + 1}: the label must be at most ${PROVIDER_SERVICE_AREA_LABEL_MAX_LENGTH} characters.`,
        );
      }
      label = labelParse.data;
    }

    areas.push({
      polygon: polygon as ProviderServiceAreaInput['polygon'],
      ...(label !== undefined && { label }),
    });
  }
  return areas;
}
