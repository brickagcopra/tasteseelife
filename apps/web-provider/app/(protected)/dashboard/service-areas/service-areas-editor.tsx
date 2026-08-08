'use client';

import {
  PROVIDER_SERVICE_AREAS_MAX,
  type ProviderServiceAreaRecord,
} from '@taste-and-see/contracts';
import { useActionState, useState } from 'react';

import {
  INITIAL_SERVICE_AREAS_EDITOR_STATE,
  deleteServiceAreasAction,
  updateServiceAreasAction,
} from './actions';

interface ServiceAreasEditorProps {
  readonly providerId: string;
  readonly serviceAreas: readonly ProviderServiceAreaRecord[];
}

interface AreaDraft {
  readonly id: string;
  label: string;
  polygon: string;
}

const EXAMPLE_POLYGON = `{
  "type": "Polygon",
  "coordinates": [
    [
      [-73.96, 40.77],
      [-73.95, 40.77],
      [-73.95, 40.78],
      [-73.96, 40.78],
      [-73.96, 40.77]
    ]
  ]
}`;

/**
 * Provider service-area editor (TS-202) — Phase-1 GeoJSON-paste shape.
 *
 * Each area is a label + a GeoJSON `Polygon` pasted into a textarea
 * (exported from geojson.io / Mapbox Studio / a GIS tool). Add / remove
 * area rows inline; the server action parses each polygon, validates it
 * against the contract (closed ring, lat/lng bounds, caps), then
 * forwards to the gateway PUT proxy. The server computes the centroid +
 * bounding box.
 *
 * The rich in-browser Mapbox draw widget is deferred to
 * TS-202-followup-1 (needs a frontend mapping-library ADR). Until then
 * this surface is fully functional — a provider can declare, edit, and
 * clear coverage areas — just without the point-and-click map.
 */
export function ServiceAreasEditor({
  providerId,
  serviceAreas,
}: ServiceAreasEditorProps): React.JSX.Element {
  const [updateState, updateFormAction, updatePending] = useActionState(
    updateServiceAreasAction,
    INITIAL_SERVICE_AREAS_EDITOR_STATE,
  );
  const [deleteState, deleteFormAction, deletePending] = useActionState(
    deleteServiceAreasAction,
    INITIAL_SERVICE_AREAS_EDITOR_STATE,
  );

  const [areas, setAreas] = useState<AreaDraft[]>(() =>
    serviceAreas.map((area, index) => ({
      id: `a-${index}`,
      label: area.label ?? '',
      polygon: JSON.stringify(area.polygon, null, 2),
    })),
  );

  const status = deleteState.status === 'idle' ? updateState : deleteState;
  const pending = updatePending || deletePending;

  function addArea(): void {
    if (areas.length >= PROVIDER_SERVICE_AREAS_MAX) return;
    setAreas((prev) => [...prev, { id: `a-${Date.now()}-${prev.length}`, label: '', polygon: '' }]);
  }

  function removeArea(id: string): void {
    setAreas((prev) => prev.filter((a) => a.id !== id));
  }

  function updateArea(id: string, patch: Partial<AreaDraft>): void {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  return (
    <>
      <form
        className="auth-form"
        action={updateFormAction}
        aria-describedby="service-areas-form-status"
      >
        <input type="hidden" name="providerId" value={providerId} />

        <div id="service-areas-form-status" aria-live="polite">
          {status.status === 'error' && status.message !== undefined ? (
            <div className="auth-alert" role="alert">
              {status.message}
            </div>
          ) : null}
          {status.status === 'success' && status.message !== undefined ? (
            <div className="auth-alert auth-alert-success" role="status">
              {status.message}
            </div>
          ) : null}
        </div>

        <section className="profile-section" aria-labelledby="section-areas">
          <h2 id="section-areas" className="profile-section-heading">
            Coverage areas
          </h2>
          <p className="help">
            Tell families where you travel to cook. Add a coverage area for each neighbourhood you
            serve — paste a GeoJSON outline you drew at{' '}
            <a href="https://geojson.io" target="_blank" rel="noreferrer">
              geojson.io
            </a>{' '}
            (a point-and-click map is coming soon). Up to {PROVIDER_SERVICE_AREAS_MAX} areas.
          </p>

          {areas.length === 0 ? (
            <p className="help">
              No coverage areas yet. Click <strong>Add coverage area</strong> to start.
            </p>
          ) : null}

          {areas.map((area, index) => (
            <div key={area.id} className="profile-section">
              <label htmlFor={`label-${area.id}`}>
                Area name (optional)
                <input
                  id={`label-${area.id}`}
                  type="text"
                  name={`areas[${index}].label`}
                  value={area.label}
                  placeholder="e.g. Upper East Side"
                  onChange={(event) => updateArea(area.id, { label: event.target.value })}
                />
              </label>
              <label htmlFor={`polygon-${area.id}`}>
                Coverage outline (GeoJSON Polygon)
                <textarea
                  id={`polygon-${area.id}`}
                  name={`areas[${index}].polygon`}
                  value={area.polygon}
                  rows={8}
                  spellCheck={false}
                  placeholder={EXAMPLE_POLYGON}
                  onChange={(event) => updateArea(area.id, { polygon: event.target.value })}
                />
              </label>
              <button type="button" onClick={() => removeArea(area.id)} className="submit">
                Remove area
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={addArea}
            className="submit"
            disabled={areas.length >= PROVIDER_SERVICE_AREAS_MAX}
          >
            Add coverage area
          </button>
        </section>

        <button type="submit" className="submit" disabled={pending}>
          {updatePending ? 'Saving…' : 'Save coverage areas'}
        </button>
      </form>

      <form action={deleteFormAction} style={{ marginTop: 24 }}>
        <input type="hidden" name="providerId" value={providerId} />
        <p className="help">Want to start over? This removes every coverage area on file.</p>
        <button type="submit" className="submit" disabled={pending}>
          {deletePending ? 'Clearing…' : 'Clear all coverage areas'}
        </button>
      </form>
    </>
  );
}
