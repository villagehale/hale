// Opt-out reader eval (#868).
//
// Subject: the production opt-out reader request (skill `opt-out-read`, the
// lane its frontmatter names, the same user payload and tool schema as
// apps/web/lib/channel/intake/opt-out-reader.ts). Grade:
//   - intent: the returned label must equal the fixture's (a structured field,
//     not word matching);
//   - confirmation (stop/start rows): a judge model only, median of three,
//     floor JUDGE_MIN. No phrase is required or banned.
// The carrier STOP keyword stays in code until this eval passes on a recording.
//
// Usage (from apps/worker):
//   node evals/run-opt-out-read-eval.mjs --preflight
//   node evals/run-opt-out-read-eval.mjs --cached-only
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  REPO_ROOT,
  cachedToolCall,
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
const SUBJECT_MAX_TOKENS = 400; // MAX_TOKENS in opt-out-reader.ts
const JUDGE_MAX_TOKENS = 4096;
const HAIKU_IN = 1;
const HAIKU_OUT = 5;

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['stop', 'start', 'crisis_emergency', 'crisis_mental', 'identity', 'none'],
    },
    verbatim: { type: 'string' },
    confirmation: { type: 'string' },
  },
  required: ['intent', 'verbatim', 'confirmation'],
};

const JUDGE_SYSTEM = `You grade one text message a family assistant sent back after a person
asked it to stop texting them (or to start again). You get their message, its language,
what they asked for, and the reply. Score 1-5. 5 means: for a stop, the reply says plainly
that it will not text again and how they could come back, in its own words; for a start,
it says it is back. It is in the person's own language and script, short and warm, asks
nothing else and sells nothing. Score 1 when it argues, guilt-trips, asks a question, keeps
the conversation going, or answers in another language. There is no required wording;
judge meaning only.`;

async function loadSkill() {
  const raw = await readFile(SKILL, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('opt-out-read.md: no frontmatter');
  const task = m[1].match(/^task:\s*(\S+)/m)?.[1];
  return { task, instructions: m[2].trim() };
}

function laneModel(task, ids) {
  // packages/agent/src/model.ts: screen/answer/speak/triage/acknowledge -> Haiku.
  if (['screen', 'answer', 'speak', 'triage', 'acknowledge'].includes(task)) return ids.haiku;
  throw new Error(`opt-out-read lane ${task} is not a Haiku lane; update the estimate first`);
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const preflight = process.argv.includes('--preflight');
  const skill = await loadSkill();
  const replyRows = OPT_OUT_FIXTURES.filter(
    (f) => f.expect !== 'none' && f.expect !== 'identity',
  ).length;
  const subjectCalls = OPT_OUT_FIXTURES.length;
  const judgeCalls = replyRows * JUDGE_SAMPLES_MEDIAN;
  if (preflight) {
    const subjIn = Math.ceil((skill.instructions.length + 300) / 4);
    const judgeIn = Math.ceil((JUDGE_SYSTEM.length + 400) / 4);
    const subj =
      subjectCalls * ((subjIn / 1e6) * HAIKU_IN + (SUBJECT_MAX_TOKENS / 1e6) * HAIKU_OUT);
    const judge = judgeCalls * ((judgeIn / 1e6) * HAIKU_IN + (JUDGE_MAX_TOKENS / 1e6) * HAIKU_OUT);
    console.info(
      `opt-out-read preflight | lane=${skill.task} fixtures=${subjectCalls} subject calls=${subjectCalls} judge calls=${judgeCalls}`,
    );
    console.info(
      `worst case (every call hits max_tokens): subject $${subj.toFixed(4)} + judge $${judge.toFixed(4)} = $${(subj + judge).toFixed(4)}`,
    );
    return;
  }
  const ids = await readModelIds();
  const model = laneModel(skill.task, ids);
  const lane = (await tsImport(AGENT_SRC, import.meta.url)).pickLane(skill.task);
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
        // optOutUserMessage: a hint only when certain (French), else null.
        userMessage: JSON.stringify({
          text: f.text,
          languageHint: f.language === 'fr' ? 'fr' : null,
        }),
        toolName: 'opt_out',
        toolDescription: 'Return whether the sender asked Hale to stop or start texting.',
        toolSchema: TOOL_SCHEMA,
        maxTokens: SUBJECT_MAX_TOKENS,
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
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
