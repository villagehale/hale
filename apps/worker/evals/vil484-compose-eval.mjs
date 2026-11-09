// VIL-484 · evening and morning-of registration texts, and co-parent night-before text.
// VIL-488 · the heads-up registration text (a week out), written the same way.
//
// The model writes the whole text from facts. The night-before group text is then
// fact-checked by a second model call (duty-night-check.md) before it can send. This
// eval runs the REAL skills through the REAL request shapes the composers build
// (evening-compose.ts, night-compose.ts), replicated with the harness cache so a
// recording replays at $0. A skill edit re-keys the cache.
//
// This file is not named run-*.mjs, so the Monday sweep does not pick it up, and it
// is not in ci.yml.
//
//   node evals/vil484-compose-eval.mjs --dry            # $0: worst case for a full live run
//   node evals/vil484-compose-eval.mjs --broken         # $0: structural gate calibration, must fail
//   node evals/vil484-compose-eval.mjs --cached-only    # $0: replay a recording (misses fail)
//   HALE_SPEND_LEDGER=... node evals/vil484-compose-eval.mjs --live --max-usd 0.05   # PAID
//
// --live includes the live --broken cases: drafts that claim something the facts do
// not (booked, a wrong address, a seat held). The fact check must block every one and
// the judge must score each one 2 or lower, or the run fails.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { parseEvalArgsOrExit } from './lib/eval-flags.mjs';
import {
  JUDGE_MIN,
  PRICE,
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const EVENING_SRC = join(REPO_ROOT, 'apps/web/lib/registration/sequence/evening-compose.ts');
const MORNING_SRC = join(REPO_ROOT, 'apps/web/lib/registration/sequence/morning-compose.ts');
const HEADS_UP_SRC = join(REPO_ROOT, 'apps/web/lib/registration/sequence/heads-up-compose.ts');
const TEXT_CHECK_SRC = join(REPO_ROOT, 'apps/web/lib/registration/sequence/text-check.ts');
const DUTY_SRC = join(REPO_ROOT, 'apps/web/lib/channel/coparent/duty/night-compose.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const TEXT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};
const EVENING_TOOL = {
  name: 'registration_evening_text',
  description: 'The one text Hale sends the parent the evening before registration opens.',
};
const MORNING_TOOL = {
  name: 'registration_morning_text',
  description: 'The one text Hale sends the parent just before registration opens.',
};
const HEADS_UP_TOOL = {
  name: 'registration_heads_up_text',
  description: 'The one text Hale sends the parent about a week before registration opens.',
};
const DUTY_TOOL = {
  name: 'duty_night_text',
  description: 'The one text Hale sends the group the evening before.',
};
const REG_CHECK_TOOL = {
  name: 'registration_text_check',
  description: 'Whether every claim in the draft is backed by the facts.',
};
const CHECK_TOOL = {
  name: 'duty_night_check',
  description: 'Whether every claim in the draft is backed by the facts.',
};

const JUDGE_SYSTEM = [
  'You score one text Hale would send a parent or a family group. You are given the facts',
  'Hale handed the writer and the text. Score 1 to 5.',
  'A 5 states only what the facts give, keeps every handed time, name, place, address and',
  'link right, phrases the day correctly against now, sounds like a friend texting in the',
  'handed language, and names no child the facts left null or generic.',
  'For a family-group night-before text, a 5 also gives the start and end time and the',
  'venue with its address whenever the facts hand them. Its handoff is already settled, so',
  'asking that parent whether they can take it is a wrong fact.',
  'For an evening registration text, when pageShows is set it is what the page shows now and',
  'it supersedes opensAt and opensOn, which are what Hale had before.',
  'For a morning-of registration text, pageShows is what the page shows now and supersedes',
  'had; when situation is already_open, saying registration opens later is a wrong fact.',
  'For a heads-up registration text, next=plan_promised means the parent already said yes',
  'and the text asks nothing; next=offer means it asks once whether Hale should help that',
  'morning. A heads-up carries no link. When ageApproximate is true, asserting the child',
  'fits the band is a wrong fact.',
  'Score 2 or lower for any claim the facts do not make (that something is booked, paid,',
  'registered, held or confirmed; a place, an address, a time, a child, a link or a price',
  'not in the facts), a wrong day or time, the wrong language, or a named child the facts',
  'did not hand. Do not require particular words. Call the score tool.',
].join(' ');

// ── fixtures ────────────────────────────────────────────────────────────────

const EVENING_BASE = {
  now: { date: 'Monday, September 14, 2026', time: '6:00 p.m.' },
  opensAt: '6:30 a.m.',
  opensOn: 'Tuesday, September 15, 2026',
  ageBand: null,
  children: 1,
  pageShows: null,
};

const EVENING_FIXTURES = [
  {
    id: 'evening-municipal-teen',
    facts: {
      ...EVENING_BASE,
      language: 'en',
      window: 'Richmond Hill Fall 2026 recreation programs',
      who: 'your teen',
      link: 'https://www.richmondhill.ca/programs',
      portal: null,
      setup: null,
      situation: 'municipal',
      courseName: null,
    },
  },
  {
    id: 'evening-course-not-told-fr',
    facts: {
      ...EVENING_BASE,
      language: 'fr',
      opensAt: '10:30 a.m.',
      window: 'Oakville Fall 2026 programs',
      who: 'Maya',
      link: 'https://townofoakville.example/course',
      portal: "Oakville's portal",
      setup: 'not_told',
      situation: 'course',
      courseName: 'Preschool Sports',
    },
  },
  {
    id: 'evening-already-open',
    facts: {
      ...EVENING_BASE,
      language: 'en',
      window: 'Oakville Fall 2026 programs',
      who: 'Maya',
      link: 'https://townofoakville.example/signin?return=course',
      portal: "Oakville's portal",
      setup: 'told_done',
      situation: 'already_open',
      courseName: 'Preschool Sports',
      pageShows: { date: 'Monday, September 14, 2026', time: '5:00 p.m.' },
    },
  },
  {
    id: 'evening-moved-day',
    facts: {
      ...EVENING_BASE,
      language: 'en',
      window: 'Oakville Fall 2026 programs',
      who: 'Maya',
      link: 'https://townofoakville.example/course',
      portal: "Oakville's portal",
      setup: 'not_told',
      situation: 'moved_day',
      courseName: 'Preschool Sports',
      pageShows: { date: 'Thursday, September 17, 2026', time: '7:00 a.m.' },
    },
  },
];

const MORNING_BASE = {
  now: { date: 'Tuesday, September 15, 2026', time: '10:15 a.m.' },
  window: 'Oakville Fall 2026 programs',
  portal: "Oakville's portal",
  link: 'https://townofoakville.example/signin?return=course',
  had: '10:30 a.m.',
  setup: 'told_done',
  ageBand: null,
  children: 1,
  pageShows: null,
};
const OAKVILLE_COURSE = 'https://townofoakville.example/courses/swim-3';

const MORNING_FIXTURES = [
  {
    id: 'morning-moved',
    facts: {
      ...MORNING_BASE,
      language: 'en',
      situation: 'moved',
      pageShows: { date: 'Tuesday, September 15, 2026', time: '11:30 a.m.' },
    },
  },
  {
    id: 'morning-already-open-fr',
    facts: {
      ...MORNING_BASE,
      language: 'fr',
      situation: 'already_open',
      pageShows: { date: 'Tuesday, September 15, 2026', time: '9:30 a.m.' },
    },
  },
  {
    id: 'morning-municipal',
    facts: {
      ...MORNING_BASE,
      language: 'en',
      now: { date: 'Tuesday, September 15, 2026', time: '6:15 a.m.' },
      window: 'Richmond Hill Fall 2026 recreation programs',
      portal: null,
      link: 'https://www.richmondhill.ca/programs',
      had: '6:30 a.m.',
      setup: null,
      situation: 'opens',
    },
  },
  {
    id: 'morning-prepared-not-told',
    facts: { ...MORNING_BASE, language: 'en', setup: 'not_told', situation: 'opens' },
  },
  {
    id: 'morning-page-unreadable-fr',
    facts: { ...MORNING_BASE, language: 'fr', situation: 'page_unreadable' },
  },
  {
    id: 'morning-course-gone',
    facts: {
      ...MORNING_BASE,
      language: 'en',
      link: OAKVILLE_COURSE,
      setup: null,
      situation: 'course_gone',
    },
  },
  {
    id: 'morning-registration-closed',
    facts: {
      ...MORNING_BASE,
      language: 'en',
      link: OAKVILLE_COURSE,
      setup: null,
      situation: 'registration_closed',
    },
  },
  {
    id: 'morning-age-ineligible',
    facts: {
      ...MORNING_BASE,
      language: 'en',
      situation: 'age_ineligible',
      ageBand: '6 to 9 y',
      children: 2,
    },
  },
];

const MORNING_BY_ID = Object.fromEntries(MORNING_FIXTURES.map((f) => [f.id, f.facts]));
/** Judged live: drafts that pass the structural gate but claim a wrong fact. The
 * judge must score every one 2 or lower, or the run fails. */
const MORNING_BROKEN = [
  {
    id: 'broken-morning-gone-opens',
    facts: MORNING_BY_ID['morning-course-gone'],
    text: `Oakville Fall 2026 programs opens at 10:30 a.m. Go here: ${OAKVILLE_COURSE}`,
  },
  {
    id: 'broken-morning-registered',
    facts: MORNING_BY_ID['morning-prepared-not-told'],
    text: `Opens at 10:30 a.m. I registered Maya for you and your account is all set: ${MORNING_BASE.link}`,
  },
  {
    id: 'broken-morning-already-open-later',
    facts: MORNING_BY_ID['morning-already-open-fr'],
    text: `Les inscriptions ouvrent à 11 h 30 aujourd'hui : ${MORNING_BASE.link}`,
  },
  {
    id: 'broken-morning-unreadable-detail',
    facts: MORNING_BY_ID['morning-page-unreadable-fr'],
    text: `Le cours de natation a encore 4 places à 85 $. Ça ouvre à 10 h 30 : ${MORNING_BASE.link}`,
  },
];

const HEADS_UP_BASE = {
  now: { date: 'Tuesday, September 8, 2026', time: '10:00 a.m.' },
  window: 'Richmond Hill Fall 2026 recreation programs',
  who: 'Max',
  opensOn: 'Tuesday, September 15, 2026',
  opensAt: '6:30 a.m.',
  residentsFirst: false,
  ageApproximate: false,
};

const HEADS_UP_FIXTURES = [
  { id: 'heads-up-promised', facts: { ...HEADS_UP_BASE, language: 'en', next: 'plan_promised' } },
  { id: 'heads-up-offer-fr', facts: { ...HEADS_UP_BASE, language: 'fr', next: 'offer' } },
  {
    id: 'heads-up-resident-hedged-teen',
    facts: {
      ...HEADS_UP_BASE,
      language: 'en',
      who: 'your teen',
      residentsFirst: true,
      ageApproximate: true,
      next: 'offer',
    },
  },
];
const HEADS_UP_BY_ID = Object.fromEntries(HEADS_UP_FIXTURES.map((f) => [f.id, f.facts]));

const HEADS_UP_BROKEN = [
  {
    id: 'broken-heads-up-registered',
    facts: HEADS_UP_BY_ID['heads-up-promised'],
    text: "Richmond Hill fall programs open next Tuesday at 6:30 a.m. I've already held Max a spot.",
  },
  {
    id: 'broken-heads-up-account-set',
    facts: HEADS_UP_BY_ID['heads-up-resident-hedged-teen'],
    text: "Richmond Hill fall programs open next Tuesday at 6:30 a.m. for your teen. I checked your account and you're already signed up, so you're all set.",
  },
  {
    id: 'broken-heads-up-wrong-day',
    facts: HEADS_UP_BY_ID['heads-up-offer-fr'],
    text: 'Les inscriptions de Richmond Hill ouvrent demain à 6 h 30 pour Max. Je vous aide ce matin-là?',
  },
];

const NOW_DUTY = { date: 'Sunday, September 27, 2026', time: '7:00pm' };

const DUTY_FIXTURES = [
  {
    id: 'duty-night-full',
    facts: {
      language: 'en',
      now: NOW_DUTY,
      handoff: {
        name: 'Sam',
        kid: 'Maya',
        event: 'swim lesson',
        time: '3:00pm',
        endTime: '4:00pm',
        date: 'Monday, September 28, 2026',
        venue: { name: 'Pan Am Centre', address: '875 Morningside Ave, Toronto' },
      },
      unowned: null,
      quiet: null,
    },
  },
  {
    id: 'duty-night-fr-unowned-quiet',
    facts: {
      language: 'fr',
      now: NOW_DUTY,
      handoff: {
        name: 'Sam',
        kid: null,
        event: 'swim',
        time: '3:00pm',
        endTime: '4:30pm',
        date: 'Monday, September 28, 2026',
        venue: { name: 'Centre Jean-Claude Malépart', address: '2633 rue Ontario E, Montréal' },
      },
      unowned: { kid: null, event: 'piano', day: 'Tuesday', time: '10:00am' },
      quiet: { name: 'Barton' },
    },
  },
  {
    id: 'duty-night-venue-name-only',
    facts: {
      language: 'en',
      now: NOW_DUTY,
      handoff: {
        name: 'Sam',
        kid: 'Maya',
        event: 'swim lesson',
        time: '3:00pm',
        endTime: '4:00pm',
        date: 'Monday, September 28, 2026',
        venue: { name: 'Pan Am Centre pool', address: null },
      },
      unowned: null,
      quiet: null,
    },
  },
  {
    id: 'duty-night-no-venue-no-end',
    facts: {
      language: 'en',
      now: NOW_DUTY,
      handoff: {
        name: 'Barton',
        kid: 'Leo',
        event: 'soccer',
        time: '9:00am',
        endTime: null,
        date: 'Monday, September 28, 2026',
        venue: null,
      },
      unowned: null,
      quiet: null,
    },
  },
];

const BASE_BROKEN = DUTY_FIXTURES[0].facts;
const BROKEN_DRAFTS = [
  {
    id: 'broken-booked',
    facts: BASE_BROKEN,
    text: 'Tomorrow Sam has Maya at swim lesson, 3 to 4pm at Pan Am Centre, 875 Morningside Ave. It is booked.',
  },
  {
    id: 'broken-wrong-address',
    facts: BASE_BROKEN,
    text: 'Tomorrow Sam has Maya at swim lesson, 3 to 4pm at Pan Am Centre, 100 Queen St W.',
  },
  {
    id: 'broken-paid-fr',
    facts: DUTY_FIXTURES[1].facts,
    text: 'Demain Sam a la natation de 15 h à 16 h 30 au Centre Jean-Claude Malépart, 2633 rue Ontario E. C’est payé et confirmé.',
  },
];

// ── offline gate calibration ($0) ───────────────────────────────────────────

// Captured before any --only narrowing, so the offline calibration always runs whole.
const MORNING_FIRST = MORNING_FIXTURES[0].facts;
const EVENING_FIRST = EVENING_FIXTURES[0].facts;

function brokenOffline(evening, duty, morning, headsUp) {
  const morningFacts = MORNING_FIRST;
  const eveningFacts = EVENING_FIRST;
  const failures = [
    evening.eveningRefusals('   ', eveningFacts),
    evening.eveningRefusals('See https://evil.example/phish tonight.', eveningFacts),
    duty.dutyNightRefusals('  '),
    duty.dutyNightRefusals('See https://evil.example/phish'),
    morning.morningRefusals('  ', morningFacts),
    morning.morningRefusals('It moved to 11:30.', morningFacts),
    morning.morningRefusals(`${morningFacts.link} https://evil.example/phish`, morningFacts),
    // The course page, not the sign-in link, is the one link on a gone course.
    morning.morningRefusals(`Check ${MORNING_BASE.link}`, MORNING_BY_ID['morning-course-gone']),
    headsUp.headsUpRefusals('  '),
    headsUp.headsUpRefusals('Opens Tuesday: https://www.richmondhill.ca/programs'),
  ];
  const kept = [
    evening.eveningRefusals('Have https://www.richmondhill.ca/programs open.', eveningFacts),
    duty.dutyNightRefusals('Sam has the swim.'),
    morning.morningRefusals(`Now 11:30: ${morningFacts.link}`, morningFacts),
    morning.morningRefusals(
      `Check the page: ${OAKVILLE_COURSE}`,
      MORNING_BY_ID['morning-course-gone'],
    ),
    headsUp.headsUpRefusals('Richmond Hill opens next Tuesday at 6:30 a.m. for Max.'),
  ];
  return failures.every((f) => f.length > 0) && kept.every((f) => f.length === 0);
}

// ── dry pricing ─────────────────────────────────────────────────────────────

const tokensFor = (value) =>
  Math.ceil((typeof value === 'string' ? value : JSON.stringify(value)).length / 3);

function worst(model, inTokens, maxOut) {
  const rates = PRICE[model];
  if (!rates) throw new Error(`no price for ${model}`);
  return (inTokens / 1e6) * rates.input + (maxOut / 1e6) * rates.output;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  // `--max-usd <n>` is the harness's spend cap, not a mode; strip it before the parse.
  const raw = process.argv.slice(2);
  const modeArgs = raw.filter((a, i) => a !== '--max-usd' && raw[i - 1] !== '--max-usd');
  const knownIds = [
    ...EVENING_FIXTURES,
    ...MORNING_FIXTURES,
    ...HEADS_UP_FIXTURES,
    ...DUTY_FIXTURES,
    ...BROKEN_DRAFTS,
    ...MORNING_BROKEN,
    ...HEADS_UP_BROKEN,
  ].map((f) => f.id);
  const { mode, only } = parseEvalArgsOrExit('vil484', knownIds, modeArgs);
  const dry = mode === 'dry';
  const broken = mode === 'broken';
  const live = mode === 'live';
  const cachedOnly = mode === 'cached-only';
  // `--only=<id>[,<id>]` narrows every fixture list, so one leg can be re-recorded
  // without paying for the whole file.
  if (only) {
    for (const list of [
      EVENING_FIXTURES,
      MORNING_FIXTURES,
      HEADS_UP_FIXTURES,
      DUTY_FIXTURES,
      BROKEN_DRAFTS,
      MORNING_BROKEN,
      HEADS_UP_BROKEN,
    ]) {
      const kept = list.filter((f) => only.includes(f.id));
      list.splice(0, list.length, ...kept);
    }
  }

  const agent = await importTs(AGENT_SRC);
  const evening = await importTs(EVENING_SRC);
  const duty = await importTs(DUTY_SRC);
  const morning = await importTs(MORNING_SRC);
  const headsUp = await importTs(HEADS_UP_SRC);
  const textCheck = await importTs(TEXT_CHECK_SRC);

  if (broken) {
    const ok = brokenOffline(evening, duty, morning, headsUp);
    console.info(`broken-mode calibration (must fail): ${ok ? 'PASS' : 'FAIL'}`);
    console.info('live calls: 0');
    process.exit(ok ? 0 : 1);
  }

  const eveningSkill = await agent.loadSkill(join(SKILLS, 'registration-evening.md'));
  const dutySkill = await agent.loadSkill(join(SKILLS, 'duty-night.md'));
  const morningSkill = await agent.loadSkill(join(SKILLS, 'registration-morning.md'));
  const morningLane = agent.pickLane(morningSkill.meta.task);
  const headsUpSkill = await agent.loadSkill(join(SKILLS, 'registration-heads-up.md'));
  const headsUpLane = agent.pickLane(headsUpSkill.meta.task);
  const regCheckSkill = await agent.loadSkill(join(SKILLS, 'registration-text-check.md'));
  const regCheckLane = agent.pickLane(regCheckSkill.meta.task);
  const checkSkill = await agent.loadSkill(join(SKILLS, 'duty-night-check.md'));
  const eveningLane = agent.pickLane(eveningSkill.meta.task);
  const dutyLane = agent.pickLane(dutySkill.meta.task);
  const checkLane = agent.pickLane(checkSkill.meta.task);
  const judgeModel = await readJudgeModel();
  const judgeMaxOut = judgeModel === agent.HAIKU_MODEL ? 4096 : 8192;

  if (dry) {
    // Every compose priced at its attempt ceiling, every draft checked at each attempt,
    // every judge draw at its full output ceiling. Cached keys are not discounted.
    let usd = 0;
    let calls = 0;
    for (const f of EVENING_FIXTURES) {
      const msg = evening.eveningUserMessage(f.facts);
      usd +=
        evening.EVENING_MAX_ATTEMPTS *
        worst(
          eveningLane.model,
          tokensFor(eveningSkill.instructions) + tokensFor(msg) + 200,
          evening.EVENING_MAX_TOKENS,
        );
      usd += worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 400, judgeMaxOut);
      calls += evening.EVENING_MAX_ATTEMPTS + 1;
    }
    for (const f of MORNING_FIXTURES) {
      const msg = JSON.stringify(f.facts);
      usd +=
        morning.MORNING_MAX_ATTEMPTS *
        (worst(
          morningLane.model,
          tokensFor(morningSkill.instructions) + tokensFor(msg) + 200,
          morning.MORNING_MAX_TOKENS,
        ) +
          worst(
            regCheckLane.model,
            tokensFor(regCheckSkill.instructions) + 2 * tokensFor(msg) + 400,
            textCheck.REGISTRATION_TEXT_CHECK_MAX_TOKENS,
          ));
      usd += worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 400, judgeMaxOut);
      calls += morning.MORNING_MAX_ATTEMPTS + 1;
    }
    for (const f of DUTY_FIXTURES) {
      const msg = duty.dutyNightUserMessage(f.facts);
      usd +=
        duty.DUTY_NIGHT_MAX_ATTEMPTS *
        (worst(
          dutyLane.model,
          tokensFor(dutySkill.instructions) + tokensFor(msg) + 200,
          duty.DUTY_NIGHT_MAX_TOKENS,
        ) +
          worst(
            checkLane.model,
            tokensFor(checkSkill.instructions) + 2 * tokensFor(msg) + 400,
            duty.DUTY_NIGHT_CHECK_MAX_TOKENS,
          ));
      usd += worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 400, judgeMaxOut);
      calls += 2 * duty.DUTY_NIGHT_MAX_ATTEMPTS + 1;
    }
    let headsUpUsd = 0;
    for (const f of HEADS_UP_FIXTURES) {
      const msg = JSON.stringify(f.facts);
      const one =
        headsUp.HEADS_UP_MAX_ATTEMPTS *
          (worst(
            headsUpLane.model,
            tokensFor(headsUpSkill.instructions) + tokensFor(msg) + 200,
            headsUp.HEADS_UP_MAX_TOKENS,
          ) +
            worst(
              regCheckLane.model,
              tokensFor(regCheckSkill.instructions) + 2 * tokensFor(msg) + 400,
              textCheck.REGISTRATION_TEXT_CHECK_MAX_TOKENS,
            )) +
        worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 400, judgeMaxOut);
      usd += one;
      headsUpUsd += one;
      calls += 2 * headsUp.HEADS_UP_MAX_ATTEMPTS + 1;
    }
    for (const b of HEADS_UP_BROKEN) {
      const msg = JSON.stringify({ facts: b.facts, text: b.text });
      const one =
        worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 400, judgeMaxOut) +
        worst(
          regCheckLane.model,
          tokensFor(regCheckSkill.instructions) + tokensFor(msg) + 400,
          textCheck.REGISTRATION_TEXT_CHECK_MAX_TOKENS,
        );
      usd += one;
      headsUpUsd += one;
      calls += 2;
    }
    let morningUsd = 0;
    for (const f of MORNING_FIXTURES) {
      const msg = JSON.stringify(f.facts);
      morningUsd +=
        morning.MORNING_MAX_ATTEMPTS *
          worst(
            morningLane.model,
            tokensFor(morningSkill.instructions) + tokensFor(msg) + 200,
            morning.MORNING_MAX_TOKENS,
          ) +
        worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 400, judgeMaxOut);
    }
    for (const b of MORNING_BROKEN) {
      const msg = JSON.stringify({ facts: b.facts, text: b.text });
      const one = worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 400, judgeMaxOut);
      usd += one;
      morningUsd += one;
      calls += 1;
    }
    for (const b of BROKEN_DRAFTS) {
      const msg = duty.dutyNightCheckMessage(b.facts, b.text);
      usd += worst(
        checkLane.model,
        tokensFor(checkSkill.instructions) + tokensFor(msg),
        duty.DUTY_NIGHT_CHECK_MAX_TOKENS,
      );
      usd += worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg), judgeMaxOut);
      calls += 2;
    }
    console.info(
      `DRY heads-up-only (new in VIL-488) | worst $${headsUpUsd.toFixed(6)} | ${HEADS_UP_FIXTURES.length} fixtures + ${HEADS_UP_BROKEN.length} broken`,
    );
    console.info(
      `DRY morning-only (re-keyed by this change) | worst $${morningUsd.toFixed(6)} | ${MORNING_FIXTURES.length} fixtures + ${MORNING_BROKEN.length} broken`,
    );
    console.info(
      `DRY total | worst $${usd.toFixed(6)} | ${calls} calls at most | compose=${eveningLane.model}/${dutyLane.model} check=${checkLane.model} judge=${judgeModel} | live calls: 0`,
    );
    return;
  }

  if (live) installEvalSpendCap();
  const cost = makeCost();
  const getClient = lazyAnthropic('vil484');
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'vil484', cachedOnly, getClient, cost);

  async function compose(tag, lane, skill, tool, userMessage, maxTokens, attempt) {
    const { value } = await cachedToolCall({
      tag: `vil484:${tag}#${attempt}`,
      lane,
      system: skill.instructions,
      userMessage,
      toolName: tool.name,
      toolDescription: tool.description,
      toolSchema: TEXT_SCHEMA,
      maxTokens,
      cachedOnly,
      getClient,
      cost,
    });
    return String(value?.text ?? '').trim();
  }

  async function check(tag, facts, text) {
    const { value } = await cachedToolCall({
      tag: `vil484:check:${tag}`,
      lane: checkLane,
      system: checkSkill.instructions,
      userMessage: duty.dutyNightCheckMessage(facts, text),
      toolName: CHECK_TOOL.name,
      toolDescription: CHECK_TOOL.description,
      toolSchema: duty.DUTY_NIGHT_CHECK_JSON_SCHEMA,
      maxTokens: duty.DUTY_NIGHT_CHECK_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const unsupported = Array.isArray(value?.unsupported) ? value.unsupported : ['malformed'];
    return { supported: value?.supported === true && unsupported.length === 0, unsupported };
  }

  async function regCheck(tag, kind, facts, text) {
    const { value } = await cachedToolCall({
      tag: `vil484:regcheck:${tag}`,
      lane: regCheckLane,
      system: regCheckSkill.instructions,
      userMessage: textCheck.registrationTextCheckMessage(kind, facts, text),
      toolName: REG_CHECK_TOOL.name,
      toolDescription: REG_CHECK_TOOL.description,
      toolSchema: textCheck.REGISTRATION_TEXT_CHECK_JSON_SCHEMA,
      maxTokens: textCheck.REGISTRATION_TEXT_CHECK_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const unsupported = Array.isArray(value?.unsupported) ? value.unsupported : ['malformed'];
    return { supported: value?.supported === true && unsupported.length === 0, unsupported };
  }

  let failed = 0;
  for (const f of EVENING_FIXTURES) {
    const msg = evening.eveningUserMessage(f.facts);
    let text = null;
    for (let attempt = 1; attempt <= evening.EVENING_MAX_ATTEMPTS && text === null; attempt += 1) {
      const draft = await compose(
        f.id,
        eveningLane,
        eveningSkill,
        EVENING_TOOL,
        msg,
        evening.EVENING_MAX_TOKENS,
        attempt,
      );
      if (evening.eveningRefusals(draft, f.facts).length === 0) text = draft;
    }
    if (text === null) {
      failed += 1;
      console.info(`FAIL ${f.id} | nothing sent`);
      continue;
    }
    const verdict = await judge(f.id, { facts: f.facts, text });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(
      `${ok ? 'PASS' : 'FAIL'} ${f.id} | judge ${verdict.score} | ${JSON.stringify(text)}`,
    );
    if (!ok) console.info(`     reason: ${verdict.reason}`);
  }

  for (const f of MORNING_FIXTURES) {
    const msg = JSON.stringify(f.facts);
    let text = null;
    for (let attempt = 1; attempt <= morning.MORNING_MAX_ATTEMPTS && text === null; attempt += 1) {
      const draft = await compose(
        f.id,
        morningLane,
        morningSkill,
        MORNING_TOOL,
        msg,
        morning.MORNING_MAX_TOKENS,
        attempt,
      );
      if (morning.morningRefusals(draft, f.facts).length > 0) continue;
      const checked = await regCheck(`${f.id}#${attempt}`, 'morning', f.facts, draft);
      if (checked.supported) text = draft;
      else
        console.info(
          `     check blocked ${f.id}#${attempt}: ${JSON.stringify(checked.unsupported)}`,
        );
    }
    if (text === null) {
      failed += 1;
      console.info(`FAIL ${f.id} | nothing sent`);
      continue;
    }
    const verdict = await judge(f.id, { facts: f.facts, text });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(
      `${ok ? 'PASS' : 'FAIL'} ${f.id} | judge ${verdict.score} | ${JSON.stringify(text)}`,
    );
    if (!ok) console.info(`     reason: ${verdict.reason}`);
  }

  for (const f of HEADS_UP_FIXTURES) {
    const msg = JSON.stringify(f.facts);
    let text = null;
    for (let attempt = 1; attempt <= headsUp.HEADS_UP_MAX_ATTEMPTS && text === null; attempt += 1) {
      const draft = await compose(
        f.id,
        headsUpLane,
        headsUpSkill,
        HEADS_UP_TOOL,
        msg,
        headsUp.HEADS_UP_MAX_TOKENS,
        attempt,
      );
      if (headsUp.headsUpRefusals(draft).length > 0) continue;
      const checked = await regCheck(`${f.id}#${attempt}`, 'heads_up', f.facts, draft);
      if (checked.supported) text = draft;
      else
        console.info(
          `     check blocked ${f.id}#${attempt}: ${JSON.stringify(checked.unsupported)}`,
        );
    }
    if (text === null) {
      failed += 1;
      console.info(`FAIL ${f.id} | nothing sent`);
      continue;
    }
    const verdict = await judge(f.id, { facts: f.facts, text });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(
      `${ok ? 'PASS' : 'FAIL'} ${f.id} | judge ${verdict.score} | ${JSON.stringify(text)}`,
    );
    if (!ok) console.info(`     reason: ${verdict.reason}`);
  }

  for (const f of DUTY_FIXTURES) {
    const msg = duty.dutyNightUserMessage(f.facts);
    let text = null;
    let blocked = 0;
    for (let attempt = 1; attempt <= duty.DUTY_NIGHT_MAX_ATTEMPTS && text === null; attempt += 1) {
      const draft = await compose(
        f.id,
        dutyLane,
        dutySkill,
        DUTY_TOOL,
        msg,
        duty.DUTY_NIGHT_MAX_TOKENS,
        attempt,
      );
      if (duty.dutyNightRefusals(draft).length > 0) continue;
      const checked = await check(`${f.id}#${attempt}`, f.facts, draft);
      if (checked.supported) text = draft;
      else {
        blocked += 1;
        console.info(
          `     check blocked ${f.id}#${attempt}: ${JSON.stringify(checked.unsupported)}`,
        );
      }
    }
    if (text === null) {
      failed += 1;
      console.info(`FAIL ${f.id} | nothing sent (check blocked ${blocked})`);
      continue;
    }
    const verdict = await judge(f.id, { facts: f.facts, text });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(
      `${ok ? 'PASS' : 'FAIL'} ${f.id} | check pass | judge ${verdict.score} | ${JSON.stringify(text)}`,
    );
    if (!ok) console.info(`     reason: ${verdict.reason}`);
  }

  // --broken, live: every planted claim must be blocked AND scored low.
  let brokenCaught = 0;
  for (const b of BROKEN_DRAFTS) {
    const checked = await check(b.id, b.facts, b.text);
    const verdict = await judge(b.id, { facts: b.facts, text: b.text });
    const caught = !checked.supported && verdict.score <= 2;
    if (caught) brokenCaught += 1;
    console.info(
      `${caught ? 'BROKEN-FAILS (good)' : 'BROKEN-PASSED (bad)'} ${b.id} | check ${checked.supported ? 'pass' : `blocked ${JSON.stringify(checked.unsupported)}`} | judge ${verdict.score}`,
    );
  }
  for (const b of MORNING_BROKEN) {
    const verdict = await judge(b.id, { facts: b.facts, text: b.text });
    const caught = verdict.score <= 2;
    if (caught) brokenCaught += 1;
    console.info(
      `${caught ? 'BROKEN-FAILS (good)' : 'BROKEN-PASSED (bad)'} ${b.id} | judge ${verdict.score}`,
    );
  }
  // Heads-up false claims: the send-time check must block AND the judge must score low.
  for (const b of HEADS_UP_BROKEN) {
    const checked = await regCheck(b.id, 'heads_up', b.facts, b.text);
    const verdict = await judge(b.id, { facts: b.facts, text: b.text });
    const caught = !checked.supported && verdict.score <= 2;
    if (caught) brokenCaught += 1;
    console.info(
      `${caught ? 'BROKEN-FAILS (good)' : 'BROKEN-PASSED (bad)'} ${b.id} | check ${checked.supported ? 'pass' : `blocked ${JSON.stringify(checked.unsupported)}`} | judge ${verdict.score}`,
    );
  }
  const offline = brokenOffline(evening, duty, morning, headsUp);
  const brokenOk =
    brokenCaught === BROKEN_DRAFTS.length + MORNING_BROKEN.length + HEADS_UP_BROKEN.length &&
    offline;
  console.info(`broken-mode calibration (must fail): ${brokenOk ? 'PASS' : 'FAIL'}`);

  const total =
    EVENING_FIXTURES.length +
    MORNING_FIXTURES.length +
    HEADS_UP_FIXTURES.length +
    DUTY_FIXTURES.length;
  console.info(
    `vil484 | ${total - failed} of ${total} passed | live calls: ${cost.liveCalls} | spent $${totalUsd(cost).toFixed(6)}`,
  );
  if (failed > 0 || !brokenOk) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'vil484 eval failed');
    process.exit(1);
  });
}
