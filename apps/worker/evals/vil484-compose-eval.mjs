// VIL-484 · evening registration text and co-parent night-before text.
//
// The model writes the whole text from facts. This file is not named run-*.mjs,
// so the Monday eval sweep does not pick it up, and it is not in ci.yml.
// It does not call a model. --dry prices the worst case. --broken checks that
// an empty draft and an unhanded link fail the send gate.
//
//   node apps/worker/evals/vil484-compose-eval.mjs --dry
//   node apps/worker/evals/vil484-compose-eval.mjs --broken

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { worstCaseUsd } from '../../web/lib/testing/spend-cap.mjs';
import { PRICE, REPO_ROOT, readJudgeModel } from './lib/harness.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const EVENING_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'registration-evening.md');
const DUTY_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'duty-night.md');
const EVENING_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'registration',
  'sequence',
  'evening-compose.ts',
);
const DUTY_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'coparent',
  'duty',
  'night-compose.ts',
);

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_MAX_TOKENS = 1024;
const TEXT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    facts: { type: 'integer', minimum: 1, maximum: 5 },
    tone: { type: 'integer', minimum: 1, maximum: 5 },
    privacy: { type: 'integer', minimum: 1, maximum: 5 },
    reason: { type: 'string' },
  },
  required: ['facts', 'tone', 'privacy', 'reason'],
};

const JUDGE_SYSTEM = [
  'You score one text Hale would send a parent. You are given the facts Hale handed',
  'the writer and the text. Score three integers from 1 to 5.',
  'facts: 5 uses only the handed facts and keeps times, names, links, and the',
  'situation. 1 invents a seat, a price, a signup, a second link, or a child.',
  'tone: 5 sounds like a friend texting, in the handed language, with the day',
  'phrased from the dates. 1 is a form letter or the wrong language.',
  'privacy: 5 keeps a generic such as "your teen" generic and does not name a',
  'child the facts left null. 1 names a child who was not handed.',
  'Do not require particular words. Call the score tool.',
].join(' ');

const EVENING_FIXTURES = [
  {
    id: 'evening-municipal-teen',
    facts: {
      language: 'en',
      now: { date: 'Monday, September 14, 2026', time: '6:00 p.m.' },
      window: 'Richmond Hill Fall 2026 recreation programs',
      who: 'your teen',
      opensAt: '6:30 a.m.',
      opensOn: 'Tuesday, September 15, 2026',
      link: 'https://www.toronto.ca/programs',
      portal: null,
      setup: null,
      situation: 'municipal',
      courseName: null,
      ageBand: null,
      children: 1,
    },
  },
  {
    id: 'evening-course-not-told',
    facts: {
      language: 'fr',
      now: { date: 'Monday, September 14, 2026', time: '6:00 p.m.' },
      window: 'Markham 2026 Fall Programs',
      who: 'Maya',
      opensAt: '10:30 a.m.',
      opensOn: 'Tuesday, September 15, 2026',
      link: 'https://townofoakville.example/course',
      portal: "Oakville's portal",
      setup: 'not_told',
      situation: 'course',
      courseName: 'Preschool Sports',
      ageBand: null,
      children: 1,
    },
  },
];

const DUTY_FIXTURES = [
  {
    id: 'duty-night-named',
    facts: {
      language: 'en',
      now: { date: 'Sunday, September 27, 2026', time: '7:00pm' },
      handoff: {
        name: 'Sam',
        kid: 'Maya',
        event: 'swim',
        time: '3:00pm',
        date: 'Monday, September 28, 2026',
      },
      unowned: null,
      quiet: null,
    },
  },
  {
    id: 'duty-night-unnamed',
    facts: {
      language: 'fr',
      now: { date: 'Sunday, September 27, 2026', time: '7:00pm' },
      handoff: {
        name: 'Sam',
        kid: null,
        event: 'swim',
        time: '3:00pm',
        date: 'Monday, September 28, 2026',
      },
      unowned: {
        kid: null,
        event: 'piano',
        day: 'Tuesday',
        time: '10:00am',
      },
      quiet: { name: 'Barton' },
    },
  },
];

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) <= 0x024f) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

