// Opt-out reader eval (#868).
//
// Subject: the production opt-out reader request (skill `opt-out-read`, the
// lane its frontmatter names). The user payload, tool schema and max tokens are
// imported from apps/web/lib/channel/intake/opt-out-reader.ts, not copied; the
// tool name and description below are still hand copies. Grade:
//   - intent: the returned label must equal the fixture's (a structured field,
//     not word matching);
//   - confirmation (stop/start rows): a judge model only, median of three,
//     floor JUDGE_MIN. No phrase is required or banned.
// The carrier STOP keyword stays in code until this eval passes on a recording.
//
// Usage (from apps/worker):
//   node evals/run-opt-out-read-eval.mjs --preflight
//   node evals/run-opt-out-read-eval.mjs --dry
//   node evals/run-opt-out-read-eval.mjs --cached-only
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  REPO_ROOT,
  cachedToolCall,
  dryReportLine,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  readModelIds,
  scoreFirstJudgeSchema,
} from './lib/harness.mjs';
import { OPT_OUT_FIXTURES } from './opt-out-read-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'opt-out-read.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'intake', 'opt-out-reader.ts');
const JUDGE_MAX_TOKENS = 4096;
const HAIKU_IN = 1;
const HAIKU_OUT = 5;

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = `You grade one text message a family assistant sent back after a person
asked it to stop texting them (or to start again). You get their message, its language,
what they asked for, and the reply. Score 1-5. 5 means: for a stop, the reply says plainly
that it will not text again and how they could come back, in its own words; for a start,
it says it is back. It is in the person's own language and script, short and warm, asks
nothing else and sells nothing. Score 1 when it argues, guilt-trips, asks a question, keeps
the conversation going, or answers in another language. There is no required wording;
judge meaning only.`;

function laneModel(task, ids) {
  // packages/agent/src/model.ts: screen/answer/speak/triage/acknowledge -> Haiku.
  if (['screen', 'answer', 'speak', 'triage', 'acknowledge'].includes(task)) return ids.haiku;
  throw new Error(`opt-out-read lane ${task} is not a Haiku lane; update the estimate first`);
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const preflight = process.argv.includes('--preflight');
  const agent = await importTs(AGENT_SRC);
  const { OPT_OUT_READ_MAX_TOKENS, OPT_OUT_READ_TOOL_SCHEMA, optOutUserMessage } =
    await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL);
  const replyRows = OPT_OUT_FIXTURES.filter(
    (f) => f.expect !== 'none' && f.expect !== 'identity',
  ).length;
  const subjectCalls = OPT_OUT_FIXTURES.length;
  const judgeCalls = replyRows * JUDGE_SAMPLES_MEDIAN;
  if (preflight) {
    const subjIn = Math.ceil((skill.instructions.length + 300) / 4);
    const judgeIn = Math.ceil((JUDGE_SYSTEM.length + 400) / 4);
    const subj =
      subjectCalls * ((subjIn / 1e6) * HAIKU_IN + (OPT_OUT_READ_MAX_TOKENS / 1e6) * HAIKU_OUT);
    const judge = judgeCalls * ((judgeIn / 1e6) * HAIKU_IN + (JUDGE_MAX_TOKENS / 1e6) * HAIKU_OUT);
    console.info(
      `opt-out-read preflight | lane=${skill.meta.task} fixtures=${subjectCalls} subject calls=${subjectCalls} judge calls=${judgeCalls}`,
    );
    console.info(
      `worst case (every call hits max_tokens): subject $${subj.toFixed(4)} + judge $${judge.toFixed(4)} = $${(subj + judge).toFixed(4)}`,
    );
    return;
  }
  const ids = await readModelIds();
  const model = laneModel(skill.meta.task, ids);
  const lane = agent.pickLane(skill.meta.task);
  const getClient = lazyAnthropic();
  const cost = makeCost();
  const judge = makeJudge(
    await readJudgeModel('haiku'),
    JUDGE_SYSTEM,
    'opt-out-read-judge',
    cachedOnly,
    getClient,
    cost,
    {
      samples: JUDGE_SAMPLES_MEDIAN,
      toolSchema: scoreFirstJudgeSchema(400),
      keepTruncatedScore: true,
    },
  );
  let failed = 0;
  for (const f of OPT_OUT_FIXTURES) {
    const out = (
      await cachedToolCall({
        tag: `opt-out-read:${f.id}`,
        model,
        lane,
        system: skill.instructions,
        // A language hint only when certain (French). Region is unknown here, so the
        // facts are both 988 lines and 911, as production sends.
        userMessage: optOutUserMessage({
          text: f.text,
          language: f.language === 'fr' ? 'fr' : null,
          region: null,
        }),
        toolName: 'opt_out',
        toolDescription: 'Return whether the sender asked Hale to stop or start texting.',
        toolSchema: OPT_OUT_READ_TOOL_SCHEMA,
        maxTokens: OPT_OUT_READ_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      })
    )?.value;
    const intent = out?.intent ?? 'none';
    if (intent !== f.expect || out?.verbatim !== f.text) {
      failed += 1;
      console.info(`FAIL  ${f.id}  intent=${intent} expected=${f.expect}`);
      console.info(
        `      text: ${JSON.stringify(f.text)} reply: ${JSON.stringify(out?.confirmation ?? '')}`,
      );
      continue;
    }
    if (f.expect === 'none' || f.expect === 'identity') {
      console.info(`PASS  ${f.id}  intent=${intent}`);
      continue;
    }
    const verdict = await judge(f.id, {
      personMessage: f.text,
      personLanguage: f.language,
      asked: f.expect,
      reply: out.confirmation,
    });
    const ok = verdict.score >= JUDGE_MIN && out.confirmation.trim().length > 0;
    if (!ok) failed += 1;
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${f.id}  intent=${intent} judge:${verdict.score}`);
  }
  if (isDryRun()) {
    console.log(dryReportLine('opt-out-read', [judge.plan]));
    return;
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
