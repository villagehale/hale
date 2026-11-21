// The reminder with what to bring · composer eval (VIL-720; hard rule #8: no LLM mocking).
//
// The subject is the REAL reminder writer as production runs it once an event carries a
// bring list: `reminderFacts`, `reminderUserMessage`, `reminderRefusals`,
// `reminderInstructions` and `factsCarryBringItems` are imported from
// apps/web/lib/loop/reminders/compose.ts, and the system prompt is reminder.md with the
// reminder-bring.md addendum appended. The model writes the whole text. The judge is the
// reminder suite's own (judges/reminder.md, three draws, lowest kept); each fixture's
// `watchFor` names the list, so a dropped item, an added one, or one tied to the wrong
// event scores low. Nothing matches words.
//
// A reminder with no list sends today's request byte for byte, so the recorded reminder
// suite (run-reminder-eval.mjs) is untouched by VIL-720 and needs no re-record.
//
//   node evals/run-reminder-bring-eval.mjs --dry           # $0, no API: worst-case $
//   node evals/run-reminder-bring-eval.mjs --broken        # calibration: every case must FAIL
//                                                          #   (judge draws: cached-only)
//   node evals/run-reminder-bring-eval.mjs --cached-only   # replay only, $0 (a miss fails)
//   node --env-file=../../.env evals/run-reminder-bring-eval.mjs --live   # PAID: Barton's yes
// Exactly one mode (lib/eval-flags.mjs).
//
// NOT in CI yet: there is no recorded cache, and recording it is a paid run (pending Noah).

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { estimateTokens, noClient, parseEvalFlagsOrExit, worstCaseUsd } from './lib/eval-flags.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';
import { reminderJudgeModel } from './lib/reminder-judge-model.mjs';
import {
  REMINDER_BRING_BROKEN_CASES,
  REMINDER_BRING_FIXTURES,
} from './reminder-bring-fixtures.mjs';
import {
  REMINDER_JUDGE_MAX_OUTPUT_TOKENS,
  boldLine,
  readBold,
  readTexts,
} from './run-reminder-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'reminder.md');
const ADDENDUM_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'reminder-bring.md');
const COMPOSE_SRC = join(WEB_ROOT, 'lib', 'loop', 'reminders', 'compose.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

// Mirrors compose.ts (VIL-467): the model returns the texts it chose to send, in order.
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    texts: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      description: 'The texts Hale sends the parent, in order. One or more.',
    },
    bold: {
      type: 'string',
      description:
        'Optional. The exact words, copied from one of your texts, to show in bold. Leave it out for none.',
    },
  },
  required: ['texts'],
};
const MAX_TOKENS = 1024;
const JUDGE_SAMPLES = 3;

