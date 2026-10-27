// The reminder · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/reminder.md) over the REAL facts
// and gates: `reminderFacts`, `reminderUserMessage` and `reminderRefusals` are imported
// from apps/web/lib/loop/reminders/compose.ts. The model writes the WHOLE text; a judge
// scores facts (including a fact check on logistics such as departure or travel time),
// AM/PM, language, never claiming free time over a timed event, and tone.
// Nothing matches words.
//
// Recorded 2026-10-27 (8/8, ledger 914-evals; every --broken case fails, incl. an added wish). CI replays it cached-only:
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

const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
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
  'FACT CHECK every logistics claim against the facts you are given: when to leave or set',
  'off, how long getting there takes, traffic, parking, arrival or pickup times, and any',
  'other timing or travel detail. If the facts do not contain it (there is never a travel',
  'time or departure time in these facts), stating it as fact is an invented detail and a',
  'LOW score (1-2), in any language, however it is phrased. Saying how far away the event',
  'is from now (in about an hour, tomorrow afternoon) is a true fact from now and start, and',
  'fine; turning that into when to leave is not.',
  'JUDGE WHAT EACH SENTENCE DOES, not its words: the text is only there to tell the parent',
  'what is on the calendar. Any sentence whose job is something else that nobody asked for,',
  'such as a wish, hope or blessing for them, advice or a suggestion on what to do or how to',
  'plan, or a comment or opinion about the day or the family, is unrequested filler. It is',
  `not a fact from the facts you are given, so it caps the score at ${JUDGE_MIN - 1} at most, in`,
  'any language and however it is phrased, even when every fact is right.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: the prod bug itself — a code-built prefix, a time with
// no meridiem, a free-day claim over a timed event, English for a French parent.
const BROKEN =
  "Mon, Oct 26: Jour de congé at 3:00 Tomorrow's a day off, so you've got a bit of breathing room.";

// Targeted broken cases: each is a believable reply with one defect the judge must catch.
// The facts are right; only the job of one sentence is wrong (an unrequested wish).
const BROKEN_CASES = [
  {
    fixtureId: 'en-pd-day-all-day',
    tag: 'en-pd-day-all-day:added-wish',
    body: 'Tomorrow is a PD Day, so there is no school. Hope you can plan around it.',
  },
];

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
    const body = broken
      ? BROKEN
      : String(
          (
            await cachedToolCall({
              tag: `reminder:${fixture.id}`,
              model,
              lane,
              system: skill.instructions,
              userMessage,
              toolName: 'reminder_text',
              toolSchema: TOOL_SCHEMA,
              toolDescription: 'The one text Hale sends the parent.',
              maxTokens: 300,
              cachedOnly,
              getClient,
              cost,
            })
          ).value.text ?? '',
        ).trim();
    const failures = compose.reminderRefusals(body, facts).map((r) => `unsendable:${r}`);
    const verdict = await judge(fixture.id, {
      input: userMessage,
      text: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures });
  }
  if (broken) {
    for (const bc of BROKEN_CASES) {
      const fixture = REMINDER_FIXTURES.find((f) => f.id === bc.fixtureId);
      if (!fixture) throw new Error(`broken case ${bc.tag}: no fixture ${bc.fixtureId}`);
      const facts = compose.reminderFacts({ ...fixture.args, now: new Date(fixture.args.now) });
      const userMessage = compose.reminderUserMessage(facts);
      const failures = compose.reminderRefusals(bc.body, facts).map((r) => `unsendable:${r}`);
      const verdict = await judge(bc.tag, {
        input: userMessage,
        text: bc.body,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
      results.push({ fixture: { ...fixture, id: bc.tag }, body: bc.body, failures });
    }
  }
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(30)} "${r.body}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  // Calibration holds only if EVERY broken case fails; one that slips through means the
  // judge cannot see that defect.
  const slipped = results.filter((r) => r.failures.length === 0).map((r) => r.fixture.id);
  const calibrated = slipped.length === 0;
  console.log(
    `broken-mode calibration (every case must fail): ${calibrated ? 'PASS' : `FAIL (passed: ${slipped.join(', ')})`}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('reminder eval harness error:', err);
  process.exit(2);
});
