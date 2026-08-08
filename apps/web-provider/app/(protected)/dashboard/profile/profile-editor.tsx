'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  PROVIDER_BIO_MAX_LENGTH,
  PROVIDER_PROFILE_TAG_MAX_LENGTH,
  PROVIDER_PROFILE_TAG_REGEX,
  PROVIDER_PROFILE_TAGS_MAX_PER_KIND,
  UpdateProviderProfileRequestSchema,
  type ProviderProfileRecord,
  type UpdateProviderProfileRequest,
} from '@taste-and-see/contracts';
import { useId, useState, useTransition, type KeyboardEvent } from 'react';
import { Controller, useForm } from 'react-hook-form';

import {
  INITIAL_PROFILE_EDITOR_STATE,
  updateProfileAction,
  type ProfileEditorActionState,
} from './actions';

interface ProfileEditorProps {
  readonly profile: ProviderProfileRecord;
}

/**
 * Multi-section profile editor (TS-200; TS-200-followup-3 RHF
 * refactor).
 *
 * Sections:
 *   - Basic info (read-only display name + tier + status; bio
 *     editor with a character counter).
 *   - Specialties (cuisines + dementia-sensitive flag).
 *   - Languages.
 *   - Dietary expertise.
 *
 * Form binding:
 *   - `react-hook-form` + `zodResolver(UpdateProviderProfileRequestSchema)`
 *     gives per-field client-side validation against the same schema
 *     the gateway + downstream service use (CLAUDE.md §8.4).
 *   - The three tag arrays are bound through RHF `Controller` and
 *     edited via a chip-builder UX (Enter/comma to add, Backspace or
 *     click `×` to remove). Replaces the prior comma-separated text
 *     input.
 *   - Submit calls the server action directly with the typed
 *     `UpdateProviderProfileRequest` object — no FormData bridging.
 *     `useTransition` tracks the pending state; the server action's
 *     return value updates the local action-state for inline copy.
 *
 * Validation layers (defence-in-depth):
 *   1. RHF / zodResolver — surfaces field errors inline as the user
 *      types or removes a chip.
 *   2. `updateProfileAction` — re-validates server-side against the
 *      same schema (a tampered client could call the action with any
 *      payload).
 *   3. Gateway + downstream service — strict-mode JSON validation.
 *
 * Senior-mode accessibility:
 *   - Each chip-builder has a labelled `<input>` + a help-text span
 *     announcing the per-tag character cap, the regex shape, and the
 *     max-tags-per-kind limit.
 *   - Chip removal is keyboard-accessible (Backspace on empty input,
 *     or focus the `×` button per chip).
 *   - `aria-live` region near the submit button announces validation
 *     + action-state copy for screen readers.
 */