async function load() {
  const agent = await importTs(AGENT_SRC);
  const compose = await importTs(COMPOSE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const addendum = await agent.loadSkill(ADDENDUM_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const system = compose.reminderInstructions(skill.instructions, addendum.instructions);
  const cases = REMINDER_BRING_FIXTURES.map((fixture) => {
    const facts = compose.reminderFacts({ ...fixture.args, now: new Date(fixture.args.now) });
    // Production appends the addendum only when a list reached the facts; so must the eval.
    if (!compose.factsCarryBringItems(facts)) {
      throw new Error(`${fixture.id}: no bringItems reached the facts`);
    }
    return { fixture, facts, userMessage: compose.reminderUserMessage(facts) };
  });
  return { agent, compose, lane, system, cases };
}

async function main() {
  const mode = parseEvalFlagsOrExit('reminder-bring');
  if (mode === 'dry') return dryRun();
  const broken = mode === 'broken';
  const cachedOnly = mode !== 'live';
  installEvalSpendCap();
  const getClient = mode === 'live' ? lazyAnthropic('reminder-bring') : noClient('reminder-bring');
  const cost = makeCost();
  const { agent, compose, lane, system, cases } = await load();
  const judgeModel = reminderJudgeModel(process.env, agent);
  const judge = makeJudge(
    judgeModel,
    judgePrompt('reminder'),
    'reminder-bring',
    cachedOnly,
    getClient,
    cost,
    {
      samples: JUDGE_SAMPLES,
      aggregate: 'min',
      maxOutputTokens: REMINDER_JUDGE_MAX_OUTPUT_TOKENS,
    },
  );
  console.log(
    `reminder-bring eval | mode=${mode} | compose=${lane.model} judge=${judgeModel} | ${cases.length} cases`,
  );

  const results = [];
  const score = async (tag, c, texts, bold, kind) => {
    const body = [...texts.map((t, i) => `[text ${i + 1}] ${t}`), boldLine(texts, bold)].join('\n');
    const failures = compose.reminderRefusals(texts, c.facts).map((r) => `unsendable:${r}`);
    const verdict = await judge(tag, {
      input: c.userMessage,
      text: body,
      watchFor: c.fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ tag, body, failures, scores: verdict.samples, kind });
  };

  if (!broken) {
    for (const c of cases) {
      const { value } = await cachedToolCall({
        tag: `reminder-bring:${c.fixture.id}`,
        lane,
        system,
        userMessage: c.userMessage,
        toolName: 'reminder_texts',
        toolSchema: TOOL_SCHEMA,
        toolDescription: 'The texts Hale sends the parent, in order.',
        maxTokens: MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      await score(c.fixture.id, c, readTexts(value), readBold(value), 'normal');
    }
  } else {
    for (const bc of REMINDER_BRING_BROKEN_CASES) {
      const c = cases.find((x) => x.fixture.id === bc.fixtureId);
      if (!c) throw new Error(`broken case ${bc.tag}: no fixture ${bc.fixtureId}`);
      await score(bc.tag, c, bc.body.split('\n'), null, 'broken');
    }
  }

  for (const r of results) {
    console.log(`${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.tag.padEnd(48)} "${r.body}"`);
    console.log(`      · scores [${(r.scores ?? []).join(', ')}]`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const failed = results.filter((r) => r.failures.length > 0).length;
  if (!broken) process.exit(failed === 0 ? 0 : 1);
  const calibrated = failed === results.length;
  console.log(
    `broken-mode calibration (every case must fail): ${calibrated ? 'PASS' : `FAIL (${results.length - failed} passed)`}`,
  );
  process.exit(calibrated ? 0 : 1);
}

/** $0: no client, no spend cap. Every compose and judge draw priced as uncached. */
async function dryRun() {
  const { agent, lane, system, cases } = await load();
  const judgeModel = reminderJudgeModel(process.env, agent);
  const judgeSystem = judgePrompt('reminder');
  console.log(
    `reminder-bring eval | mode=dry (no API calls) | compose=${lane.model} judge=${judgeModel}`,
  );
  let worst = 0;
  const price = (tag, model, inTokens, maxOut) => {
    const usd = worstCaseUsd(model, inTokens, maxOut);
    worst += usd;
    console.log(
      `DRY  uncached  ${tag}  ~${inTokens} in + ${maxOut} max out  worst $${usd.toFixed(5)}`,
    );
  };
  for (const c of cases) {
    price(
      `reminder-bring:${c.fixture.id}`,
      lane.model,
      estimateTokens(system + c.userMessage + JSON.stringify(TOOL_SCHEMA)),
      MAX_TOKENS,
    );
  }
  // The judge reads the facts, a reply as long as the compose cap and watchFor, three draws
  // per reply; --broken scores its stand-in bodies with the same judge.
  const judged = [
    ...cases.map((c) => ({ tag: c.fixture.id, c })),
    ...REMINDER_BRING_BROKEN_CASES.map((bc) => ({
      tag: bc.tag,
      c: cases.find((x) => x.fixture.id === bc.fixtureId),
    })),
  ];
  for (const { tag, c } of judged) {
    const inTokens = estimateTokens(judgeSystem + c.userMessage + c.fixture.watchFor) + MAX_TOKENS;
    for (let i = 0; i < JUDGE_SAMPLES; i += 1) {
      price(
        `reminder-bring:judge:${tag}${i ? `#${i}` : ''}`,
        judgeModel,
        inTokens,
        REMINDER_JUDGE_MAX_OUTPUT_TOKENS,
      );
    }
  }
  console.log(
    `DRY summary | ${cases.length} compose + ${judged.length * JUDGE_SAMPLES} judge draws, all priced as uncached | worst $${worst.toFixed(5)}`,
  );
  console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
}

main().catch((err) => {
  console.error('reminder-bring eval harness error:', err);
  process.exit(2);
});
