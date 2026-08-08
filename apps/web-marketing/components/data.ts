/**
 * Marketing-page content. Pulled out so each section component takes data
 * as a prop and stays testable in isolation. Mirrors the design's data.jsx.
 */

export type ServiceColor = 'clay' | 'sage' | 'espresso';

export interface Service {
  readonly id: 'chef' | 'companion' | 'caregiver' | 'concierge';
  readonly name: string;
  readonly tag: string;
  readonly summary: string;
  readonly bullets: readonly string[];
  readonly visit: string;
  readonly color: ServiceColor;
  readonly index: '01' | '02' | '03' | '04';
}

export const SERVICES: readonly Service[] = [
  {
    id: 'chef',
    name: 'In-Home Chef',
    tag: 'Culinary',
    summary:
      'A professionally trained chef plans, shops, cooks, and stocks the week — built around your loved one’s tastes, textures, and dietary plan.',
    bullets: [
      'Weekly menus from a registered dietitian',
      'Texture-modified, low-sodium, diabetic, renal',
      'Dementia & cognitive-care trained chefs',
      'Family receives every menu before the visit',
    ],
    visit: '3–5 hr visit, 1–3x weekly',
    color: 'clay',
    index: '01',
  },
  {
    id: 'companion',
    name: 'Culinary Companion',
    tag: 'Connection',
    summary:
      'A warm, screened companion who cooks together, sets the table, and shares the meal — turning lunch into the highlight of the day.',
    bullets: [
      'Two-hour shared meal & conversation',
      'Cooks alongside, never instead',
      'Light tidying & dish reset',
      'Story-keeping notes for family',
    ],
    visit: '2 hr visit, 1–3x weekly',
    color: 'sage',
    index: '02',
  },
  {
    id: 'caregiver',
    name: 'Aging-in-Place Caregiver',
    tag: 'Wellness',
    summary:
      'Certified caregivers extend the visit beyond the table — medication reminders, gentle mobility, hygiene support, and a careful set of eyes.',
    bullets: [
      'CNA / HHA credentialed only',
      'Medication & vitals check-in',
      'Mobility & bathing assistance',
      'Care notes synced to the family app',
    ],
    visit: '4–12 hr shifts',
    color: 'espresso',
    index: '03',
  },
  {
    id: 'concierge',
    name: 'Lifestyle Concierge',
    tag: 'Logistics',
    summary:
      'The quiet hand that handles the rest — grocery sourcing, market runs, hairdresser appointments, garden tending, and the everyday small things.',
    bullets: [
      'Local-market sourcing & errands',
      'Appointment & transport coordination',
      'Home-keeping rituals',
      'Holiday & special-occasion planning',
    ],
    visit: 'Hourly, on demand',
    color: 'clay',
    index: '04',
  },
];

export interface Step {
  readonly n: '01' | '02' | '03' | '04';
  readonly title: string;
  readonly body: string;
}

export const STEPS: readonly Step[] = [
  {
    n: '01',
    title: 'A conversation',
    body: 'A 30-minute call with our care lead. We learn about your loved one — what they grew up eating, what they avoid, and how they like to be cared for.',
  },
  {
    n: '02',
    title: 'A care plan',
    body: 'Our dietitian and care team draft a weekly rhythm: meals, companionship visits, wellness check-ins. Approve, edit, or rebuild it together.',
  },
  {
    n: '03',
    title: 'Your team',
    body: 'We match a small, consistent team — one chef, one or two companions — so your loved one sees familiar faces, not a rotating roster.',
  },
  {
    n: '04',
    title: 'Quiet, ongoing care',
    body: 'Each visit ends with a story note, a photo of the table, and any health observations. You see everything, anytime, in the family app.',
  },
];

export interface Meal {
  readonly kind: string;
  readonly name: string;
}

export interface Day {
  readonly day: string;
  readonly date: string;
  readonly visit: string;
  readonly meals: readonly Meal[];
  readonly note: string;
}