export function ProfileEditor({ profile }: ProfileEditorProps): React.JSX.Element {
  const [actionState, setActionState] = useState<ProfileEditorActionState>(
    INITIAL_PROFILE_EDITOR_STATE,
  );
  const [isPending, startTransition] = useTransition();

  const form = useForm<UpdateProviderProfileRequest>({
    resolver: zodResolver(UpdateProviderProfileRequestSchema),
    defaultValues: {
      bio: profile.bio,
      languages: [...profile.languages],
      cuisines: [...profile.cuisines],
      dietaryExpertise: [...profile.dietaryExpertise],
      dementiaSensitive: profile.dementiaSensitive,
    },
    mode: 'onBlur',
  });

  const bioValue = form.watch('bio') ?? '';
  const bioLength = bioValue.length;

  const onSubmit = (values: UpdateProviderProfileRequest): void => {
    startTransition(async () => {
      const result = await updateProfileAction({
        providerId: profile.id,
        ifMatch: profile.updatedAt,
        // Normalise empty-string bio to null — the request schema
        // accepts `string | null`; the editor uses an empty string
        // for "no bio" so the textarea remains controlled.
        values: {
          ...values,
          bio: values.bio !== null && values.bio.length > 0 ? values.bio : null,
        },
      });
      setActionState(result);
      if (result.status === 'success') {
        // Re-seed the form with the just-saved values so the dirty
        // state resets and subsequent submits are real diffs.
        form.reset(values);
      }
    });
  };

  return (
    <form
      className="auth-form"
      onSubmit={form.handleSubmit(onSubmit)}
      aria-describedby="profile-form-status"
      noValidate
    >
      <div id="profile-form-status" aria-live="polite">
        {actionState.status === 'error' && actionState.message !== undefined ? (
          <div className="auth-alert" role="alert">
            {actionState.message}
          </div>
        ) : null}
        {actionState.status === 'success' && actionState.message !== undefined ? (
          <div className="auth-alert auth-alert-success" role="status">
            {actionState.message}
          </div>
        ) : null}
      </div>

      <section className="profile-section" aria-labelledby="section-basic">
        <h2 id="section-basic" className="profile-section-heading">
          Basic info
        </h2>
        <dl className="profile-readonly-list">
          <div>
            <dt>Display name</dt>
            <dd>{profile.displayName}</dd>
          </div>
          <div>
            <dt>Tier</dt>
            <dd>{profile.tier}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{profile.status}</dd>
          </div>
        </dl>
        <label htmlFor="bio">
          Bio
          <textarea
            id="bio"
            rows={6}
            maxLength={PROVIDER_BIO_MAX_LENGTH}
            placeholder="Share a few sentences about your cooking, your training, and the families you love serving."
            {...form.register('bio', {
              setValueAs: (raw: unknown) =>
                typeof raw === 'string' && raw.length > 0 ? raw : null,
            })}
          />
          <span className="help">
            {bioLength} / {PROVIDER_BIO_MAX_LENGTH} characters.
            {' Leave blank to clear your bio.'}
          </span>
          {form.formState.errors.bio?.message !== undefined ? (
            <span className="help error">{form.formState.errors.bio.message}</span>
          ) : null}
        </label>
      </section>

      <section className="profile-section" aria-labelledby="section-specialties">
        <h2 id="section-specialties" className="profile-section-heading">
          Specialties
        </h2>
        <Controller
          name="cuisines"
          control={form.control}
          render={({ field, fieldState }) => (
            <ChipInput
              label="Cuisines"
              value={field.value}
              onChange={field.onChange}
              placeholder="italian, jewish-deli, southern-bbq"
              helpText="Add one tag at a time — press Enter or comma. Lowercase letters, digits, `-`, `_`."
              errorMessage={fieldState.error?.message ?? actionState.fieldErrors?.['cuisines']}
            />
          )}
        />
        <label className="profile-checkbox" htmlFor="dementiaSensitive">
          <input id="dementiaSensitive" type="checkbox" {...form.register('dementiaSensitive')} />
          <span>
            <strong>Dementia-sensitive dining</strong>
            <span className="help">
              Mark when you have training to support guests living with dementia.
            </span>
          </span>
        </label>
      </section>

      <section className="profile-section" aria-labelledby="section-languages">
        <h2 id="section-languages" className="profile-section-heading">
          Languages
        </h2>
        <Controller
          name="languages"
          control={form.control}
          render={({ field, fieldState }) => (
            <ChipInput
              label="Languages spoken"
              value={field.value}
              onChange={field.onChange}
              placeholder="en, es, zh-hant-hk"
              helpText="BCP-47 specifiers, lowercase. Press Enter or comma to add."
              errorMessage={fieldState.error?.message ?? actionState.fieldErrors?.['languages']}
            />
          )}
        />
      </section>

      <section className="profile-section" aria-labelledby="section-dietary">
        <h2 id="section-dietary" className="profile-section-heading">
          Dietary expertise
        </h2>
        <Controller
          name="dietaryExpertise"
          control={form.control}
          render={({ field, fieldState }) => (
            <ChipInput
              label="Dietary skills"
              value={field.value}
              onChange={field.onChange}
              placeholder="low-sodium, diabetic-friendly, kosher, dysphagia"
              helpText="Add one tag at a time — press Enter or comma. Lowercase letters, digits, `-`, `_`."
              errorMessage={
                fieldState.error?.message ?? actionState.fieldErrors?.['dietaryExpertise']
              }
            />
          )}
        />
      </section>

      <button type="submit" className="submit" disabled={isPending}>
        {isPending ? 'Saving…' : 'Save profile'}
      </button>
    </form>
  );
}

