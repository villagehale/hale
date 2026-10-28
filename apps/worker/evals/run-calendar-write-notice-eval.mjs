// The calendar write notice · composer eval (VIL-454 T6, hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/calendar-write-notice.md) over the
// REAL input and gates: `calendarWriteNoticeInput`, `calendarWriteNoticeUserMessage` and
// `calendarWriteNoticeRefusals` are imported from apps/web/lib/channel/calendar-write/notice.ts.
// A judge scores facts and tone; nothing matches words.
//
// Recorded 2026-10-25 (6/6, $0.0008, ledger vil454-evals). CI replays it cached-only:
//   node evals/run-calendar-write-notice-eval.mjs --max-usd 0.05   # live, then caches
//   node evals/run-calendar-write-notice-eval.mjs --broken         # calibration: must FAIL
//   node evals/run-calendar-write-notice-eval.mjs --cached-only    # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { CALENDAR_WRITE_NOTICE_FIXTURES } from './calendar-write-notice-fixtures.mjs';
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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'calendar-write-notice.md');
const NOTICE_SRC = join(WEB_ROOT, 'lib', 'channel', 'calendar-write', 'notice.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text Hale sends a parent in a 1:1 chat, telling them',
  'how writing a plan they agreed to onto their own calendar went. You are given the input',
  '(outcome, event, connectLink, language), the text and watchFor notes. Score 1-5 on FACTS and',
  'TONE, not wording. A 5 states exactly the outcome, uses only the event as given, carries the',
  'link exactly when one is given and none otherwise, is in input.language, first person, short,',
  'plain and warm like a friend. A LOW score is any of: claiming it is on the calendar when the',
  'outcome says it is not, or the reverse; an invented time, place, person or next step; a link',
  'when none was given; the wrong language; in French, vous; blame, system talk, hype, emoji,',
  'exclamation marks, asking them to reply with a keyword; more than about two short sentences.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN = 'Done!! Added to your Google Calendar 🎉 reply YES to confirm www.example.com';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('calendar-write-notice');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const notice = await importTs(NOTICE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'calendar-write-notice',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `calendar-write-notice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of CALENDAR_WRITE_NOTICE_FIXTURES) {
    const input = notice.calendarWriteNoticeInput(fixture.args);
    if (!input) throw new Error(`fixture ${fixture.id} produced no notice input`);
    const userMessage = notice.calendarWriteNoticeUserMessage(input);
    const body = broken
      ? BROKEN
      : String(
          (
            await cachedToolCall({
              tag: `calendar-write-notice:${fixture.id}`,
              model,
              lane,
              system: skill.instructions,
              userMessage,
              toolName: 'calendar_write_notice',
              toolSchema: TOOL_SCHEMA,
              toolDescription: 'The one text Hale sends the parent.',
              maxTokens: 300,
              cachedOnly,
              getClient,
              cost,
            })
          ).value.text ?? '',
        ).trim();
    const failures = notice.calendarWriteNoticeRefusals(body, input).map((r) => `unsendable:${r}`);
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
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(22)} "${r.body}"`,
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
  console.error('calendar-write-notice eval harness error:', err);
  process.exit(2);
});
