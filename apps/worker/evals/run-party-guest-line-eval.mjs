// VIL-745 · the day-before reminder and the host-cancelled note a party guest gets, written
// by the model with PARTY_GUEST_MODEL_COPY_ENABLED on (hard rule #8: no LLM mocking).
//
// SUBJECT, called the way production calls it: packages/agent/skills/party-guest-line.md
// through apps/web/lib/party/guest-voice.ts (its user message, tool, lanes and gate).
//
// RECORDING PENDING. Nothing is recorded yet. While RECORDING_PENDING is true, --cached-only
// runs the --dry projection: it scores any case that IS recorded, lists the ones that are
// not, prices them, and exits 0 unless a recorded case fails. After the one paid record
// run, set it to false and commit the cache: --cached-only then replays, and a miss fails.
//
//   node evals/run-party-guest-line-eval.mjs --dry
//   node evals/run-party-guest-line-eval.mjs --broken --cached-only   # must catch a bad text
//   HALE_SPEND_LEDGER=... node evals/run-party-guest-line-eval.mjs --live --max-usd 1
//   node evals/run-party-guest-line-eval.mjs --cached-only

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  REPO_ROOT,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';
import { PARTY_GUEST_LINE_FIXTURES, partyGuestLineMisses } from './party-guest-line-fixtures.mjs';

const RECORDING_PENDING = true;

const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'party-guest-line.md');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const VOICE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'party', 'guest-voice.ts');
const SPOKEN_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'spoken-line.ts');

const JUDGE_SYSTEM = judgePrompt('party-guest-line');
const BROKEN_TEXT = 'Party tomorrow!! Reply STOP to opt out, or tap here for 20% off Hale.';

register({ tsconfig: join(REPO_ROOT, 'apps', 'web', 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

async function subjects() {
  const [agent, voice, spoken] = await Promise.all([
    importTs(AGENT_SRC),
    importTs(VOICE_SRC),
    importTs(SPOKEN_SRC),
  ]);
  const skill = await agent.loadSkill(SKILL);
  const first = agent.pickLane(skill.meta.task);
  return { voice, skill, lanes: [first, spoken.smallerLane(first)] };
}

function runBroken(voice) {
  const passed = PARTY_GUEST_LINE_FIXTURES.filter((fixture) => {
    const accepted = voice.acceptPartyGuestLine(BROKEN_TEXT, fixture.line);
    return accepted !== null && partyGuestLineMisses(accepted, fixture).length === 0;
  });
  console.info(`broken-mode calibration: ${passed.length} of the bad texts passed (must be 0)`);
  process.exit(passed.length === 0 ? 0 : 1);
}

async function run(mode) {
  const live = mode === 'live';
  if (live) installEvalSpendCap();
  if (mode === 'dry') process.env.HALE_EVAL_DRY = '1';
  const cachedOnly = mode === 'cached-only';
  const getClient = lazyAnthropic('party-guest-line');
  const cost = makeCost();
  const { voice, skill, lanes } = await subjects();
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'party-guest-line',
    cachedOnly,
    getClient,
    cost,
  );
  console.info(
    `party-guest-line | ${mode}${RECORDING_PENDING ? ' | recording pending' : ''} | write=${lanes[0].model} retry=${lanes[1].model} judge=${judgeModel} | cases=${PARTY_GUEST_LINE_FIXTURES.length}`,
  );

  const results = [];
  for (const fixture of PARTY_GUEST_LINE_FIXTURES) {
    const userMessage = voice.partyGuestLineUserMessage(fixture.line);
    let body = null;
    let unrecorded = false;
    let standIn = '';
    for (const [index, lane] of lanes.entries()) {
      const answer = await cachedToolCall({
        tag: `party-guest-line:${fixture.id}${index === 0 ? '' : ':retry'}`,
        lane,
        system: skill.instructions,
        userMessage,
        toolName: voice.PARTY_GUEST_LINE_TOOL.name,
        toolDescription: voice.PARTY_GUEST_LINE_TOOL.description,
        toolSchema: voice.PARTY_GUEST_LINE_TOOL.inputSchema,
        maxTokens: voice.PARTY_GUEST_LINE_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      if (answer.dry) {
        // Priced on both lanes, the most a recording could spend on this case.
        unrecorded = true;
        standIn = String(answer.value?.text ?? '');
        continue;
      }
      body = voice.acceptPartyGuestLine(String(answer.value?.text ?? ''), fixture.line);
      if (body) break;
    }
    const failures = [];
    const verdict = await judge(fixture.id, {
      request: userMessage,
      message: body ?? standIn,
      watchFor: fixture.watchFor,
    });
    if (!unrecorded) {
      if (!body) failures.push('unwritten');
      else failures.push(...partyGuestLineMisses(body, fixture));
      if (body && verdict.score < JUDGE_MIN) {
        failures.push(`judge:${verdict.score} (${verdict.reason})`);
      }
    }
    results.push({ fixture, body, unrecorded, failures });
  }

  for (const r of results) {
    const state = r.unrecorded ? 'UNRECORDED' : r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.info(`${state.padEnd(10)} ${r.fixture.id.padEnd(26)} ${r.body ? `"${r.body}"` : ''}`);
    for (const failure of r.failures) console.info(`           · ${failure}`);
  }
  const unrecorded = results.filter((r) => r.unrecorded).length;
  const failed = results.filter((r) => r.failures.length > 0).length;
  if (mode === 'dry') console.info(dryReportLine('party-guest-line', [judge.plan]));
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD | unrecorded ${unrecorded} | failed ${failed}`,
  );
  const ok = failed === 0 && (live || mode === 'dry' || unrecorded === 0);
  console.info(`overall: ${ok ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(ok ? 0 : 1);
}

async function main() {
  const raw = process.argv.slice(2);
  assertRunFlags(['--max-usd', '--broken'], raw);
  if (raw.includes('--broken')) return runBroken((await subjects()).voice);
  if (raw.includes('--live')) return run('live');
  if (raw.includes('--dry') || (raw.includes('--cached-only') && RECORDING_PENDING)) {
    return run('dry');
  }
  return run('cached-only');
}

main().catch((err) => {
  console.error('party-guest-line eval harness error:', err);
  process.exit(2);
});
