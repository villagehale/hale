// The spot-opened text eval (VIL-337; hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/spot-open-voice.md) through the REAL
// request shape apps/web/lib/channel/spots/compose.ts sends. The facts shape, the tool
// schema and the refusals are IMPORTED from apps/web/lib/channel/spots/copy.ts (relative
// imports only), so a change there re-keys the cache or fails the gate here.
//
// WHAT IS AT STAKE. This text arrives unprompted and asks a parent to stop what they are
// doing and go and book. A number the page did not publish, a seat on a waitlist text, or
// a promise that Hale holds the spot costs somebody a morning.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-spot-open-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-spot-open-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-spot-open-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZERO is a draft copy.ts's own `spotOpenRefusals` refuses (it would not be sent).
// Everything else is the judge's bar (JUDGE_MIN per case).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const COPY_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'spots', 'copy.ts');

/** Invented portals and classes: the repo is public. */
const FIXTURES = [
  {
    id: 'seat-two-with-schedule',
    facts: {
      kind: 'seat_opened',
      source: "Riverton's portal",
      label: 'Monday preschool chess',
      spotsLeft: 2,
      schedule: 'Monday 05:00 PM',
      language: 'en',
    },
    watchFor: 'Says the page shows 2 spots in the class now.',
  },
  {
    id: 'seat-one-label-digit',
    facts: {
      kind: 'seat_opened',
      source: "Lakeside's portal",
      label: 'Swimmer 3 Saturday',
      spotsLeft: 1,
      schedule: null,
      language: 'en',
    },
    watchFor: 'Says the page shows 1 spot. "Swimmer 3" is the class name, not a count.',
  },
  {
    id: 'waitlist-room',
    facts: {
      kind: 'waitlist_reopened',
      source: "Riverton's portal",
      label: 'Tuesday toddler swim',
      spotsLeft: null,
      schedule: 'Tuesday 09:30 AM',
      language: 'en',
    },
    watchFor:
      'The class is still FULL: only the waitlist has room again. Saying a spot or place in the class opened is a fail. No queue length.',
  },
  {
    id: 'seat-french',
    facts: {
      kind: 'seat_opened',
      source: "Lakeside's portal",
      label: 'Saturday skating',
      spotsLeft: 3,
      schedule: 'Saturday 10:15 AM',
      language: 'fr',
    },
    watchFor: 'Written in FRENCH. Says the page shows 3 spots.',
  },
];

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale sends a parent because a class they',
  'asked Hale to watch shows room on the booking page. Code puts the booking link on its own',
  'line after the message, so a missing link is NOT a fault.',
  'IMPORTANT: links, digits and question marks are ALREADY checked mechanically. Judge only',
  'what the message says and whether it sounds right. You are given the facts Hale had, the',
  'message, and watchFor. Score 1-5.',
  'A 5: names where it comes from (the `source`) so the parent can trust it without checking;',
  'says what the page shows now, true to `kind` and `spotsLeft`; makes clear which class',
  '(by `label`); is in the requested `language`; reads like a friend who was keeping an eye on',
  'it, short and natural.',
  'A LOW score is any of: a claim the facts do not support (a seat on a waitlist text, a',
  'different count, a price, a deadline, how many are waiting); saying Hale reserved, held or',
  'registered the spot, or will keep watching; no attribution to the source; the wrong',
  'language; support-desk or marketing tone, hype, or emoji.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN_TEXT = 'Great news! I grabbed 4 spots for you, want me to book? Go to www.example.com';

async function main() {
  assertRunFlags(['--broken', '--env-file', '--max-usd']);
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('spot-open-voice');
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const copy = await tsImport(COPY_SRC, import.meta.url);
  const skill = await agent.loadSkill(
    join(REPO_ROOT, 'packages', 'agent', 'skills', `${copy.SPOT_OPEN_SKILL}.md`),
  );
  const model = agent.pickModel(skill.meta.task);
  const subjectLane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'spot-open-voice', cachedOnly, getClient, cost);

  console.log(
    `spot-open-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );

  const results = [];
  for (const fixture of FIXTURES) {
    const text = broken
      ? BROKEN_TEXT
      : String(
          (
            await cachedToolCall({
              tag: `spot-open-voice:${fixture.id}`,
              model,
              lane: subjectLane,
              system: skill.instructions,
              userMessage: copy.spotOpenUserMessage(fixture.facts),
              toolName: copy.SPOT_OPEN_TOOL,
              toolSchema: copy.SPOT_OPEN_TOOL_SCHEMA,
              toolDescription: copy.SPOT_OPEN_TOOL_DESCRIPTION,
              maxTokens: copy.SPOT_OPEN_MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            })
          ).value.text ?? '',
        ).trim();
    const failures = copy.spotOpenRefusals(text, fixture.facts);
    // Skipped in broken mode: the deterministic layer alone must reject the stand-in.
    if (!broken) {
      const verdict = await judge(fixture.id, {
        facts: fixture.facts,
        message: text,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, text, failures });
  }

  console.log('--- texts ---');
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} "${r.text}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0);
  console.log('\n--- gate ---');
  if (isDryRun()) {
    console.log(dryReportLine('spot-open-voice', [judge.plan]));
    process.exit(0);
  }
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  console.log(
    `broken-mode calibration (must fail at least one gate): ${!allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(!allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('spot-open-voice eval harness error:', err);
  process.exit(2);
});
