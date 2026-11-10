// VIL-662 team-schedule eval. Dry runs only — no paid live calls.
//
//   node evals/run-team-schedule-eval.mjs --dry
//
// Prices extract + match + parent voice + driver voice at max_tokens for every
// fixture, as a full miss. Must stay under $5.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { TEAM_SCHEDULE_FIXTURES } from './team-schedule-fixtures.mjs';
import { PRICE, REPO_ROOT } from './lib/harness.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const EXTRACT_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'extract-child-event.md');
const MATCH_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'match-team-schedule.md');
const PARENT_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'team-schedule-parent.md');
const DRIVER_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'team-schedule-driver.md');
const MATCH_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'integrations', 'team-schedule', 'match.ts');
const VOICE_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'integrations',
  'team-schedule',
  'voice.ts',
);

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const COST_CEILING_USD = 5;

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

function priced(model, input, output) {
  const rate = PRICE[model];
  if (!rate) throw new Error(`team-schedule --dry: no price for ${model}`);
  return (input * rate.input + output * rate.output) / 1_000_000;
}

function toolShape(name, description, schema) {
  return { name, description, input_schema: schema };
}

async function dryRun() {
  const agent = await importTs(AGENT_SRC);
  const matchMod = await importTs(MATCH_SRC);
  const voiceMod = await importTs(VOICE_SRC);
  const extractSkill = await agent.loadSkill(EXTRACT_SKILL);
  const matchSkill = await agent.loadSkill(MATCH_SKILL);
  const parentSkill = await agent.loadSkill(PARENT_SKILL);
  const driverSkill = await agent.loadSkill(DRIVER_SKILL);
  const extractLane = agent.pickLane(extractSkill.meta.task);
  const matchLane = agent.pickLane(matchSkill.meta.task);
  const parentLane = agent.pickLane(parentSkill.meta.task);
  const driverLane = agent.pickLane(driverSkill.meta.task);

  const extractTool = toolShape('extraction', 'Return the structured child-event extraction.', {
    type: 'object',
  });
  const matchTool = toolShape(
    matchMod.MATCH_TEAM_SCHEDULE_TOOL,
    matchMod.MATCH_TEAM_SCHEDULE_TOOL_DESCRIPTION,
    matchMod.MATCH_TEAM_SCHEDULE_TOOL_SCHEMA,
  );
  const parentTool = toolShape(
    voiceMod.TEAM_SCHEDULE_PARENT_TOOL,
    voiceMod.TEAM_SCHEDULE_PARENT_TOOL_DESCRIPTION,
    { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  );
  const driverTool = toolShape(
    voiceMod.TEAM_SCHEDULE_DRIVER_TOOL,
    voiceMod.TEAM_SCHEDULE_DRIVER_TOOL_DESCRIPTION,
    { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] },
  );

  let usd = 0;
  const lines = [];
  for (const fixture of TEAM_SCHEDULE_FIXTURES) {
    let row = 0;
    const extractUser = JSON.stringify({
      email: {
        subject: fixture.extract.subject,
        from: fixture.extract.from,
        body: fixture.extract.body,
      },
      received_at: fixture.extract.receivedAt,
      family_timezone: fixture.extract.familyTimezone,
      children: fixture.extract.children,
    });
    row += priced(
      extractLane.model,
      estimateTokens(extractSkill.instructions) +
        estimateTokens(extractUser) +
        estimateTokens(extractTool),
      1024,
    );
    const facts = { team: 'U11 Lightning', place: 'Rink 1' };
    const matchUser = matchMod.matchTeamScheduleUserMessage({
      kind: fixture.expect.extractKind === 'cancellation' ? 'cancellation' : 'reschedule',
      facts,
      kid: 'Leo',
      was: '2026-11-15T18:00:00.000Z',
      when: fixture.expect.change === 'cancel' ? null : '2026-11-15T19:00:00.000Z',
      candidates: fixture.candidates,
    });
    row += priced(
      matchLane.model,
      estimateTokens(matchSkill.instructions) +
        estimateTokens(matchUser) +
        estimateTokens(matchTool),
      matchMod.MATCH_TEAM_SCHEDULE_MAX_TOKENS,
    );
    const parentFacts = voiceMod.voiceFacts({
      mode: 'ask',
      kid: 'Leo',
      team: 'U11 Lightning',
      change: fixture.expect.change,
      wasAt: new Date('2026-11-15T18:00:00.000Z'),
      whenAt:
        fixture.expect.change === 'cancel' ? null : new Date('2026-11-15T19:00:00.000Z'),
      place: fixture.expect.change === 'location' ? 'Rink 2' : 'Rink 1',
      language: 'en',
      timeZone: 'America/Toronto',
    });
    row += priced(
      parentLane.model,
      estimateTokens(parentSkill.instructions) +
        estimateTokens(voiceMod.teamScheduleParentUserMessage(parentFacts)) +
        estimateTokens(parentTool),
      voiceMod.TEAM_SCHEDULE_PARENT_MAX_TOKENS,
    );
    const { mode: _mode, ...driverFacts } = parentFacts;
    row += priced(
      driverLane.model,
      estimateTokens(driverSkill.instructions) +
        estimateTokens(voiceMod.teamScheduleDriverUserMessage(driverFacts)) +
        estimateTokens(driverTool),
      voiceMod.TEAM_SCHEDULE_DRIVER_MAX_TOKENS,
    );
    usd += row;
    lines.push(`  ${fixture.id.padEnd(24)} extract+match+parent+driver  $${row.toFixed(4)}`);
  }

  if (usd > COST_CEILING_USD) {
    throw new Error(
      `team-schedule --dry: worst-case $${usd.toFixed(4)} exceeds the $${COST_CEILING_USD} ceiling`,
    );
  }

  return [
    `team-schedule | --dry | every miss, output at max_tokens | fixtures=${TEAM_SCHEDULE_FIXTURES.length}`,
    `extract=${extractLane.model} match=${matchLane.model} parent=${parentLane.model} driver=${driverLane.model}`,
    ...lines,
    `live API calls: 0 | worst-case cost of a full live run: $${usd.toFixed(4)} USD (ceiling $${COST_CEILING_USD})`,
  ].join('\n');
}

async function main() {
  const dry = process.argv.includes('--dry');
  if (!dry) {
    console.error('team-schedule: dry runs only. Pass --dry. No paid evals.');
    process.exit(2);
  }
  console.info(await dryRun());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
