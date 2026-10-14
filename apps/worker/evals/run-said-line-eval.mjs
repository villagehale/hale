// said-line eval (#868).
//
// Subject: the production said-line writer (skill `said-line`, the same request shape
// as apps/web/lib/channel/voice/said-line.ts: saidLineUserMessage + tool said_line).
// Rows: identity EN/FR/ZH/AR, two-link connect EN/FR, and one row each for
// not_posted, no_source, cheer_up, health (811/911) and the single connect link. Grade:
//   - facts (structural, the same check as acceptSaidLine): non-empty, every
//     mustInclude string verbatim, no link that is not a required fact;
//   - words: a judge model only, median of three draws, floor JUDGE_MIN. No phrase is
//     required or banned.
//
// Usage (from apps/worker):
//   node evals/run-said-line-eval.mjs --preflight
//   node evals/run-said-line-eval.mjs --cached-only
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { SAID_LINE_FIXTURES } from './said-line-fixtures.mjs';

const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'said-line.md');
const SUBJECT_MAX_TOKENS = 500; // SAID_LINE_MAX_TOKENS in said-line.ts
const JUDGE_MAX_TOKENS = 4096;
const HAIKU_IN = 1;
const HAIKU_OUT = 5;

const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const SCRIPT_NAME = { en: 'English', fr: 'French', zh: 'Chinese', ar: 'Arabic' };

const JUDGE_SYSTEM = `You grade one text message a family assistant sent to a parent.
You get the purpose, the parent's message, the parent's language, the facts the text
had to carry, and the text.
Score 1-5. 5 means: the text does its purpose plainly and warmly, like a friend
texting; it is in the parent's own language and script; every fact it states is one
of the given facts (nothing invented); and it asks nothing it did not need to.
For purpose "identity": it says who is writing (Hale, from the company), who is
accountable, and how to reach a person (the site and email), without being defensive.
For purpose "connector_links": it says what each link connects, that connecting is
optional, and how long the links work, with each link whole.
For "not_posted": it says plainly the date is not posted yet, with no guessed date.
For "no_source": it says it has no current source for that, with no answer from memory.
For "cheer_up": warm and brief, like a parent friend; no advice method, no diagnosis,
never claims to be a therapist.
For "health": no medical advice; it points to Health811 (811) any time and to 911 for
an emergency.
For "connector_link": it conveys the Google unverified-app caution, gives the one link
whole, and says how long it works.
Score 1 when it is in the wrong language or script, invents a fact, mangles a link,
or reads like a form letter. There is no required wording; judge meaning only.`;

async function loadSkill() {
  const raw = await readFile(SKILL, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('said-line.md: no frontmatter');
  const task = m[1].match(/^task:\s*(\S+)/m)?.[1];
  return { task, instructions: m[2].trim() };
}

function laneModel(task, ids) {
  if (['screen', 'answer', 'speak', 'triage', 'acknowledge'].includes(task)) return ids.haiku;
  throw new Error(`said-line lane ${task} is not a Haiku lane; update the estimate first`);
}

/** saidLineUserMessage in said-line.ts, key for key (the cache key depends on it). */
function userMessage(f) {
  return JSON.stringify({
    purpose: f.purpose,
    language: f.language,
    parentWords: f.parentWords ?? null,
    facts: f.facts,
    mustInclude: f.mustInclude ?? [],
  });
}

const URL_RE = /https?:\/\/\S+/g;

/** acceptSaidLine in said-line.ts. */
function factsHold(text, f) {
  const body = (text ?? '').trim();
  if (body.length === 0) return false;
  const required = f.mustInclude ?? [];
  if (!required.every((fact) => body.includes(fact))) return false;
  const allowed = required.filter((fact) => /^https?:\/\//.test(fact));
  const found = body.match(URL_RE) ?? [];
  return found.every((link) => allowed.some((fact) => link.startsWith(fact)));
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const preflight = process.argv.includes('--preflight');
  const skill = await loadSkill();
  const subjectCalls = SAID_LINE_FIXTURES.length;
  const judgeCalls = subjectCalls * JUDGE_SAMPLES_MEDIAN;
  if (preflight) {
    const subjIn = Math.ceil((skill.instructions.length + 600) / 4);
    const judgeIn = Math.ceil((JUDGE_SYSTEM.length + 900) / 4);
    const subj =
      subjectCalls * ((subjIn / 1e6) * HAIKU_IN + (SUBJECT_MAX_TOKENS / 1e6) * HAIKU_OUT);
    const judge = judgeCalls * ((judgeIn / 1e6) * HAIKU_IN + (JUDGE_MAX_TOKENS / 1e6) * HAIKU_OUT);
    console.info(
      `said-line preflight | lane=${skill.task} fixtures=${subjectCalls} subject calls=${subjectCalls} judge calls=${judgeCalls}`,
    );
    console.info(
      `worst case (every call hits max_tokens): subject $${subj.toFixed(4)} + judge $${judge.toFixed(4)} = $${(subj + judge).toFixed(4)}`,
    );
    return;
  }
  const ids = await readModelIds();
  const model = laneModel(skill.task, ids);
  const getClient = lazyAnthropic();
  const cost = makeCost();
  const judge = makeJudge(
    await readJudgeModel('haiku'),
    JUDGE_SYSTEM,
    'said-line-judge',
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
  for (const f of SAID_LINE_FIXTURES) {
    const out = await cachedToolCall({
      tag: `said-line:${f.id}`,
      model,
      system: skill.instructions,
      userMessage: userMessage(f),
      toolName: 'said_line',
      toolDescription: 'Return the one text Hale sends.',
      toolSchema: TOOL_SCHEMA,
      maxTokens: SUBJECT_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const text = out?.text ?? '';
    if (!factsHold(text, f)) {
      failed += 1;
      console.info(`FAIL  ${f.id}  facts: a required string is missing or a link was added`);
      continue;
    }
    const verdict = await judge(f.id, {
      purpose: f.purpose,
      parentMessage: f.parentWords,
      parentLanguage: SCRIPT_NAME[f.script] ?? f.script,
      facts: f.facts,
      text,
    });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${f.id}  judge:${verdict.score}`);
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
