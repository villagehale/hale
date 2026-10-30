// VIL-445 carpool eval. Judges score meaning, 1 to 5. No word-matching.
//
// Paid live runs are not approved. This runner estimates or replays cache.
//
//   node evals/carpool-eval.mjs --estimate
//   node evals/carpool-eval.mjs --cached-only
//
// --estimate prices one live run of the four ticket cases
// (reader + voice, each with two attempts, plus one Haiku judge draw)
// at max_tokens and exits 0. It does not call the API.
// --cached-only replays committed cache. A miss prints that estimate and exits 1.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { JUDGE_REASON_MAX_CHARS, formatEstimate, suiteBreakdown } from './carpool-estimate.mjs';
import { CARPOOL_JUDGE_CASES } from './carpool-judge-fixtures.mjs';
import {
  JUDGE_MIN,
  REPO_ROOT,
  cacheGet,
  cacheKey,
  evalRunTag,
  isVerdict,
  readJudgeModel,
  scoreFirstJudgeSchema,
} from './lib/harness.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const READING_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'carpool-reading.md');
const VOICE_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'carpool-voice.md');
const READING_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'carpool-reading.ts');
const VOICE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'carpool-voice.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = [
  'You score ONE observation of Hale handling a group-chat carpool.',
  'Score 1-5 for meaning. Do not require particular words.',
  'Call the score tool with score first, then reason. Reason is at most',
  `${JUDGE_REASON_MAX_CHARS} characters.`,
  'A 5 matches the situation and the rubric. A 1 or 2 misses the driver,',
  'asks twice, texts through quiet hours, or reminds after a cancel.',
].join(' ');

async function dryBreakdown() {
  const agent = await importTs(AGENT_SRC);
  const reading = await importTs(READING_SRC);
  await importTs(VOICE_SRC);
  const readingSkill = await agent.loadSkill(READING_SKILL);
  const voiceSkill = await agent.loadSkill(VOICE_SKILL);
  const judgeModel = await readJudgeModel();
  const readLane = agent.pickLane(readingSkill.meta.task);
  const voiceLane = agent.pickLane(voiceSkill.meta.task);
  return suiteBreakdown({
    readModel: readLane.model,
    voiceModel: voiceLane.model,
    judgeModel,
    readingInstructions: readingSkill.instructions,
    voiceInstructions: voiceSkill.instructions,
    readingTool: reading.CARPOOL_READING_TOOL_SCHEMA,
    judgeSystem: JUDGE_SYSTEM,
    judgeSchema: scoreFirstJudgeSchema(JUDGE_REASON_MAX_CHARS),
  });
}

async function main() {
  const estimateOnly = process.argv.includes('--estimate');
  const cachedOnly = process.argv.includes('--cached-only');
  if (estimateOnly && cachedOnly) {
    console.error('carpool: pass only one of --estimate and --cached-only');
    process.exit(1);
  }
  if (!estimateOnly && !cachedOnly) {
    console.error('carpool: pass --estimate or --cached-only. This runner does not call the API.');
    process.exit(2);
  }

  const breakdown = await dryBreakdown();
  const printed = formatEstimate(breakdown);

  if (estimateOnly) {
    console.info(printed);
    return;
  }

  for (const fixture of CARPOOL_JUDGE_CASES) {
    const key = cacheKey(evalRunTag(`carpool:${fixture.id}`), fixture.situation);
    const cached = await cacheGet(key);
    if (!cached) {
      console.error(printed);
      console.error(`carpool: cache miss on ${fixture.id}. stopped. nothing recorded.`);
      process.exit(1);
    }
    const verdict = await cacheGet(cacheKey(`carpool:judge:${fixture.id}`, fixture.situation));
    if (!verdict || !isVerdict(verdict.parsed)) {
      console.error(printed);
      console.error(`carpool: judge cache miss on ${fixture.id}. stopped. nothing recorded.`);
      process.exit(1);
    }
    const score = verdict.parsed.score;
    const ok = score >= JUDGE_MIN;
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${fixture.id}  judge:${score}`);
    if (!ok) process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'carpool eval failed');
    process.exit(1);
  });
}

export { dryBreakdown, formatEstimate };
