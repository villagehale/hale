// Long-history synthetic family simulator (VIL-143).
//
// Generates a family whose derived memory spans YEARS — a single child from
// birth to ~3yr — so the cost+accuracy eval can ask: does the agent stay cheap
// and accurate as a family's memory grows? The output mirrors the two real
// derived-memory tables the coach reads (familyMemoryFacts + familyMemoryEpisodes,
// packages/db/src/schema/memory.ts) and the two context shapes the agent reasons
// over (MemoryFactContext / MemoryEpisodeContext, apps/web/lib/coach/context.ts).
//
// Determinism: a seeded LCG drives every choice, so the same `size` always yields
// byte-identical memory — the content-addressed eval cache stays stable across
// runs. The reference Q&A answers are derived FROM the generated facts (the
// generator writes the fact, then records what the correct answer to a probe of
// that fact IS), never copied from any model output — CLAUDE.md rule #7.
//
// Privacy (rule #1): everything here is synthetic. The child carries a synthetic
// first name and a COARSE area only (city/province), never a precise address.

import { memoryFactType } from './fact-types.mjs';

// --- seeded RNG (LCG) -------------------------------------------------------
// Numerical Recipes LCG. Deterministic given a seed; we never need crypto here.
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

// --- history sizes ----------------------------------------------------------
// S/M/L are the three points the cost+accuracy curve is measured at. Each scales
// how many months of history we synthesize and how many episodes per month — the
// fact set grows modestly (facts are CONSOLIDATED, the inferencer retires stale
// ones), while episodes grow roughly linearly with elapsed time. That asymmetry
// is the whole point: a bounded slice caps both; a naive full-dump pays for every
// episode ever recorded.
export const HISTORY_SIZES = {
  small: { months: 4, episodesPerMonth: 3 },
  medium: { months: 18, episodesPerMonth: 5 },
  large: { months: 36, episodesPerMonth: 8 },
};

// Anchor "now" so derived ages and the recency window are stable across runs
// (the eval cache key includes the serialized memory, so a drifting clock would
// invalidate every cached response). Matches the repo's synthetic-data style.
const NOW = new Date('2026-06-01T09:00:00.000Z');

const CHILD = { id: 'synth-child-1', name: 'Mira', city: 'Toronto', province: 'ON', country: 'CA' };

function monthsAgo(n) {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() - n);
  return d;
}

// --- the durable facts (consolidated; the agent's longitudinal recall) -------
// Each entry is a CompanionView-style fact PLUS the reference probe it answers.
// `establishedMonthsAgo` lets us mark some facts as OLD — they are still
// currently-valid (validUntil is null) but were established long ago, which is
// exactly the kind of fact a recency-ordered bounded slice could drop and a
// full-dump retains. The probes over old facts are the context-rot lever.
function durableFacts(months) {
  // Facts that exist regardless of size (always within history), newest-ish.
  const recent = [
    {
      factType: memoryFactType.routine,
      factKey: 'bedtime_routine',
      factValue: { window: '19:30', steps: ['bath', 'story', 'lights out'] },
      confidence: 0.92,
      establishedMonthsAgo: 1,
      probe: {
        question: "what time is mira's bedtime, and what's our wind-down routine?",
        // Derived from factValue above, not from any model output.
        mustRecall: ['19:30', 'bath', 'story'],
        referenceAnswer:
          "mira's bedtime is 19:30, with a wind-down of bath, then a story, then lights out.",
      },
    },
    {
      factType: memoryFactType.preference,
      factKey: 'comfort_object',
      factValue: { object: 'blue elephant', context: 'naps and travel' },
      confidence: 0.88,
      establishedMonthsAgo: 2,
      probe: {
        question: 'what comfort object does mira need for naps?',
        mustRecall: ['blue elephant'],
        referenceAnswer: 'mira settles for naps with her blue elephant.',
      },
    },
    {
      factType: memoryFactType.medical,
      factKey: 'allergy_egg',
      factValue: { allergen: 'egg', severity: 'mild hives', confirmed_by: 'pediatric office' },
      confidence: 0.95,
      establishedMonthsAgo: 3,
      probe: {
        question: 'does mira have any food allergies i should flag to a new caregiver?',
        mustRecall: ['egg'],
        referenceAnswer: 'mira has a mild egg allergy (hives) confirmed by your pediatric office.',
      },
    },
    {
      factType: memoryFactType.logistic,
      factKey: 'pediatric_office',
      factValue: { name: 'Riverdale Pediatrics', booking: 'evenings preferred' },
      confidence: 0.9,
      establishedMonthsAgo: 2,
      probe: {
        question: 'which pediatric office do we use and when do we like to book?',
        mustRecall: ['Riverdale Pediatrics', 'evening'],
        referenceAnswer: 'you use Riverdale Pediatrics and prefer evening appointment slots.',
      },
    },
  ];

  // Facts established long ago. Each happened at a fixed CHILD AGE, so for a child
  // now `months` old it was established (months - ageAtEvent) months ago — and it
  // only exists once the child is older than that age. They are absent from a
  // 4-month history (a 4-month-old hasn't lived a 9-month feeding transition) and
  // present in medium/large. These are the recall targets a recency-ordered
  // bounded slice is at risk of dropping while a full-dump retains them.
  const old = [
    {
      factType: memoryFactType.routine,
      factKey: 'feeding_transition',
      factValue: { from: 'purees', to: 'finger foods', age_months: 9 },
      confidence: 0.85,
      ageAtEvent: 9,
      probe: {
        question: 'when did mira move from purees to finger foods?',
        mustRecall: ['9', 'finger food'],
        referenceAnswer: 'mira moved from purees to finger foods around 9 months.',
      },
    },
    {
      factType: memoryFactType.preference,
      factKey: 'early_sleep_position',
      factValue: { settled_best: 'swaddled on back', dropped_swaddle_month: 5 },
      confidence: 0.8,
      ageAtEvent: 5,
      probe: {
        question: 'how did mira sleep best as a young baby, and when did we drop the swaddle?',
        mustRecall: ['swaddle', '5'],
        referenceAnswer:
          'as a young baby mira settled best swaddled on her back, and you dropped the swaddle around 5 months.',
      },
    },
  ];

  // Only include old facts the child is old enough to have lived through, and date
  // each by how long ago that age was (months - ageAtEvent).
  const liveOld = old
    .filter((f) => months > f.ageAtEvent)
    .map((f) => ({ ...f, establishedMonthsAgo: months - f.ageAtEvent }));
  return [...recent, ...liveOld];
}

