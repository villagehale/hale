// Deterministic, semantics-preserving surface variants for model-tier comparisons.
// These increase robustness coverage (names, dates, providers, wording) without
// pretending that 50 samples are 50 independent failure-mode archetypes.

export const MATRIX_SAMPLE_TARGET = 50;

const PROFILES = [
  {
    slug: 'avery',
    child: 'Avery',
    clinic: 'Lakeside Pediatrics',
    clinicDomain: 'lakeside-peds.ca',
    daycare: 'Maple Grove Child Care',
    daycareDomain: 'maplegrove-childcare.ca',
    provider: 'Dr. Chen',
    dateText: 'Wednesday July 8',
    isoDate: '2026-07-08',
    visitTime: '9:20 AM',
    clock: '09:20',
    item: 'size 5 diapers',
    vendor: 'FamilySupply',
    amount: '46.50',
    bedtime: '20:00',
    firstStep: 'pyjamas',
    secondStep: 'two books',
    comfort: 'green rabbit',
    allergen: 'sesame',
    ref: 'SYN-A1',
    prefix: 'quick question — ',
  },
  {
    slug: 'noor',
    child: 'Noor',
    clinic: 'Harbour Kids Clinic',
    clinicDomain: 'harbourkids.ca',
    daycare: 'Little Cedar Centre',
    daycareDomain: 'littlecedar.ca',
    provider: 'Dr. Patel',
    dateText: 'Monday August 17',
    isoDate: '2026-08-17',
    visitTime: '2:40 PM',
    clock: '14:40',
    item: 'training pants',
    vendor: 'CareCart',
    amount: '39.75',
    bedtime: '19:45',
    firstStep: 'wash up',
    secondStep: 'one story',
    comfort: 'yellow blanket',
    allergen: 'peanut',
    ref: 'SYN-N2',
    prefix: 'can you help — ',
  },
  {
    slug: 'sofia',
    child: 'Sofia',
    clinic: 'West End Children’s Health',
    clinicDomain: 'westendkids.ca',
    daycare: 'Rainbow Room Preschool',
    daycareDomain: 'rainbowroom.ca',
    provider: 'Dr. Tremblay',
    dateText: 'Friday September 11',
    isoDate: '2026-09-11',
    visitTime: '11:05 AM',
    clock: '11:05',
    item: 'overnight diapers',
    vendor: 'ParentBox',
    amount: '51.20',
    bedtime: '19:15',
    firstStep: 'teeth',
    secondStep: 'song',
    comfort: 'plush fox',
    allergen: 'dairy',
    ref: 'SYN-S3',
    prefix: 'one thing — ',
  },
  {
    slug: 'mateo',
    child: 'Mateo',
    clinic: 'Parkview Family Pediatrics',
    clinicDomain: 'parkview-peds.ca',
    daycare: 'Spruce Street Daycare',
    daycareDomain: 'sprucestreet.ca',
    provider: 'Dr. Singh',
    dateText: 'Thursday October 22',
    isoDate: '2026-10-22',
    visitTime: '4:10 PM',
    clock: '16:10',
    item: 'size 6 diapers',
    vendor: 'HomeCare Depot',
    amount: '44.10',
    bedtime: '20:15',
    firstStep: 'bathroom',
    secondStep: 'chapter book',
    comfort: 'brown bear',
    allergen: 'cashew',
    ref: 'SYN-M4',
    prefix: 'checking in: ',
  },
  {
    slug: 'amara',
    child: 'Amara',
    clinic: 'Danforth Kids Health',
    clinicDomain: 'danforthkids.ca',
    daycare: 'Willow Tree Early Learning',
    daycareDomain: 'willowtree-el.ca',
    provider: 'Dr. Mensah',
    dateText: 'Tuesday November 3',
    isoDate: '2026-11-03',
    visitTime: '8:45 AM',
    clock: '08:45',
    item: 'baby wipes',
    vendor: 'NorthStar Baby',
    amount: '37.25',
    bedtime: '19:20',
    firstStep: 'warm washcloth',
    secondStep: 'quiet music',
    comfort: 'knit lamb',
    allergen: 'walnut',
    ref: 'SYN-A5',
    prefix: 'small question: ',
  },
  {
    slug: 'elodie',
    child: 'Élodie',
    clinic: 'Clinique des Petits',
    clinicDomain: 'petits-clinique.ca',
    daycare: 'Les Petits Explorateurs',
    daycareDomain: 'petitsexplorateurs.ca',
    provider: 'Dre Gagnon',
    dateText: 'mercredi 9 décembre',
    isoDate: '2026-12-09',
    visitTime: '13 h 30',
    clock: '13:30',
    item: 'couches taille 4',
    vendor: 'Tout-Petit',
    amount: '48.00',
    bedtime: '19:50',
    firstStep: 'bain',
    secondStep: 'histoire',
    comfort: 'lapin bleu',
    allergen: 'oeuf',
    ref: 'SYN-E6',
    prefix: 'petite question — ',
  },
  {
    slug: 'rowan',
    child: 'Rowan',
    clinic: 'Eastside Child Health',
    clinicDomain: 'eastsidechild.ca',
    daycare: 'Acorn Early Years',
    daycareDomain: 'acornearlyyears.ca',
    provider: 'Dr. Brooks',
    dateText: 'Saturday January 16',
    isoDate: '2027-01-16',
    visitTime: '10:50 AM',
    clock: '10:50',
    item: 'pull-ups',
    vendor: 'Everyday Family',
    amount: '41.80',
    bedtime: '20:10',
    firstStep: 'tidy toys',
    secondStep: 'picture book',
    comfort: 'orange dinosaur',
    allergen: 'soy',
    ref: 'SYN-R7',
    prefix: 'remind me: ',
  },
  {
    slug: 'zain',
    child: 'Zain',
    clinic: 'Crescent Children’s Clinic',
    clinicDomain: 'crescentkids.ca',
    daycare: 'Pinecone Child Centre',
    daycareDomain: 'pineconecentre.ca',
    provider: 'Dr. Ahmed',
    dateText: 'Monday February 8',
    isoDate: '2027-02-08',
    visitTime: '3:25 PM',
    clock: '15:25',
    item: 'size 3 diapers',
    vendor: 'BabyBasics',
    amount: '43.60',
    bedtime: '19:35',
    firstStep: 'wash hands',
    secondStep: 'bedtime poem',
    comfort: 'soft turtle',
    allergen: 'almond',
    ref: 'SYN-Z8',
    prefix: 'could you tell me — ',
  },
  {
    slug: 'priya',
    child: 'Priya',
    clinic: 'Midtown Paediatric Care',
    clinicDomain: 'midtownpaeds.ca',
    daycare: 'Bluebird Learning House',
    daycareDomain: 'bluebirdlearning.ca',
    provider: 'Dr. Rao',
    dateText: 'Thursday March 18',
    isoDate: '2027-03-18',
    visitTime: '12:15 PM',
    clock: '12:15',
    item: 'diaper cream',
    vendor: 'LittleNeeds',
    amount: '35.90',
    bedtime: '20:05',
    firstStep: 'pajamas',
    secondStep: 'short story',
    comfort: 'purple owl',
    allergen: 'hazelnut',
    ref: 'SYN-P9',
    prefix: 'I wanted to ask: ',
  },
];

