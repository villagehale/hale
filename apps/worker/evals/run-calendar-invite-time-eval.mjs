// The calendar-invite TIME JUDGE (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/calendar-invite-time.md) run
// through the REAL request shape calendarInviteTimeUserMessage builds — replicated
// here because that module sits behind the web app's `~/` alias. The four cases are
// calendar-invite-time-fixtures.mjs. The skill body and model routing are imported
// live, so a skill edit re-keys the cache.
//
// NOT YET RECORDED. No cached responses and no CI step. Do not record in this run.
// After the Anthropic reset (8pm batch, already pre-approved):
//   HALE_SPEND_LEDGER=... HALE_MAX_USD=1 node --env-file=../../.env evals/run-calendar-invite-time-eval.mjs --live
// Replay once cached:
//   node evals/run-calendar-invite-time-eval.mjs --cached-only
// Project the cost, no network:
//   HALE_SPEND_LEDGER=... node evals/run-calendar-invite-time-eval.mjs --dry

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { CALENDAR_INVITE_TIME_FIXTURES } from './calendar-invite-time-fixtures.mjs';
import {
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

assertRunFlags([]);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'calendar-invite-time.md');

const TOOL_SCHEMA = {
  type: 'object',
  properties: { match: { type: 'boolean' } },
  required: ['match'],
};

const MAX_TOKENS = 80;

/** Mirrors `calendarInviteTimeUserMessage` in calendar-invite-voice.ts. */
function userMessage(fixture) {
  return JSON.stringify({
    text: fixture.text,
    summary: fixture.summary,
    when: fixture.when,
    timeZone: fixture.timeZone,
    language: fixture.language,
    starts: fixture.starts,
  });
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('calendar-invite-time');
  const cost = makeCost();
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);

  console.log(
    `calendar-invite-time eval | mode=${cachedOnly ? 'cached-only' : isDryRun() ? 'dry' : 'live'} | judge=${model}`,
  );
  const results = [];
  for (const fixture of CALENDAR_INVITE_TIME_FIXTURES) {
    const message = userMessage(fixture);
    const { value } = await cachedToolCall({
      tag: `calendar-invite-time:${fixture.id}`,
      model,
      lane,
      system: skill.instructions,
      userMessage: message,
      toolName: 'time_match',
      toolSchema: TOOL_SCHEMA,
      toolDescription: 'Whether the text states the same start as the facts.',
      maxTokens: MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const match = value.match === true;
    const failures = match === fixture.expectMatch ? [] : [`match:${match} expected:${fixture.expectMatch}`];
    results.push({ fixture, match, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(24)} match=${r.match} expected=${r.fixture.expectMatch}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('calendar-invite-time'));
    process.exit(0);
  }
  const allPass = results.every((r) => r.failures.length === 0);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('calendar-invite-time eval harness error:', err);
  process.exit(2);
});
