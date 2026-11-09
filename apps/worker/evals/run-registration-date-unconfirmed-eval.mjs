// VIL-423 · the registration reminder a dated ladder leg becomes when the send-time date
// check could not confirm the stored opening on the window's own page.
//
// The subject is the REAL skill (packages/agent/skills/registration-date-unconfirmed.md)
// run through the REAL request the web composer builds (apps/web/lib/registration/
// sequence/date-unconfirmed-compose.ts): its tool, schema, token ceiling, attempts and
// refusal gate are imported live. A change to the skill, the facts or the gate re-keys
// the cache and shows up here as a miss.
//
// What is NOT tested here: which facts code hands, and that a null write sends nothing
// (run.test.ts).
//
//   node evals/run-registration-date-unconfirmed-eval.mjs --dry            # $0: worst case
//   node evals/run-registration-date-unconfirmed-eval.mjs --broken         # $0: gate calibration
//   node evals/run-registration-date-unconfirmed-eval.mjs --cached-only    # $0: replay (misses fail)
//   HALE_SPEND_LEDGER=... node --env-file=../../.env evals/run-registration-date-unconfirmed-eval.mjs --live --max-usd 1   # PAID
//
// --live and --cached-only also score the broken drafts: each states something the facts
// do not, and the judge must score every one 2 or lower, or the run fails.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { parseEvalArgsOrExit } from './lib/eval-flags.mjs';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
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

const SUITE = 'registration-date-unconfirmed';
const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', `${SUITE}.md`);
const COMPOSE_SRC = join(
  REPO_ROOT,
  'apps/web/lib/registration/sequence/date-unconfirmed-compose.ts',
);

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/** outputJsonSchema in date-unconfirmed-compose.ts. */
const TEXT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const JUDGE_SYSTEM = [
  'You score one text Hale would send a parent about a registration window for their child',
  'or children. Hale keeps an opening date on file, but the registration page did not',
  'confirm it just before this text, so the text must state no opening date. You are given',
  'the facts Hale handed the writer and the text. Score 1 to 5.',
  'A 5 says registration for the handed window is coming up, says plainly that Hale could',
  'not confirm the opening date on the page, asks the parent to check the page, carries the',
  'handed link, sounds like a friend texting in the handed language, and names no child the',
  'facts did not hand. `why` page_unreadable means Hale could not open or read the page;',
  'page_unconfirmed means Hale read it and it did not confirm the date; saying either in',
  'plain words is right. With `offer` true it asks once whether the parent wants Hale to',
  'help the morning it opens; with `offer` false it asks nothing.',
  'Score 2 or lower for any opening date, weekday, clock time or relative day ("tomorrow",',
  '"tonight", "next week") stated for the opening; for saying the date changed or blaming',
  'the town; for any claim the facts do not make (that something is booked, registered,',
  'held, paid or confirmed; a price, a course, an age band, a link not handed); for a',
  'question where `offer` is false; for the wrong language; or for a named child the facts',
  'did not hand. Do not require particular words. The `now` date is when the text is sent,',
  'not the opening. French may use tu or vous.',
  'Call the score tool.',
].join(' ');

// ── fixtures ────────────────────────────────────────────────────────────────
// Generic towns only: this repo is public.

const LINK = 'https://rec.example.org/springfield/fall-2026';

export const FIXTURES = [
  {
    id: 'heads-up-offer-unconfirmed',
    facts: {
      now: { date: 'Tuesday, September 8, 2026', time: '10:00 a.m.' },
      window: 'Springfield Fall 2026 swim lessons',
      who: 'Max and Mia',
      link: LINK,
      why: 'page_unconfirmed',
      offer: true,
      language: 'en',
    },
  },
  {
    id: 'evening-unreadable-teen',
    facts: {
      now: { date: 'Monday, September 14, 2026', time: '7:00 p.m.' },
      window: 'Springfield Fall 2026 recreation programs',
      who: 'your teen',
      link: LINK,
      why: 'page_unreadable',
      offer: false,
      language: 'en',
    },
  },
  {
    id: 'readiness-unconfirmed-fr',
    facts: {
      now: { date: 'Saturday, September 12, 2026', time: '10:00 a.m.' },
      window: 'Riverton Fall 2026 swim lessons',
      who: 'Léa',
      link: 'https://loisirs.example.org/riverton/automne-2026',
      why: 'page_unconfirmed',
      offer: false,
      language: 'fr',
    },
  },
];

const BY_ID = Object.fromEntries(FIXTURES.map((f) => [f.id, f.facts]));

/** Drafts that state what the facts do not. The judge must score each 2 or lower. */
export const BROKEN = [
  {
    id: 'broken-states-the-date',
    facts: BY_ID['heads-up-offer-unconfirmed'],
    text: `Springfield fall swim for Max and Mia opens Tuesday, Sept 15 at 7 a.m. Want my help that morning? ${LINK}`,
  },
  {
    id: 'broken-says-it-moved',
    facts: BY_ID['evening-unreadable-teen'],
    text: `Heads up: Springfield moved the fall registration date, so the old one is wrong. Check here: ${LINK}`,
  },
  {
    id: 'broken-asks-without-offer',
    facts: BY_ID['evening-unreadable-teen'],
    text: `Springfield fall registration is coming up, and I couldn't open the page to confirm the date. Want me to keep trying and text you tomorrow? ${LINK}`,
  },
];