// --- episodes (the volume that grows with elapsed time) ----------------------
// Dated summaries across the four life areas. They are the bulk a full-dump
// pays for: count scales with months * episodesPerMonth. A couple of episodes
// carry distinctive, probe-able specifics (a milestone date, an activity name)
// so a recall probe can target the episodic store, not just facts.
const EPISODE_BANK = {
  feeding: [
    'tried a new vegetable at dinner, went fine',
    'fussy at breakfast, ate well at lunch',
    'self-fed with a spoon for the first stretch',
    'refused milk in the morning, took it at nap',
  ],
  sleep: [
    'one night waking, resettled quickly',
    'skipped the afternoon nap, earlier bedtime',
    'slept through after a busy day',
    'short nap, a bit cranky by evening',
  ],
  milestones: [
    'pulled to standing at the couch',
    'said a clear new word',
    'stacked three blocks',
    'waved bye on her own',
  ],
  activities: [
    'splashed happily at the parent-and-tot swim class',
    'enjoyed the library rhyme-time session',
    'played at the neighbourhood drop-in centre',
    'visited the petting zoo with cousins',
  ],
};

const AREAS = Object.keys(EPISODE_BANK);

// The two pinned, probe-able episodes, each tied to a CHILD AGE so it (a) only
// exists once the child is old enough and (b) recedes into the past as history
// grows. At small history neither has happened; at medium/large they are real but
// buried under months of newer episodes — exactly the recall target a recency-only
// bounded slice drops and a full-dump keeps. `monthsAgo = months - ageAtEvent`.
const PINNED_EPISODES = [
  {
    ageAtEvent: 11,
    episodeType: 'milestone',
    summary: 'took her first independent steps across the living room',
  },
  {
    ageAtEvent: 15,
    episodeType: 'activity',
    summary: 'started the Tumbleweeds toddler gym class on saturdays',
  },
];

function episodes(rng, months, episodesPerMonth) {
  const out = [];
  for (const p of PINNED_EPISODES) {
    if (months <= p.ageAtEvent) continue;
    out.push({
      occurredAt: monthsAgo(months - p.ageAtEvent).toISOString(),
      episodeType: p.episodeType,
      summary: p.summary,
    });
  }

  for (let m = months - 1; m >= 0; m -= 1) {
    for (let i = 0; i < episodesPerMonth; i += 1) {
      const area = pick(rng, AREAS);
      out.push({
        occurredAt: monthsAgo(m).toISOString(),
        episodeType: area,
        summary: pick(rng, EPISODE_BANK[area]),
      });
    }
  }
  // Newest first, mirroring context.ts's `orderBy(desc(occurredAt))`.
  out.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  return out;
}