export const WEEK: readonly Day[] = [
  {
    day: 'Mon',
    date: 'Apr 21',
    visit: 'Chef · morning',
    meals: [
      { kind: 'Breakfast', name: 'Soft-baked oats with stewed apricots & cardamom' },
      { kind: 'Lunch', name: 'Lemon-herb chicken with spring peas & farro' },
      { kind: 'Dinner', name: 'Salmon en papillote, leeks & soft potatoes' },
    ],
    note: 'Low sodium · high protein',
  },
  {
    day: 'Tue',
    date: 'Apr 22',
    visit: 'Companion · lunch',
    meals: [
      { kind: 'Breakfast', name: 'Soft-scrambled eggs, sourdough toast, fig jam' },
      { kind: 'Lunch (shared)', name: 'Tomato bisque with grilled cheese soldiers' },
      { kind: 'Dinner', name: 'Chef-prepped — chicken & rice congee, scallion oil' },
    ],
    note: 'Companion visit · 11–1',
  },
  {
    day: 'Wed',
    date: 'Apr 23',
    visit: 'Caregiver · afternoon',
    meals: [
      { kind: 'Breakfast', name: 'Greek yogurt, honey-roast pear, walnut crumble' },
      { kind: 'Lunch', name: 'White-bean soup, rosemary olive oil, country bread' },
      { kind: 'Dinner', name: 'Cod with brown butter, soft polenta, dill' },
    ],
    note: 'Vitals · medication review',
  },
  {
    day: 'Thu',
    date: 'Apr 24',
    visit: 'Chef · morning',
    meals: [
      { kind: 'Breakfast', name: 'Buckwheat pancakes, blueberry compote' },
      { kind: 'Lunch', name: 'Cauliflower-leek soup, gruyère toast' },
      { kind: 'Dinner', name: 'Braised short rib, mash, glazed carrots' },
    ],
    note: 'Comfort menu',
  },
  {
    day: 'Fri',
    date: 'Apr 25',
    visit: 'Companion · dinner',
    meals: [
      { kind: 'Breakfast', name: 'French toast, maple, cinnamon-stewed plums' },
      { kind: 'Lunch', name: 'Tuna niçoise, soft eggs, haricot verts' },
      { kind: 'Dinner (shared)', name: 'Hand-rolled gnocchi, brown-butter sage' },
    ],
    note: 'Friday supper ritual',
  },
  {
    day: 'Sat',
    date: 'Apr 26',
    visit: 'Concierge · morning',
    meals: [
      { kind: 'Breakfast', name: 'Soft-boiled egg, brioche soldiers, citrus' },
      { kind: 'Lunch', name: 'Saturday market salad, roast chicken' },
      { kind: 'Dinner', name: 'Chef-prepped — mushroom risotto, spring herbs' },
    ],
    note: 'Market run · hairdresser',
  },
  {
    day: 'Sun',
    date: 'Apr 27',
    visit: 'Family day',
    meals: [
      { kind: 'Breakfast', name: 'Family pantry — yogurt, granola, fruit' },
      { kind: 'Lunch', name: 'Chef-prepped — roast pork, apple slaw, focaccia' },
      { kind: 'Dinner', name: 'Family pantry — leftovers & chamomile tea' },
    ],
    note: 'No visit · fully stocked',
  },
];

export interface Chef {
  readonly name: string;
  readonly role: string;
  readonly where: string;
  readonly creds: readonly string[];
  readonly note: string;
  readonly color: ServiceColor;
}

export const CHEFS: readonly Chef[] = [
  {
    name: 'Imani Okafor',
    role: 'Lead Chef',
    where: 'Brooklyn, NY',
    creds: ['CIA, 2011', 'Dementia-Care Cert.', 'IDDSI texture-trained'],
    note: 'Cooks with a soft hand and a long memory — her grandmother’s jollof is on every Friday menu.',
    color: 'clay',
  },
  {
    name: 'Marco Devereux',
    role: 'Chef · Companion',
    where: 'Berkeley, CA',
    creds: ['Le Cordon Bleu', 'RD-supervised plans', 'Fluent: EN, FR, IT'],
    note: 'Believes lunch should last two hours. Sets the table even when no one’s watching.',
    color: 'sage',
  },
  {
    name: 'Yuki Tanabe',
    role: 'Wellness Chef',
    where: 'Seattle, WA',
    creds: ['RD, 2014', 'Renal & diabetic specialist', 'Macrobiotic-trained'],
    note: 'A quiet kitchen, beautifully labeled containers, and the gentlest dashi you’ve ever had.',
    color: 'espresso',
  },
  {
    name: 'Rosa Méndez',
    role: 'Companion Chef',
    where: 'Austin, TX',
    creds: ['HHA, 2018', 'Bilingual EN/ES', 'Music-therapy adjunct'],
    note: 'Cooks tortillas to a record player. Half the visit is the kitchen radio.',
    color: 'clay',
  },
];