const BASE_NAMES = [
  'Mira',
  'Jordan',
  'Maya',
  'Devon',
  'Sam',
  'Riley',
  'Kai',
  'Noa',
  'Ezra',
  'Leo',
  'Theo',
];
const VARIANT_CHILDREN = [
  ...PROFILES.map(({ slug, child: name }) => ({ slug, name })),
  { slug: 'lucas', name: 'Lucas' },
  { slug: 'ivy', name: 'Ivy' },
];

function replacements(profile) {
  const offset = PROFILES.indexOf(profile);
  return [
    ...BASE_NAMES.flatMap((name, index) => {
      const child = VARIANT_CHILDREN[(index + offset) % VARIANT_CHILDREN.length];
      return [
        [`child-${name.toLowerCase()}`, `child-${child.slug}`],
        [new RegExp(`\\b${name}\\b`, 'g'), child.name],
        [new RegExp(`\\b${name.toLowerCase()}\\b`, 'g'), child.name.toLowerCase()],
      ];
    }),
    ['Riverdale Peds', profile.clinic],
    ['riverdale-peds.ca', profile.clinicDomain],
    ['Bright Kids Peds', profile.clinic],
    ['brightkids-peds.ca', profile.clinicDomain],
    ['Sunny Daycare', profile.daycare],
    ['sunnydaycare.ca', profile.daycareDomain],
    ['Dr. Okafor', profile.provider],
    ['Dr. Nguyen', profile.provider],
    ['Tuesday June 23', profile.dateText],
    ['Thursday July 9', profile.dateText],
    ['June 23', profile.dateText.replace(/^[A-Za-zÀ-ÿ]+\s+/, '')],
    ['2026-06-23', profile.isoDate],
    ['2026-06-24', profile.isoDate],
    ['2026-06-20', profile.isoDate],
    ['10:15 AM', profile.visitTime],
    ['5:30 PM', profile.visitTime],
    ['9:00 AM', profile.visitTime],
    ['10:15', profile.clock],
    ['5:30', profile.clock],
    ['19:30', profile.bedtime],
    ['size 4 diapers', profile.item],
    ['size 3 diapers', profile.item],
    ['DiaperCo', profile.vendor],
    ['42.99', profile.amount],
    ['bath', profile.firstStep],
    ['story', profile.secondStep],
    ['blue elephant', profile.comfort],
    ['egg', profile.allergen],
  ];
}