// --- reference Q&A ----------------------------------------------------------
// Episodic probes, each derived from a PINNED_EPISODES entry. They only exist when
// the child is old enough to have lived the episode (months > ageAtEvent), and
// their answer (months-ago / the class name) is derived from the pinned line, not
// from any model output. These target episodes that recede into history as memory
// grows — the recall a recency-ordered bounded slice is most likely to lose.
function episodicProbes(months) {
  const probes = [];
  const [firstSteps, gym] = PINNED_EPISODES;
  if (months > firstSteps.ageAtEvent) {
    const ago = months - firstSteps.ageAtEvent;
    probes.push({
      id: 'first-steps',
      question: 'roughly how many months ago did mira take her first steps?',
      mustRecall: [String(ago)],
      referenceAnswer: `mira took her first independent steps about ${ago} months ago.`,
      targetsOldEpisode: ago >= 6,
    });
  }
  if (months > gym.ageAtEvent) {
    probes.push({
      id: 'gym-class',
      question: 'what saturday class is mira enrolled in?',
      mustRecall: ['Tumbleweeds'],
      referenceAnswer: 'mira goes to the Tumbleweeds toddler gym class on saturdays.',
      targetsOldEpisode: months - gym.ageAtEvent >= 6,
    });
  }
  return probes;
}

/**
 * Generate a synthetic family at the given history size.
 *
 * @param {'small'|'medium'|'large'} size
 * @returns {{
 *   size: string,
 *   child: {id:string,name:string,city:string,province:string,country:string,stage:string,ageMonths:number},
 *   facts: Array<{factType:string,factKey:string,factValue:unknown,confidence:number,establishedMonthsAgo:number}>,
 *   episodes: Array<{occurredAt:string,episodeType:string,summary:string}>,
 *   referenceQA: Array<{id:string,question:string,mustRecall:string[],referenceAnswer:string,targetsOld:boolean}>,
 *   counts: {facts:number, episodes:number}
 * }}
 */
export function generateFamily(size) {
  const spec = HISTORY_SIZES[size];
  if (!spec) throw new Error(`generateFamily: unknown size '${size}'`);
  // Seed per size so each size is deterministic but distinct.
  const rng = makeRng(0xface ^ spec.months);

  const facts = durableFacts(spec.months);
  const eps = episodes(rng, spec.months, spec.episodesPerMonth);

  // Child age = current age; at NOW the child is `spec.months` old up to a 36mo cap
  // (the 0->3yr span). Stage is derived the same way @hale/types does, but we keep
  // it inline (the eval is a plain .mjs, no TS import) — boundaries [12,48,156].
  const ageMonths = Math.min(spec.months, 36);
  const stage = ageMonths < 12 ? 'newborn' : ageMonths < 48 ? 'toddler' : 'child';

  // Reference Q&A = the fact probes (over recent AND old facts) + episodic probes.
  // `kind` separates the two memory stores the eval gates differently: fact-store
  // recall (consolidated, bounded — must stay high at every size) vs episode-store
  // recall (grows with time — the bounded slice is expected to lose old episodes;
  // that loss is REPORTED, not gated). `targetsOld` marks recall targets older than
  // the recency window, the divergence the curve is built to surface.
  const factProbes = facts.map((f) => ({
    id: f.factKey,
    kind: 'fact',
    question: f.probe.question,
    mustRecall: f.probe.mustRecall,
    referenceAnswer: f.probe.referenceAnswer,
    targetsOld: f.establishedMonthsAgo >= 6,
  }));
  const epProbes = episodicProbes(spec.months).map((p) => ({
    id: p.id,
    kind: 'episode',
    question: p.question,
    mustRecall: p.mustRecall,
    referenceAnswer: p.referenceAnswer,
    targetsOld: p.targetsOldEpisode,
  }));

  return {
    size,
    child: {
      id: CHILD.id,
      name: CHILD.name,
      city: CHILD.city,
      province: CHILD.province,
      country: CHILD.country,
      stage,
      ageMonths,
    },
    facts: facts.map((f) => ({
      factType: f.factType,
      factKey: f.factKey,
      factValue: f.factValue,
      confidence: f.confidence,
      establishedMonthsAgo: f.establishedMonthsAgo,
    })),
    episodes: eps,
    referenceQA: [...factProbes, ...epProbes],
    counts: { facts: facts.length, episodes: eps.length },
  };
}

export const SYNTH_NOW = NOW;