export interface Plan {
  readonly name: string;
  readonly sub: string;
  readonly monthly: number;
  readonly quarterly: number;
  readonly includes: readonly string[];
  readonly cta: string;
  readonly featured: boolean;
}

export const PLANS: readonly Plan[] = [
  {
    name: 'Hearth',
    sub: 'A weekly anchor.',
    monthly: 1280,
    quarterly: 1180,
    includes: [
      '1 chef visit weekly (4 hrs)',
      'Weekly menu from RD',
      'Family app access',
      'Monthly wellness call',
    ],
    cta: 'Begin with Hearth',
    featured: false,
  },
  {
    name: 'Table',
    sub: 'Most chosen by families.',
    monthly: 2640,
    quarterly: 2440,
    includes: [
      '2 chef visits weekly',
      '1 companion visit weekly',
      'Concierge · 4 hrs / mo',
      'Bi-weekly family update call',
      'Priority team continuity',
    ],
    cta: 'Set the Table',
    featured: true,
  },
  {
    name: 'Hearthstone',
    sub: 'Full aging-in-place support.',
    monthly: 4980,
    quarterly: 4640,
    includes: [
      '3 chef visits weekly',
      '2 companion visits weekly',
      'Caregiver · 12 hrs / wk',
      'Concierge · unlimited',
      'Dedicated care lead',
    ],
    cta: 'Talk to a care lead',
    featured: false,
  },
];

export interface FamilyFeature {
  readonly title: string;
  readonly body: string;
}

export const FAMILY_FEATURES: readonly FamilyFeature[] = [
  {
    title: 'A note after every visit',
    body: 'Two or three sentences from the chef or companion — what they cooked, what they talked about, how the day felt.',
  },
  {
    title: 'A photo of the table',
    body: 'Plated meals, the kitchen mid-prep, the dog under the chair. Small images that mean a lot from far away.',
  },
  {
    title: 'Wellness signals',
    body: 'Appetite, mood, mobility, sleep — quietly tracked, never clinical-feeling. Flags rise gently when patterns shift.',
  },
  {
    title: 'A shared family inbox',
    body: 'Siblings, in-laws, the second cousin who calls on Sundays — everyone on the same page, without group-text chaos.',
  },
];

export interface FaqItem {
  readonly q: string;
  readonly a: string;
}

export const FAQ: readonly FaqItem[] = [
  {
    q: 'How are chefs and companions vetted?',
    a: 'Every team member completes a culinary or care credential review, two reference calls, a federal background check, and a four-hour Taste & See onboarding focused on aging, dignity, and dementia-aware practice. We hire roughly one in twenty applicants.',
  },
  {
    q: 'Can you accommodate medical diets?',
    a: 'Yes. Every weekly menu is designed against a registered-dietitian plan: low-sodium, renal, diabetic, soft / texture-modified (IDDSI levels 4–7), heart-healthy, and several others. We coordinate directly with your loved one’s physician on request.',
  },
  {
    q: 'What if my parent is in early-stage dementia?',
    a: 'Most of our chefs and companions are dementia-care trained. We focus on familiar foods from your loved one’s past, simple table rituals, and consistent faces — we keep the same small team in place to support memory and comfort.',
  },
  {
    q: 'How do you handle scheduling and cancellations?',
    a: 'You and your loved one share one calendar in the family app. Reschedule any visit up to 12 hours before — your team adjusts the menu and grocery plan to match. Subscriptions can be paused for travel or hospital stays at any time.',
  },
  {
    q: 'Is Taste & See covered by long-term care insurance?',
    a: 'Many long-term care policies cover the caregiver and concierge components. We provide itemized monthly statements and will speak with your insurer or care manager directly during onboarding.',
  },
  {
    q: 'Where is Taste & See available?',
    a: 'We currently operate in greater New York, Boston, Chicago, the Bay Area, Los Angeles, Seattle, Austin, and Atlanta, with a small waitlist program in 14 additional metros. Enter a ZIP at signup to see availability and your local team.',
  },
];
