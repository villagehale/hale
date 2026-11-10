// Meaning-screen eval. The leftover word-list intent checks, read by Haiku.
//
// Subject: packages/agent/skills/meaning-screen.md through the production
// request in apps/web/lib/channel/meaning-screen/read.ts. Gold is the
// structured field production acts on. No judge, no phrase floor.
//
// Usage (from apps/worker):
//   node evals/run-meaning-screen-eval.mjs --preflight
//   node evals/run-meaning-screen-eval.mjs --dry
//   node evals/run-meaning-screen-eval.mjs --cached-only
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { MEANING_SCREEN_FIXTURES } from './meaning-screen-fixtures.mjs';
import {
  REPO_ROOT,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'meaning-screen.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'meaning-screen', 'read.ts');
const HAIKU_IN = 1;
const HAIKU_OUT = 5;

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

function grade(reading, expect) {
  if (!reading) return false;
  for (const [key, wanted] of Object.entries(expect)) {
    if (key === 'violations') {
      const got = [...(reading.violations ?? [])].sort();
      const gold = [...wanted].sort();
      if (got.join(',') !== gold.join(',')) return false;
      continue;
    }
    if (reading[key] !== wanted) return false;
  }
  return true;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const preflight = process.argv.includes('--preflight');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const reader = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const fixtures = MEANING_SCREEN_FIXTURES;

  if (preflight) {
    const inputTokens = Math.ceil((skill.instructions.length + 200) / 4);
    const worst =
      fixtures.length *
      ((inputTokens / 1e6) * HAIKU_IN + (reader.MEANING_SCREEN_MAX_TOKENS / 1e6) * HAIKU_OUT);
    console.info(
      `meaning-screen preflight | fixtures=${fixtures.length} model=${lane.model} | worst $${worst.toFixed(6)} | judges=0`,
    );
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('meaning-screen');
  const cost = makeCost();
  const failures = [];
  for (const fixture of fixtures) {
    const request = await reader.meaningScreenRequest({
      screen: fixture.screen,
      text: fixture.text,
      ...(fixture.facts ? { facts: fixture.facts } : {}),
    });
    const call = await cachedToolCall({
      tag: `meaning-screen:${reader.MEANING_SCREEN_MAX_TOKENS}:${fixture.id}`,
      lane,
      system: request.system,
      userMessage: request.userMessage,
      toolName: request.toolName,
      toolDescription: request.toolDescription,
      toolSchema: request.toolSchema,
      maxTokens: request.maxTokens,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const reading = reader.toMeaningReading(call.value, fixture.screen);
    const ok = grade(reading, fixture.expect);
    if (!ok) failures.push(fixture.id);
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${fixture.id}`);
  }
  if (dry) {
    console.info(dryReportLine('meaning-screen'));
    return;
  }
  console.info(
    `meaning-screen | fixtures=${fixtures.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