/** --broken, offline: the composer's own gate must refuse every planted draft. */
function brokenOffline(compose) {
  const facts = BY_ID['heads-up-offer-unconfirmed'];
  const refused = [
    compose.dateUnconfirmedRefusals('   ', facts),
    compose.dateUnconfirmedRefusals('Check the page before it opens.', facts),
    compose.dateUnconfirmedRefusals(`Check ${LINK} or https://evil.example/phish`, facts),
  ];
  const kept = [
    compose.dateUnconfirmedRefusals(`Couldn't confirm the date. Check: ${LINK}`, facts),
  ];
  return refused.every((r) => r.length > 0) && kept.every((r) => r.length === 0);
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
  const raw = process.argv.slice(2);
  const modeArgs = raw.filter((a, i) => a !== '--max-usd' && raw[i - 1] !== '--max-usd');
  const knownIds = [...FIXTURES, ...BROKEN].map((f) => f.id);
  const { mode, only } = parseEvalArgsOrExit(SUITE, knownIds, modeArgs);
  if (only) {
    for (const list of [FIXTURES, BROKEN]) {
      list.splice(0, list.length, ...list.filter((f) => only.includes(f.id)));
    }
  }
  const cachedOnly = mode === 'cached-only';

  const agent = await importTs(AGENT_SRC);
  const compose = await importTs(COMPOSE_SRC);

  if (mode === 'broken') {
    const ok = brokenOffline(compose);
    console.info(`broken-mode calibration (must fail): ${ok ? 'PASS' : 'FAIL'}`);
    console.info('live calls: 0');
    process.exit(ok ? 0 : 1);
  }

  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  // The writer runs on Haiku, so the judge is the other tier. The verdict is capped, so a
  // judge draw's worst case is small.
  const judgeModel = await readJudgeModel('sonnet');
  const judgeMaxOut = JUDGE_MAX_OUTPUT_TOKENS;
  const attempts = compose.DATE_UNCONFIRMED_MAX_ATTEMPTS;
  const maxTokens = compose.DATE_UNCONFIRMED_MAX_TOKENS;

  if (mode === 'dry') {
    let usd = 0;
    let calls = 0;
    for (const f of FIXTURES) {
      const msg = JSON.stringify(f.facts);
      usd +=
        attempts *
        worst(lane.model, tokensFor(skill.instructions) + tokensFor(msg) + 200, maxTokens);
      usd +=
        JUDGE_SAMPLES_MEDIAN *
        worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 600, judgeMaxOut);
      calls += attempts + JUDGE_SAMPLES_MEDIAN;
    }
    for (const b of BROKEN) {
      const msg = JSON.stringify({ facts: b.facts, text: b.text });
      usd +=
        JUDGE_SAMPLES_MEDIAN *
        worst(judgeModel, tokensFor(JUDGE_SYSTEM) + tokensFor(msg) + 400, judgeMaxOut);
      calls += JUDGE_SAMPLES_MEDIAN;
    }
    console.info(
      `DRY ${SUITE} | worst $${usd.toFixed(6)} | ${calls} calls at most | compose=${lane.model} judge=${judgeModel} | live calls: 0`,
    );
    return;
  }

  if (mode === 'live') installEvalSpendCap();
  const cost = makeCost();
  const getClient = lazyAnthropic(SUITE);
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, SUITE, cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES_MEDIAN,
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
  });

  let failed = 0;
  for (const f of FIXTURES) {
    let text = null;
    for (let attempt = 1; attempt <= attempts && text === null; attempt += 1) {
      const { value } = await cachedToolCall({
        tag: `${SUITE}:${f.id}#${attempt}`,
        lane,
        system: skill.instructions,
        userMessage: JSON.stringify(f.facts),
        toolName: compose.DATE_UNCONFIRMED_TOOL.name,
        toolDescription: compose.DATE_UNCONFIRMED_TOOL.description,
        toolSchema: TEXT_SCHEMA,
        maxTokens,
        cachedOnly,
        getClient,
        cost,
      });
      const draft = String(value?.text ?? '').trim();
      const refusals = compose.dateUnconfirmedRefusals(draft, f.facts);
      if (refusals.length === 0) text = draft;
      else console.info(`     refused ${f.id}#${attempt}: ${refusals.join(',')}`);
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

  let caught = 0;
  for (const b of BROKEN) {
    const verdict = await judge(b.id, { facts: b.facts, text: b.text });
    const low = verdict.score <= 2;
    if (low) caught += 1;
    console.info(
      `${low ? 'BROKEN-FAILS (good)' : 'BROKEN-PASSED (bad)'} ${b.id} | judge ${verdict.score}`,
    );
  }
  const brokenOk = caught === BROKEN.length && brokenOffline(compose);
  console.info(`broken-mode calibration (must fail): ${brokenOk ? 'PASS' : 'FAIL'}`);
  console.info(
    `${SUITE} | ${FIXTURES.length - failed} of ${FIXTURES.length} passed | live calls: ${cost.liveCalls} | spent $${totalUsd(cost).toFixed(6)}`,
  );
  if (failed > 0 || !brokenOk) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : `${SUITE} eval failed`);
    process.exit(1);
  });
}
