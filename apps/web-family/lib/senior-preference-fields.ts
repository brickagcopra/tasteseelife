/**
 * Curated senior-preference field catalog (TS-214).
 *
 * `senior_preferences` is an open key/value store — the contract accepts
 * any snake_case key. This catalog is the family-portal's GUIDED view of
 * it: a fixed set of warm, plain-language prompts grouped into the four
 * categories PRD §6.1 / §6.3 + the TS-214 acceptance name (food & dietary
 * preferences, culture & traditions, language & communication,
 * companionship & comfort). The vocabulary is deliberately presentation
 * config (not a contract) so we can add prompts without a backend deploy.
 *
 * Both the editor page (renders the fields) and the save action (builds
 * the bulk-upsert entries) import this module so the canonical key set
 * is single-sourced — the action only ever touches these keys, leaving
 * any custom keys a future free-form editor (TS-214-followup-2) might add
 * untouched (the PATCH is merge-semantics).
 *
 * Every key conforms to the contract's `^[a-z][a-z0-9_]*$` floor.
 *
 * NB: clinical / safety data (allergies, DOB, dementia STAGE, mobility)
 * is NOT here — that lives in the encrypted senior intake (TS-031). These
 * are warmth-and-memory cues a chef uses to connect, not medical facts.
 */

export interface SeniorPreferenceField {
  /** snake_case preference key persisted to `senior_preferences`. */
  readonly key: string;
  readonly label: string;
  readonly helper: string;
  readonly placeholder: string;
}

export interface SeniorPreferenceSection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly fields: readonly SeniorPreferenceField[];
}

export const SENIOR_PREFERENCE_SECTIONS: readonly SeniorPreferenceSection[] = [
  {
    id: 'food',
    title: 'Food & dietary preferences',
    description:
      'The dishes that mean something — and the everyday preferences a chef should cook around.',
    fields: [
      {
        key: 'favorite_dish',
        label: 'Favourite dish',
        helper: 'The meal they light up for.',
        placeholder: 'e.g. Kielbasa and sauerkraut, the way their mother made it.',
      },
      {
        key: 'comfort_food',
        label: 'Comfort food',
        helper: 'What they reach for on a hard day.',
        placeholder: 'e.g. Chicken soup, always with extra dill.',
      },
      {
        key: 'foods_to_avoid',
        label: "Foods they'd rather skip",
        helper:
          'Dislikes and preferences — not allergies. (Allergies and medical needs belong in the health intake.)',
        placeholder: 'e.g. Not a fan of anything too spicy; dislikes mushrooms.',
      },
      {
        key: 'dietary_notes',
        label: 'Dietary notes',
        helper: 'Texture, portion, or preparation notes a chef should know.',
        placeholder: 'e.g. Prefers smaller portions; softer textures are easier to enjoy.',
      },
    ],
  },
  {
    id: 'culture',
    title: 'Culture & traditions',
    description: 'Heritage, regional roots, and the food that carries memory.',
    fields: [
      {
        key: 'cultural_background',
        label: 'Cultural background',
        helper: 'Heritage and the cuisines that go with it.',
        placeholder: 'e.g. Polish on her mother’s side; grew up around Eastern-European cooking.',
      },
      {
        key: 'regional_tradition',
        label: 'Regional traditions',
        helper: 'Where they grew up and the food that means home.',
        placeholder: 'e.g. Pittsburgh — pierogi every Christmas Eve.',
      },
      {
        key: 'holiday_traditions',
        label: 'Holiday traditions',
        helper: 'The dishes that mark the year.',
        placeholder: 'e.g. Easter babka; a big Sunday roast on birthdays.',
      },
      {
        key: 'family_food_story',
        label: 'A family food story',
        helper: 'A memory worth carrying to the table.',
        placeholder:
          'e.g. She learned to fold pierogi the summer her grandmother stayed with the family.',
      },
    ],
  },
  {
    id: 'language',
    title: 'Language & communication',
    description: 'How they like to be spoken with at the table.',
    fields: [
      {
        key: 'preferred_language',
        label: 'Preferred language',
        helper: "The language they're most comfortable in.",
        placeholder: 'e.g. Polish; understands English well but prefers Polish for warmth.',
      },
      {
        key: 'conversation_topics',
        label: 'Favourite conversation topics',
        helper: 'What gets them talking.',
        placeholder: 'e.g. Her garden, old films, and her grandchildren.',
      },
    ],
  },
  {
    id: 'companionship',
    title: 'Companionship & comfort',
    description:
      'The rhythms and gentle cues that make a visit feel easy — especially on harder days.',
    fields: [
      {
        key: 'mealtime_routine',
        label: 'Mealtime routine',
        helper: 'When and how they like to eat.',
        placeholder: 'e.g. Likes lunch at noon, the radio on, and a cup of tea afterwards.',
      },
      {
        key: 'calming_approach',
        label: 'What helps on tough days',
        helper: 'Approaches that soothe and reassure.',
        placeholder: 'e.g. A slow pace and a familiar song settle her when she’s anxious.',
      },
      {
        key: 'music_preference',
        label: 'Music they love',
        helper: 'Sets the mood at the table.',
        placeholder: 'e.g. Chopin, and big-band records from the 1940s.',
      },
      {
        key: 'topics_to_avoid',
        label: 'Topics to gently avoid',
        helper: 'Subjects that unsettle them.',
        placeholder: 'e.g. Avoid talking about the move out of the family home.',
      },
    ],
  },
];

/** Flat list of every curated key — the only keys the save action touches. */
export const SENIOR_PREFERENCE_KEYS: readonly string[] = SENIOR_PREFERENCE_SECTIONS.flatMap(
  (section) => section.fields.map((field) => field.key),
);
