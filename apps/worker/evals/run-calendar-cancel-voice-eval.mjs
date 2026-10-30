// The calendar cancellation · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/calendar-cancel-voice.md) run through the REAL
// forced-tool-JSON request shape apps/web/lib/loop/voice/calendar-cancel-voice.ts builds — REPLICATED here because that module
// sits behind the web app's `~/` alias. `userMessage` and `refusals` below are the
// replicas, and calendar-cancel-voice.test.ts pins the originals. The skill body and model routing are
// imported live, so a skill edit re-keys the cache and shows up as a miss.
//
// NOT YET RECORDED. This suite has no cached responses and no CI step until a live run
// records them (a paid call — the founder runs it):
//   node --env-file=../../.env evals/run-calendar-cancel-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-calendar-cancel-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-calendar-cancel-voice-eval.mjs --cached-only                    # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { CALENDAR_CANCEL_VOICE_FIXTURES } from './calendar-cancel-voice-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
  dryReportLine,
  isDryRun,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'calendar-cancel-voice.md');

const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const LINK_SHAPE = /https?:\/\/|www\./i;
const FIRST_PERSON_PLURAL = /\b(we|we're|we'll|we've|us|our|ours)\b/i;

const MAX_TOKENS = 160;
const MAX_CHARS = 160;
const THIRD_PERSON_SELF =
  /\bHale\s+(can|could|will|would|is|isn't|has|have|cancelled|canceled|took|removed|might|may)\b/i;

/** Mirrors `calendarCancelUserMessage` in calendar-cancel-voice.ts. */
function userMessage(request, rejected = []) {
  const base = { summary: request.summary, when: request.when };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

/** Mirrors `calendarCancelRefusals` in calendar-cancel-voice.ts. */
function refusals(body, request) {
  if (body === '') return ['empty'];
  const found = [];
  if (body.length > MAX_CHARS) found.push('over_char_cap');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (!/^\p{Lu}/u.test(body)) found.push('not_a_sentence');
  if (THIRD_PERSON_SELF.test(body)) found.push('third_person_self');
  if (FIRST_PERSON_PLURAL.test(body)) found.push('first_person_plural');
  if (!body.toLowerCase().includes(request.summary.toLowerCase())) found.push('summary_missing');
  if (!/cancel/i.test(body)) found.push('cancel_word_missing');
  const handed = new Set(`${request.summary} ${request.when}`.match(/\d+/g) ?? []);
  if ((body.match(/\d+/g) ?? []).some((n) => !handed.has(n))) found.push('invented_number');
  return found;
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text Hale sends a parent to say an event it put on',
  'their calendar is cancelled. Hale was handed the event summary and its time, nothing else.',
  'You are given the request, the message, and watchFor notes. Score 1-5.',
  'A 5 names the event exactly, says when it was going to be and that it is cancelled, and',
  'suggests taking it off their calendar - one or two calm sentences, first person singular.',
  'A LOW score is any of: an invented reason or reschedule; anything about a child beyond',
  'the summary; a number not handed; "we"/"us"; hype, emoji, apology theatre; a link.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN = 'so sorry!! we had to cancel bc of weather, rescheduled to 5pm 😢 www.example.com';

function flatten(text) {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('calendar-cancel-voice');
  const cost = makeCost();
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'calendar-cancel-voice',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `calendar-cancel-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of CALENDAR_CANCEL_VOICE_FIXTURES) {
    const message = userMessage(fixture.request, fixture.rejected ?? []);
    const raw = broken
      ? BROKEN
      : (
          await cachedToolCall({
            tag: `calendar-cancel-voice:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: message,
            toolName: 'cancellation',
            toolSchema: TOOL_SCHEMA,
            toolDescription: 'Return the one short text telling the parent the event is cancelled.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.text;
    const body = flatten(raw);
    const failures = refusals(body, fixture.request);
    for (const pattern of fixture.forbiddenPatterns ?? []) {
      if (pattern.test(body)) failures.push(`forbidden:${pattern.source}`);
    }
    const verdict = await judge(fixture.id, {
      request: message,
      message: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} "${r.body.slice(0, 100)}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('calendar-cancel-voice', [judge.plan]));
    process.exit(0);
  }
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('calendar-cancel-voice eval harness error:', err);
  process.exit(2);
});
