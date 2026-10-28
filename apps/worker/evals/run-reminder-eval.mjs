// The reminder · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/reminder.md) over the REAL facts
// and gates: `reminderFacts`, `reminderUserMessage` and `reminderRefusals` are imported
// from apps/web/lib/loop/reminders/compose.ts. The model writes the WHOLE text; a judge
// scores facts, AM/PM, language, never claiming free time over a timed event, and tone.
// Nothing matches words.
//
// Recorded 2026-10-25 (8/8, ledger vil454-evals; broken calibration fails 8/8). CI replays it cached-only:
//   node evals/run-reminder-eval.mjs --max-usd <ledger total + allowance>   # live, then caches
//   node evals/run-reminder-eval.mjs --broken                               # calibration: must FAIL
//   node evals/run-reminder-eval.mjs --cached-only                          # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
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
import { REMINDER_FIXTURES } from './reminder-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'reminder.md');
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
  },
  required: ['texts'],
};

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE reminder text Hale sends a parent about what is on',
  'their calendar. The model wrote the whole text; nothing is added around it. You are given',
  'the facts (offset, now, events with date, allDay, start, end, location; planLink; language),',
  'the text and watchFor notes. Score 1-5 on FACTS, LANGUAGE and TONE, not wording.',
  'A 5: every event is there with its facts as given and nothing invented; each time given is',
  'correct INCLUDING morning versus afternoon or evening (AM/PM or the natural equivalent in',
  'that language); no clock time for an all-day event; the day phrased truly from now (tomorrow',
  'versus today); entirely in the requested language; short, calm, warm, like a friend.',
  'A LOW score (1-2) is any of: implying the family has nothing to be at, or that the day is',
  'open, free, quiet, a break or breathing room, when ANY event has a start time, whatever its',
  'title says (naming an all-day item as what the day is, such as a PD day or day off, is a',
  'true fact and fine, as long as the timed events are also clearly there); a wrong or',
  'ambiguous AM/PM; a wrong time, date, or place; an invented detail (what to bring, who is',
  'going, how it will go); guessing what a generic "an appointment" is; the wrong language or',
  'mixed languages; a link other than planLink; hype, exclamation marks, emoji, a question or',
  'asking them to reply with a word; a stiff template feel such as "Day: title at time".',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: the prod bug itself — a code-built prefix, a time with
// no meridiem, a free-day claim over a timed event, English for a French parent.
const BROKEN =
  "Mon, Oct 26: Jour de congé at 3:00 Tomorrow's a day off, so you've got a bit of breathing room.";

function readTexts(value) {
  const texts = Array.isArray(value?.texts) ? value.texts : [];
  return texts.map((t) => String(t ?? '').trim());
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('reminder');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const compose = await importTs(COMPOSE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'reminder', cachedOnly, getClient, cost);

  console.log(
    `reminder eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of REMINDER_FIXTURES) {
    const facts = compose.reminderFacts({ ...fixture.args, now: new Date(fixture.args.now) });
    const userMessage = compose.reminderUserMessage(facts);
    const texts = broken
      ? [BROKEN]
      : readTexts(
          (
            await cachedToolCall({
              tag: `reminder:${fixture.id}`,
              model,
              lane,
              system: skill.instructions,
              userMessage,
              toolName: 'reminder_texts',
              toolSchema: TOOL_SCHEMA,
              toolDescription: 'The texts Hale sends the parent, in order.',
              maxTokens: 1024,
              cachedOnly,
              getClient,
              cost,
            })
          ).value,
        );
    // The judge reads the texts in the order the parent receives them, one per line.
    const body = texts.join('\n');
    const failures = compose.reminderRefusals(texts, facts).map((r) => `unsendable:${r}`);
    const verdict = await judge(fixture.id, {
      input: userMessage,
      text: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures });
  }
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} ${JSON.stringify(r.body.split('\n'))}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('reminder eval harness error:', err);
  process.exit(2);
});
