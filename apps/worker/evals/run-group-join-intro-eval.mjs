// The group join intro · composer eval (VIL-727, hard rule #8: no LLM mocking).
//
// SUBJECT: the REAL skill (packages/agent/skills/group-join-intro.md) over the REAL input:
// `groupJoinIntroClaims` and `groupOnboardingLineInput` are imported from
// group-onboarding-line-input.ts, not replicated, so each case is what production hands the
// model for that group. The tool shape mirrors the forced-tool branch of productionComposer
// in group-onboarding-voice.ts (`send_group_line`: `line`, or `before` + `question`), and the
// code gate is the `join_intro` branch of its `lineUsable`: exactly one question when the
// intro asks and none when it does not, no link, and `Hale` (plus a household's parent
// name) carried word for word. Whether the intro states every claim and nothing beyond
// them, in the right language and register, is the judge's call. The input builder reads
// no flag, so GROUP_JOIN_INTRO_ENABLED does not matter here.
//
// NOT YET RECORDED. This suite has no cached responses and no CI step until one paid run
// records them (ANTHROPIC_API_KEY_TEST, one run per PR):
//   HALE_SPEND_LEDGER=/tmp/ledger.json node evals/run-group-join-intro-eval.mjs --dry
//   HALE_SPEND_LEDGER=... node evals/run-group-join-intro-eval.mjs --live --max-usd 0.50
//   node evals/run-group-join-intro-eval.mjs --cached-only            # CI: replay only
//   node evals/run-group-join-intro-eval.mjs --broken --cached-only   # calibration: must FAIL

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { GROUP_JOIN_INTRO_FIXTURES } from './group-join-intro-fixtures.mjs';
import { loadHasLinkShape } from './lib/has-link-shape.mjs';
import {
  JUDGE_MIN,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-join-intro.md');
const INPUT_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-onboarding-line-input.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** maxTokens for the full prompt in productionComposer. */
const MAX_TOKENS = 400;

const ASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { before: { type: 'string' }, question: { type: 'string' } },
  required: ['before', 'question'],
};

const LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { line: { type: 'string' } },
  required: ['line'],
};

/** Words an intro must never teach. Checked on Hale's own output, never on a parent's. */
const OPT_OUT_WORDS = ['STOP', 'HELP', 'START', 'UNSUBSCRIBE', 'ARRET', 'ARRÊT', 'AIDE'];

const JUDGE_SYSTEM = judgePrompt('group-join-intro');

const BROKEN =
  'Welcome!! We read all your emails and calendars 🎉 Reply STOP to opt out or HELP for help. Who are you? Which kid? www.example.com';

let hasLinkShape = () => {
  throw new Error('hasLinkShape is not loaded');
};

/** Question marks, the full-width one included: mirrors `questionMarks` in the composer. */
function questionMarks(text) {
  return [...text].filter((ch) => ch === '?' || ch === '？').length;
}

function optOutWord(text) {
  const words = text.toUpperCase().split(/[^\p{L}]+/u);
  return OPT_OUT_WORDS.find((word) => words.includes(word)) ?? null;
}

/** The `join_intro` branch of `lineUsable`, plus the opt-out words the skill forbids. */
function refusals(body, input) {
  if (body.trim().length === 0) return ['empty'];
  const found = [];
  const asked = questionMarks(body);
  if (asked !== input.questions) found.push(`questions:${asked} (want ${input.questions})`);
  if (hasLinkShape(body)) found.push('carries_link');
  for (const slot of input.mustMention) {
    if (!body.includes(slot)) found.push(`missing:${slot}`);
  }
  const word = optOutWord(body);
  if (word) found.push(`opt_out_word:${word}`);
  return found;
}

function requestFor(fixture, groupJoinIntroClaims) {
  return {
    kind: 'join_intro',
    audience: fixture.audience,
    knownParentName: fixture.knownParentName,
    adderName: fixture.adderName,
    claims: groupJoinIntroClaims({
      audience: fixture.audience,
      otherPeople: fixture.otherPeople,
      turnReaderLive: fixture.turnReaderLive,
      mailNoticeLive: fixture.mailNoticeLive,
    }),
    ask: fixture.ask,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  assertRunFlags(['--broken', '--max-usd'], argv);
  hasLinkShape = await loadHasLinkShape();
  const broken = argv.includes('--broken');
  const cachedOnly = argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('group-join-intro');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { groupJoinIntroClaims, groupOnboardingLineInput } = await importTs(INPUT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'group-join-intro', cachedOnly, getClient, cost);

  console.log(
    `group-join-intro eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''}${isDryRun() ? ' (dry)' : ''} | compose=${lane.model} judge=${judgeModel} | fixtures=${GROUP_JOIN_INTRO_FIXTURES.length}`,
  );
  const results = [];
  for (const fixture of GROUP_JOIN_INTRO_FIXTURES) {
    const input = groupOnboardingLineInput(
      requestFor(fixture, groupJoinIntroClaims),
      fixture.language,
    );
    const userMessage = JSON.stringify({ ...input, retry: false });
    const asks = input.questions === 1;
    let body;
    if (broken) {
      body = BROKEN;
    } else {
      const value = (
        await cachedToolCall({
          tag: `group-join-intro:${fixture.id}`,
          lane,
          system: skill.instructions,
          userMessage,
          toolName: 'send_group_line',
          toolSchema: asks ? ASK_SCHEMA : LINE_SCHEMA,
          toolDescription: 'The one message Hale sends.',
          maxTokens: MAX_TOKENS,
          cachedOnly,
          getClient,
          cost,
        })
      ).value;
      body = (asks ? [value.before, value.question].filter(Boolean).join(' ') : (value.line ?? ''))
        .trim();
    }
    // A dry run's body is a worst-case stand-in, never a reply: price it, do not grade it.
    const failures = isDryRun() ? [] : refusals(body, input);
    // Production never sends a line the code gate refuses, so the judge is asked only
    // about a sendable one (a dry run prices the judge for every case).
    if (failures.length === 0) {
      const verdict = await judge(fixture.id, {
        input: userMessage,
        message: body,
        watchFor: fixture.watchFor,
      });
      if (!verdict.dry && verdict.score < JUDGE_MIN) {
        failures.push(`judge:${verdict.score} (${verdict.reason})`);
      }
    }
    results.push({ fixture, claims: input.facts.claims, body, failures });
  }

  for (const r of results) {
    if (isDryRun()) {
      console.log(`DRY   ${r.fixture.id.padEnd(26)} [${r.claims.join(', ')}]`);
      continue;
    }
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} [${r.claims.join(', ')}] "${r.body.slice(0, 160)}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('group-join-intro', [judge.plan]));
    process.exit(0);
  }
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('group-join-intro eval harness error:', err);
  process.exit(2);
});
