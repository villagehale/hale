// Group onboarding voice · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/group-onboarding-voice.md) run
// through the REAL request shape the web app builds: `groupOnboardingLineInput`
// (apps/web/lib/channel/linq/group-onboarding-line-input.ts) and the judge
// (apps/web/lib/channel/voice/judge.ts) are pure modules with relative imports only, so tsx
// loads them live. A change to the facts a kind hands over, to a red line, or to the skill
// re-keys the cache and shows up here as a miss rather than as silence.
//
// What is NOT tested here: the claim/send/ledger plumbing and the locked fallback
// (roster-ask.pglite.test.ts, with a fake voice), and reading a member's reply
// (roster-reading.test.ts; code only, no model). This eval is only the words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-group-onboarding-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-group-onboarding-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-group-onboarding-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS: any line the real judge refuses. Through the per-kind red lines that
// includes a role asserted for a member, a calendar or Gmail word, a booking claim, a
// missing "Hale" in an ask or the no-family line, a missing role word, and tu in French.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { GROUP_ONBOARDING_VOICE_FIXTURES } from './group-onboarding-voice-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-onboarding-voice.md');
const JUDGE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'voice', 'judge.ts');
const INPUT_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'linq',
  'group-onboarding-line-input.ts',
);

/** Same ceiling as MAX_TOKENS in apps/web/lib/channel/voice/spoken-line.ts. */
const MAX_TOKENS = 400;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale posts in a family group chat it',
  'has just joined. Some people in the chat are parents Hale knows; others Hale does not',
  'know yet, and each of them must say for themselves who they are. Hale wrote the message',
  'from the facts in the request and nothing else.',
  'You are given the request (kind, language, address, questions, mustMention, facts, and',
  'what the person just said if anything), the message, and watchFor - fixture-specific',
  'notes on what right and wrong look like. Score 1-5.',
  'A 5 reads like a friend who is good at this, writing to a group: short, plain, warm,',
  'first person, two or three sentences at most, exactly the asked number of questions with',
  'the question last, every role word offered as a choice, and Hale named when the kind is',
  'an ask or the no-family line. In French a 5 uses vous and real accents.',
  'A LOW score is any of: telling someone who they are or guessing a role; asking one person',
  'to say who the others are; a fact not in the request (a name, a child, a time, a count);',
  'any calendar, email, Gmail, inbox, link, or plans talk; claiming Hale booked or signed',
  'anyone up; a second question; telling anyone to reply with a keyword, YES or NO;',
  'mentioning STOP or unsubscribing; a URL or phone number; exclamation marks, emoji, hype,',
  '"we" for Hale; a corporate or bot register; padding; anything watchFor says must not',
  'happen. Listing the role words as choices is required, not padding.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: asserts a role, mentions the calendar, claims a booking,
// adds an emoji and a URL. The real judge refuses it on several red lines at once.
const BROKEN_LINE =
  "You're the dad, right? I booked swim and synced your calendar 😊 see www.example.com?";

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const {
    judgeSpokenLine,
    spokenLineContext,
    spokenLineToolSchema,
    spokenLineToolDescription,
    assembleSpokenLine,
  } = await tsImport(JUDGE_SRC, import.meta.url);
  const { groupOnboardingLineInput } = await tsImport(INPUT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'group-onboarding-voice',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `group-onboarding-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${GROUP_ONBOARDING_VOICE_FIXTURES.length} lines\n`);

  const results = [];
  for (const fixture of GROUP_ONBOARDING_VOICE_FIXTURES) {
    const input = groupOnboardingLineInput(fixture.request, fixture.language, {
      parentWords: fixture.parentWords ?? null,
    });
    const userMessage = JSON.stringify(spokenLineContext(input));
    const raw = broken
      ? BROKEN_LINE
      : assembleSpokenLine(
          input.questions,
          (
            await cachedToolCall({
              tag: `group-onboarding-voice:${fixture.id}`,
              model,
              system: skill.instructions,
              userMessage,
              toolName: 'line',
              toolSchema: spokenLineToolSchema(input.questions),
              toolDescription: spokenLineToolDescription(input.questions),
              maxTokens: MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            })
          ).value,
        );

    const body = String(raw).trim();
    const failures = [];
    const judged = judgeSpokenLine(body, input);
    if (!judged.ok) failures.push(`refused:${judged.reason}`);

    const verdict = await judge(fixture.id, {
      request: userMessage,
      message: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);

    results.push({ fixture, body, failures });
  }

  console.log('--- lines ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.fixture.id.padEnd(32)} "${r.body.slice(0, 100)}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const refused = results.filter((r) => r.failures.some((f) => f.startsWith('refused:')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  console.log('\n--- corpus metrics ---');
  console.log(`REFUSED LINES:   ${refused.length}  (0 required)`);
  console.log(`judge below ${JUDGE_MIN}:   ${judgeFails.length}  (0 required)`);
  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0);
  console.log('\n--- gate ---');
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const calibrated = !allPass;
  console.log(
    `broken-mode calibration (must fail at least one gate): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('group-onboarding-voice eval harness error:', err);
  process.exit(2);
});