interface ChipInputProps {
  readonly label: string;
  readonly value: readonly string[];
  readonly onChange: (next: string[]) => void;
  // `exactOptionalPropertyTypes: true` distinguishes "absent" from
  // "explicitly undefined" — call sites pass the latter from RHF /
  // fieldErrors lookups, so the types include `| undefined`.
  readonly placeholder?: string | undefined;
  readonly helpText: string;
  readonly errorMessage?: string | undefined;
}

/**
 * Controlled chip-builder for tag arrays.
 *
 * Add: Enter, comma, or blur with non-empty draft. Each candidate is
 * trim()+toLowerCase()+regex-checked before commit; invalid tokens
 * show an inline error and stay in the draft buffer.
 *
 * Remove: click the `×` button on a chip, or Backspace while the
 * draft input is empty (removes the rightmost chip).
 *
 * Limits: caps at `PROVIDER_PROFILE_TAGS_MAX_PER_KIND` tags; duplicates
 * within the kind are rejected (the server enforces the same via
 * `UNIQUE (provider_id, kind, tag)`).
 *
 * The component is intentionally lean — no drag-reorder, no
 * typeahead suggestions. Tag-suggestion catalogue is TS-200-followup-2.
 */
function ChipInput({
  label,
  value,
  onChange,
  placeholder,
  helpText,
  errorMessage,
}: ChipInputProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;

  const tryCommit = (raw: string): boolean => {
    const tag = raw.trim().toLowerCase();
    if (tag.length === 0) {
      return false;
    }
    if (tag.length > PROVIDER_PROFILE_TAG_MAX_LENGTH) {
      setLocalError(`tag is too long (max ${PROVIDER_PROFILE_TAG_MAX_LENGTH} characters)`);
      return false;
    }
    if (!PROVIDER_PROFILE_TAG_REGEX.test(tag)) {
      setLocalError('tag must be lowercase alphanumeric with optional `-` / `_` separators');
      return false;
    }
    if (value.includes(tag)) {
      setLocalError(`already added: ${tag}`);
      return false;
    }
    if (value.length >= PROVIDER_PROFILE_TAGS_MAX_PER_KIND) {
      setLocalError(`maximum ${PROVIDER_PROFILE_TAGS_MAX_PER_KIND} tags reached`);
      return false;
    }
    setLocalError(null);
    onChange([...value, tag]);
    return true;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (tryCommit(draft)) {
        setDraft('');
      }
      return;
    }
    if (event.key === 'Backspace' && draft.length === 0 && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
      setLocalError(null);
    }
  };

  const handleBlur = (): void => {
    if (draft.length > 0 && tryCommit(draft)) {
      setDraft('');
    }
  };

  const removeAt = (index: number): void => {
    onChange(value.filter((_, i) => i !== index));
    setLocalError(null);
  };

  const displayedError = localError ?? errorMessage;

  return (
    <label htmlFor={inputId}>
      {label}
      <div
        className="profile-chip-row"
        role="group"
        aria-labelledby={inputId}
        aria-describedby={helpId}
      >
        {value.map((tag, index) => (
          <span key={tag} className="profile-chip">
            <span className="profile-chip-text">{tag}</span>
            <button
              type="button"
              className="profile-chip-remove"
              onClick={() => removeAt(index)}
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={inputId}
          type="text"
          className="profile-chip-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (localError !== null) {
              setLocalError(null);
            }
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={value.length === 0 ? placeholder : undefined}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={displayedError !== undefined && displayedError !== null}
          aria-errormessage={displayedError ? errorId : undefined}
          disabled={value.length >= PROVIDER_PROFILE_TAGS_MAX_PER_KIND}
        />
      </div>
      <span id={helpId} className="help">
        {helpText} ({value.length} / {PROVIDER_PROFILE_TAGS_MAX_PER_KIND})
      </span>
      {displayedError !== undefined && displayedError !== null ? (
        <span id={errorId} className="help error">
          {displayedError}
        </span>
      ) : null}
    </label>
  );
}
