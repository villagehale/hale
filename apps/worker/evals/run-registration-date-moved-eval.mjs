// VIL-423 · slice 4b — the change note a household gets when the scheduled re-read
// found that the registration page moved an opening Hale had already told them.
//
// The subject is the REAL skill (packages/agent/skills/registration-date-moved.md) run
// through the REAL request the web composer builds (apps/web/lib/registration/sequence/
// date-moved-compose.ts): its tool, schema, token ceiling, attempts and refusal gate are
// imported live. A change to the skill, the facts or the gate re-keys the cache and shows
// up here as a miss.
//
// What is NOT tested here: which households are owed a note, and that a null write sends
// nothing (date-recheck.pglite.test.ts).
//
//   node evals/run-registration-date-moved-eval.mjs --dry            # $0: worst case
//   node evals/run-registration-date-moved-eval.mjs --broken         # $0: gate calibration
//   node evals/run-registration-date-moved-eval.mjs --cached-only    # $0: replay (misses fail)
//   HALE_SPEND_LEDGER=... node --env-file=../../.env evals/run-registration-date-moved-eval.mjs --live --max-usd 1   # PAID
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
import { judgePrompt } from './lib/judge-prompt.mjs';

const SUITE = 'registration-date-moved';
const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', `${SUITE}.md`);
const COMPOSE_SRC = join(REPO_ROOT, 'apps/web/lib/registration/sequence/date-moved-compose.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/** outputJsonSchema in date-moved-compose.ts. */
const TEXT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const JUDGE_SYSTEM = judgePrompt('registration-date-moved');

// ── fixtures ────────────────────────────────────────────────────────────────
// Generic towns only: this repo is public.

const LINK = 'https://rec.example.org/springfield/fall-2026';

export const FIXTURES = [
  {
    id: 'moved-earlier-with-time',
    facts: {
      now: { date: 'Tuesday, September 15, 2026', time: '12:00 p.m.' },
      window: 'Springfield Fall 2026 swim lessons',
      who: 'Max and Mia',
      link: LINK,
      was: { date: 'Sunday, September 20, 2026', time: '10:00 a.m.' },
      opens: { date: 'Friday, September 18, 2026', time: '10:00 a.m.' },
      language: 'en',
    },
  },
  {
    id: 'moved-later-no-time-teen',
    facts: {
      now: { date: 'Monday, September 14, 2026', time: '9:00 a.m.' },
      window: 'Springfield Fall 2026 recreation programs',
      who: 'your teen',
      link: LINK,
      was: { date: 'Wednesday, September 16, 2026', time: '7:00 a.m.' },
      opens: { date: 'Wednesday, September 23, 2026', time: null },
      language: 'en',
    },
  },
  {
    id: 'moved-earlier-fr',
    facts: {
      now: { date: 'Saturday, September 12, 2026', time: '10:00 a.m.' },
      window: 'Riverton Fall 2026 swim lessons',
      who: 'Léa',
      link: 'https://loisirs.example.org/riverton/automne-2026',
      was: { date: 'Monday, September 21, 2026', time: '6:30 a.m.' },
      opens: { date: 'Thursday, September 17, 2026', time: '6:30 a.m.' },
      language: 'fr',
    },
  },
];

const BY_ID = Object.fromEntries(FIXTURES.map((f) => [f.id, f.facts]));

/** Drafts that state what the facts do not. The judge must score each 2 or lower. */
export const BROKEN = [
  {
    id: 'broken-states-the-old-date',
    facts: BY_ID['moved-earlier-with-time'],
    text: `Reminder: Springfield fall swim for Max and Mia opens Sunday, Sept 20 at 10 a.m. ${LINK}`,
  },
  {
    id: 'broken-invents-a-time',
    facts: BY_ID['moved-later-no-time-teen'],
    text: `Springfield moved fall registration to Wednesday, Sept 23 at 7 a.m. Set an alarm. ${LINK}`,
  },
  {
    id: 'broken-claims-a-spot',
    facts: BY_ID['moved-earlier-with-time'],
    text: `Springfield moved swim registration up to Friday, Sept 18 at 10 a.m. I've held spots for Max and Mia. ${LINK}`,
  },
];

/** --broken, offline: the composer's own gate must refuse every planted draft. The
 * writer is handed no link, so any link it writes is refused, the handed page included. */
function brokenOffline(compose) {
  const refused = [
    compose.dateMovedRefusals('   '),
    compose.dateMovedRefusals(`It moved: ${LINK}`),
    compose.dateMovedRefusals('It moved, see https://rec.example.org.evil.com/x'),
    compose.dateMovedRefusals('It moved, see bit.ly/x'),
  ];
  const kept = [compose.dateMovedRefusals('It moved to Fri. Sept 18 at 10:00 a.m.')];
  return refused.every((r) => r.length > 0) && kept.every((r) => r.length === 0);
}

/** The writer's request as production builds it: the facts without the link, which code
 * appends after the draft. */
function writerMessage(facts) {
  const { link: _link, ...handed } = facts;
  return JSON.stringify(handed);
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
  const attempts = compose.DATE_MOVED_MAX_ATTEMPTS;
  const maxTokens = compose.DATE_MOVED_MAX_TOKENS;

  if (mode === 'dry') {
    let usd = 0;
    let calls = 0;
    for (const f of FIXTURES) {
      const msg = writerMessage(f.facts);
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
        userMessage: writerMessage(f.facts),
        toolName: compose.DATE_MOVED_TOOL.name,
        toolDescription: compose.DATE_MOVED_TOOL.description,
        toolSchema: TEXT_SCHEMA,
        maxTokens,
        cachedOnly,
        getClient,
        cost,
      });
      const draft = String(value?.text ?? '').trim();
      const refusals = compose.dateMovedRefusals(draft);
      if (refusals.length === 0) text = compose.dateMovedBody(draft, f.facts.link);
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