function rates(model) {
  const price = PRICE[model];
  if (!price) throw new Error(`no list price for ${model}`);
  return { input: price.input, output: price.output };
}

function composeRequest(model, system, user, toolName, description, maxTokens) {
  return {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    tools: [{ name: toolName, description, input_schema: TEXT_SCHEMA }],
  };
}

function judgeRequest(model, facts, text) {
  const user = JSON.stringify({ facts, text });
  return {
    model,
    max_tokens: JUDGE_MAX_TOKENS,
    system: [{ type: 'text', text: JUDGE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    tools: [
      {
        name: 'score',
        description: 'Score facts, tone, and privacy.',
        input_schema: JUDGE_SCHEMA,
      },
    ],
  };
}

function priceRequest(request) {
  const input =
    estimateTokens(request.system) +
    estimateTokens(request.messages) +
    estimateTokens(request.tools);
  return worstCaseUsd(rates, request, input);
}

async function main() {
  const dry = process.argv.includes('--dry');
  const broken = process.argv.includes('--broken');
  if (!dry && !broken) {
    console.error('vil484: pass --dry or --broken. This runner does not call a model.');
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const evening = await importTs(EVENING_SRC);
  const duty = await importTs(DUTY_SRC);
  const eveningSkill = await agent.loadSkill(EVENING_SKILL);
  const dutySkill = await agent.loadSkill(DUTY_SKILL);
  const judgeModel = await readJudgeModel();
  const speak = agent.pickLane('speak').model;

  if (dry) {
    let usd = 0;
    for (const fixture of EVENING_FIXTURES) {
      const request = composeRequest(
        speak,
        eveningSkill.instructions,
        evening.eveningUserMessage(fixture.facts),
        'registration_evening_text',
        'The one text Hale sends the parent the evening before registration opens.',
        evening.EVENING_MAX_TOKENS,
      );
      usd += priceRequest(request);
      usd += priceRequest(judgeRequest(judgeModel, fixture.facts, ''));
    }
    for (const fixture of DUTY_FIXTURES) {
      const request = composeRequest(
        speak,
        dutySkill.instructions,
        duty.dutyNightUserMessage(fixture.facts),
        'duty_night_text',
        'The one text Hale sends the group the evening before.',
        duty.DUTY_NIGHT_MAX_TOKENS,
      );
      usd += priceRequest(request);
      usd += priceRequest(judgeRequest(judgeModel, fixture.facts, ''));
    }
    const brokenJudges = [
      judgeRequest(judgeModel, EVENING_FIXTURES[0].facts, 'https://evil.example/phish'),
      judgeRequest(judgeModel, DUTY_FIXTURES[0].facts, ''),
    ];
    for (const request of brokenJudges) usd += priceRequest(request);
    console.info(`DRY total | worst $${usd.toFixed(6)} | live calls: 0`);
  }

  if (broken) {
    const eveningFacts = EVENING_FIXTURES[0].facts;
    const failures = [
      evening.eveningRefusals('   ', eveningFacts),
      evening.eveningRefusals('See https://evil.example/phish tonight.', eveningFacts),
      duty.dutyNightRefusals('  '),
      duty.dutyNightRefusals('See https://evil.example/phish'),
    ];
    const kept = [
      evening.eveningRefusals('Have https://www.toronto.ca/programs open.', eveningFacts),
      duty.dutyNightRefusals('Sam has the swim.'),
    ];
    const brokenFail = failures.every((found) => found.length > 0);
    const cleanPass = kept.every((found) => found.length === 0);
    if (!brokenFail || !cleanPass) {
      console.error('broken-mode calibration (must fail): FAIL');
      console.error({ failures, kept });
      process.exit(1);
    }
    console.info('broken-mode calibration (must fail): PASS');
    console.info('live calls: 0');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'vil484 eval failed');
    process.exit(1);
  });
}