function replaceStrings(value, pairs) {
  if (value instanceof RegExp) return value;
  if (typeof value === 'function') return value;
  if (typeof value === 'string') {
    return pairs.reduce((text, [from, to]) => text.split(from).join(to), value);
  }
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, pairs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        replaceStrings(key, pairs),
        replaceStrings(item, pairs),
      ]),
    );
  }
  return value;
}

function varyVisibleInput(role, fixture, profile, round) {
  const reference = `${profile.ref}-${round}`;
  if (role === 'classify') {
    fixture.input.rawContent += `\n\nMessage reference: ${reference}.`;
  } else if (role === 'draft') {
    fixture.input.event.payload.message_reference = reference;
  } else if (role === 'review') {
    fixture.input.draft_action.id += `-${reference.toLowerCase()}`;
  } else if (role === 'coach') {
    fixture.question = `${profile.prefix}${fixture.question} (${reference})`;
  }
}

export function expandMatrixCases(role, cases, target = MATRIX_SAMPLE_TARGET) {
  const visibleInput = (item) => (role === 'coach' ? item.question : item.input);
  return expandSyntheticFixtures(role, cases, target, {
    vary: (fixture, { profile, round }) => varyVisibleInput(role, fixture, profile, round),
    visibleInput,
  });
}

export function expandSyntheticFixtures(suite, cases, target, options) {
  if (!Number.isInteger(target) || target < 1) throw new Error(`invalid sample target: ${target}`);
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`${suite}: no base cases`);
  if (cases.length >= target) return cases.map((item) => replaceStrings(item, []));

  const expanded = cases.map((item) => ({ ...replaceStrings(item, []), baseScenarioId: item.id }));
  for (let index = cases.length; index < target; index += 1) {
    const base = cases[index % cases.length];
    const profile = PROFILES[(index - cases.length) % PROFILES.length];
    const round = Math.floor((index - cases.length) / cases.length) + 1;
    const pairs = options.applyProfileReplacements === false ? [] : replacements(profile);
    const fixture = replaceStrings(base, pairs);
    fixture.id = `${base.id}--${profile.slug}-${round}`;
    fixture.baseScenarioId = base.id;
    fixture.syntheticVariant = profile.slug;
    options.vary(fixture, { profile, round, reference: `${profile.ref}-${round}` });
    expanded.push(fixture);
  }

  const ids = new Set(expanded.map((item) => item.id));
  const inputs = new Set(expanded.map((item) => JSON.stringify(options.visibleInput(item))));
  if (ids.size !== expanded.length) throw new Error(`${suite}: generated duplicate fixture ids`);
  if (inputs.size !== expanded.length)
    throw new Error(`${suite}: generated duplicate model inputs`);
  return expanded;
}
