// Group plan -> per-family invites · attendance read + private-note eval (VIL-455,
// hard rule #8: no LLM mocking).
//
// Subjects are the REAL skills (group-plan-attendance-read.md, group-plan-invite-note.md)
// through the REAL request builders imported from group-plan-invites.ts. The attendance
// gate is the label per family. The note gate is a judge (Haiku tier, not the subject's
// own model) against the skill's rules. No word in any message is checked.
//
//   node evals/run-group-plan-invites-eval.mjs --dry           # $0, no API: worst-case $
//   node evals/run-group-plan-invites-eval.mjs --broken        # $0 calibration: must FAIL
//   node evals/run-group-plan-invites-eval.mjs --cached-only   # CI: replay only, $0
//   node --env-file=../../.env evals/run-group-plan-invites-eval.mjs --live   # PAID
// Exactly one mode (lib/eval-flags.mjs).

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { ATTENDANCE_FIXTURES, NOTE_FIXTURES } from './group-plan-invites-fixtures.mjs';
import { estimateTokens, noClient, parseEvalFlagsOrExit, worstCaseUsd } from './lib/eval-flags.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const READ_SKILL = join(SKILLS, 'group-plan-attendance-read.md');
const NOTE_SKILL = join(SKILLS, 'group-plan-invite-note.md');
const SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-plan-invites.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const READ_MAX = 400;
const NOTE_MAX = 400;
const JUDGE_MAX = 1024;

const JUDGE_SYSTEM = `You grade one private text a family assistant sends to ONE parent after a group plan's calendar copy failed for that family.
You get the input (plan, family, failure kind) and the text. Score 1-5:
5 = names the plan and when, says plainly what did not go through for the given failure kind, warm and brief, no technical words or error codes, no other family's details, promises nothing the input does not support.
3 = right facts but stiff, vague about what failed, or a little long.
1 = wrong failure, invents facts or promises, mentions other families, technical or blaming, or reads like a fixed template.
Return score and a short reason.`;

/** A wrong reading per family: invites everyone. Must fail the label gate. */
const BROKEN_READING = 'in';

async function main() {
  const mode = parseEvalFlagsOrExit('group-plan-invites');
  if (mode === 'dry') return dryRun();
  const broken = mode === 'broken';
  const cachedOnly = mode === 'cached-only';
  installEvalSpendCap();
  const getClient =
    mode === 'live' ? lazyAnthropic('group-plan-invites') : noClient('group-plan-invites');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const src = await importTs(SRC);
  const readSkill = await agent.loadSkill(READ_SKILL);
  const noteSkill = await agent.loadSkill(NOTE_SKILL);
  const readModel = agent.pickModel(readSkill.meta.task);
  const noteModel = agent.pickModel(noteSkill.meta.task);
  const judgeModel = await readJudgeModel();
  console.log(
    `group-plan-invites eval | mode=${mode} | read=${readModel} note=${noteModel} judge=${judgeModel}`,
  );

  const results = [];
  for (const fixture of ATTENDANCE_FIXTURES) {
    let reading;
    if (broken) {
      reading = new Map(fixture.input.families.map((f) => [f.familyId, BROKEN_READING]));
    } else {
      const { value } = await cachedToolCall({
        tag: `group-plan-attendance:${fixture.id}`,
        model: readModel,
        lane: agent.pickLane(readSkill.meta.task),
        system: readSkill.instructions,
        userMessage: src.attendanceUserMessage(fixture.input),
        toolName: 'group_plan_attendance',
        toolSchema: src.ATTENDANCE_TOOL_SCHEMA,
        toolDescription: 'Return, for each family key, whether that family is coming.',
        maxTokens: READ_MAX,
        cachedOnly,
        getClient,
        cost,
      });
      reading = src.attendanceFromAnswer(fixture.input.families, value);
    }
    const misses = reading
      ? Object.entries(fixture.accept)
          .filter(([id, ok]) => !ok.includes(reading.get(id)))
          .map(([id]) => `${id}=${reading.get(id)}`)
      : ['unmappable answer'];
    results.push({
      id: `attendance:${fixture.id}`,
      pass: misses.length === 0,
      detail: misses.join(' '),
    });
  }

  if (broken) {
    console.log('SKIP  note cases in --broken (a judge call is not $0 without a cache)');
  } else {
    const judge = makeJudge(
      judgeModel,
      JUDGE_SYSTEM,
      'group-plan-note',
      cachedOnly,
      getClient,
      cost,
    );
    for (const fixture of NOTE_FIXTURES) {
      const userMessage = src.noteUserMessage(fixture.input);
      const { value } = await cachedToolCall({
        tag: `group-plan-note:${fixture.id}`,
        model: noteModel,
        lane: agent.pickLane(noteSkill.meta.task),
        system: noteSkill.instructions,
        userMessage,
        toolName: 'group_plan_note',
        toolSchema: src.NOTE_TOOL_SCHEMA,
        toolDescription: 'Return the private note for this one family.',
        maxTokens: NOTE_MAX,
        cachedOnly,
        getClient,
        cost,
      });
      const verdict = await judge(fixture.id, {
        input: userMessage,
        message: value.text,
        watchFor: fixture.watchFor,
      });
      results.push({
        id: `note:${fixture.id}`,
        pass: verdict.score >= JUDGE_MIN,
        detail: `judge:${verdict.score} ${verdict.reason}`,
      });
    }
  }

  for (const r of results)
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(44)} ${r.detail}`);
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.pass);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

/** $0: no spend cap, no client. Every call priced uncached with its full output cap. */
async function dryRun() {
  const agent = await importTs(AGENT_SRC);
  const src = await importTs(SRC);
  const readSkill = await agent.loadSkill(READ_SKILL);
  const noteSkill = await agent.loadSkill(NOTE_SKILL);
  const readModel = agent.pickModel(readSkill.meta.task);
  const noteModel = agent.pickModel(noteSkill.meta.task);
  const judgeModel = await readJudgeModel();
  console.log(
    `group-plan-invites eval | mode=dry (no API calls) | read=${readModel} note=${noteModel} judge=${judgeModel}`,
  );
  let worst = 0;
  let calls = 0;
  const line = (tag, model, inTokens, maxOut) => {
    const usd = worstCaseUsd(model, inTokens, maxOut);
    worst += usd;
    calls += 1;
    console.log(
      `DRY  ${tag}  ${model}  ~${inTokens} in + ${maxOut} max out  worst $${usd.toFixed(5)}`,
    );
  };
  for (const f of ATTENDANCE_FIXTURES) {
    line(
      `group-plan-attendance:${f.id}`,
      readModel,
      estimateTokens(readSkill.instructions + src.attendanceUserMessage(f.input)),
      READ_MAX,
    );
  }
  for (const f of NOTE_FIXTURES) {
    const um = src.noteUserMessage(f.input);
    line(
      `group-plan-note:${f.id}`,
      noteModel,
      estimateTokens(noteSkill.instructions + um),
      NOTE_MAX,
    );
    line(
      `group-plan-note:judge:${f.id}`,
      judgeModel,
      estimateTokens(JUDGE_SYSTEM + um + f.watchFor) + NOTE_MAX,
      JUDGE_MAX,
    );
  }
  console.log(`DRY summary | ${calls} calls, all priced as uncached | worst $${worst.toFixed(5)}`);
  console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
}

main().catch((err) => {
  console.error('group-plan-invites eval harness error:', err);
  process.exit(2);
});
