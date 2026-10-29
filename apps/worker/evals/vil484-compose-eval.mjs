// VIL-484 · evening and moved-morning registration texts, and co-parent night-before text.
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
  description: 'The one text Hale sends the parent just before registration, when the page moved.',
};
const DUTY_TOOL = {
  name: 'duty_night_text',
  description: 'The one text Hale sends the group the evening before.',
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

const MORNING_FIXTURES = [
  {
    id: 'morning-moved',
    facts: {
      language: 'en',
      now: { date: 'Tuesday, September 15, 2026', time: '10:15 a.m.' },
      window: 'Oakville Fall 2026 programs',
      portal: "Oakville's portal",
      link: 'https://townofoakville.example/signin?return=course',
      situation: 'moved',
      had: '10:30 a.m.',
      pageShows: { date: 'Tuesday, September 15, 2026', time: '11:30 a.m.' },
    },
  },
  {
    id: 'morning-already-open-fr',
    facts: {
      language: 'fr',
      now: { date: 'Tuesday, September 15, 2026', time: '10:15 a.m.' },
      window: 'Oakville Fall 2026 programs',
      portal: "Oakville's portal",
      link: 'https://townofoakville.example/signin?return=course',
      situation: 'already_open',
      had: '10:30 a.m.',
      pageShows: { date: 'Tuesday, September 15, 2026', time: '9:30 a.m.' },
    },
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

function brokenOffline(evening, duty, morning) {
  const morningFacts = MORNING_FIXTURES[0].facts;
  const eveningFacts = EVENING_FIXTURES[0].facts;
  const failures = [
    evening.eveningRefusals('   ', eveningFacts),
    evening.eveningRefusals('See https://evil.example/phish tonight.', eveningFacts),
    duty.dutyNightRefusals('  '),
    duty.dutyNightRefusals('See https://evil.example/phish'),
    morning.morningRefusals('  ', morningFacts),
    morning.morningRefusals('It moved to 11:30.', morningFacts),
    morning.morningRefusals(`${morningFacts.link} https://evil.example/phish`, morningFacts),
  ];
  const kept = [
    evening.eveningRefusals('Have https://www.richmondhill.ca/programs open.', eveningFacts),
    duty.dutyNightRefusals('Sam has the swim.'),
    morning.morningRefusals(`Now 11:30: ${morningFacts.link}`, morningFacts),
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
  const argv = process.argv;
  const dry = argv.includes('--dry');
  const broken = argv.includes('--broken');
  const live = argv.includes('--live');
  const cachedOnly = argv.includes('--cached-only');
  if ([dry, broken, live, cachedOnly].filter(Boolean).length !== 1) {
    console.error('vil484: pass exactly one of --dry, --broken, --cached-only, --live');
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const evening = await importTs(EVENING_SRC);
  const duty = await importTs(DUTY_SRC);
  const morning = await importTs(MORNING_SRC);

  if (broken) {
    const ok = brokenOffline(evening, duty, morning);
    console.info(`broken-mode calibration (must fail): ${ok ? 'PASS' : 'FAIL'}`);
    console.info('live calls: 0');
    process.exit(ok ? 0 : 1);
  }

  const eveningSkill = await agent.loadSkill(join(SKILLS, 'registration-evening.md'));
  const dutySkill = await agent.loadSkill(join(SKILLS, 'duty-night.md'));
  const morningSkill = await agent.loadSkill(join(SKILLS, 'registration-morning.md'));
  const morningLane = agent.pickLane(morningSkill.meta.task);
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
        worst(
          morningLane.model,
          tokensFor(morningSkill.instructions) + tokensFor(msg) + 200,
          morning.MORNING_MAX_TOKENS,
        );
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
      if (morning.morningRefusals(draft, f.facts).length === 0) text = draft;
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
  const offline = brokenOffline(evening, duty, morning);
  const brokenOk = brokenCaught === BROKEN_DRAFTS.length && offline;
  console.info(`broken-mode calibration (must fail): ${brokenOk ? 'PASS' : 'FAIL'}`);

  const total = EVENING_FIXTURES.length + MORNING_FIXTURES.length + DUTY_FIXTURES.length;
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
