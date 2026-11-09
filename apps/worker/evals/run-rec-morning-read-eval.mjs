// rec-morning-read eval (VIL-545).
//
// The model reads whether the city registration facts the rec-morning lane holds answer
// a parent's text. The texts share a word with the facts ("swim pickup"), on the group
// and the 1:1 path. Only `answers` lets the lane speak, so the output has an exactly
// right answer: scored through the same accept production uses, with no judge.
//
// One forced call per fixture, max 256 tokens, Haiku (`task: screen`). The request shape,
// schema and accept are imported from apps/web/lib/channel/rec-morning/read.ts, and the
// facts are the production word test's own output at a fixed clock, so the eval cannot
// drift from production.
//
// Usage (from apps/worker):
//   node evals/run-rec-morning-read-eval.mjs --preflight
//   node evals/run-rec-morning-read-eval.mjs --cached-only
//   HALE_SPEND_LEDGER=... node evals/run-rec-morning-read-eval.mjs --dry --max-usd N
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
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
import {
  REC_MORNING_READ_FIXTURES,
  REC_MORNING_READ_NOW,
  REC_MORNING_READ_WHERE,
} from './rec-morning-read-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'rec-morning-read.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'rec-morning', 'read.ts');
const COPY_SRC = join(WEB_ROOT, 'lib', 'channel', 'rec-morning', 'copy.ts');
const HAIKU_IN = 1;
const HAIKU_OUT = 5;

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const preflight = process.argv.includes('--preflight');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const reader = await importTs(READER_SRC);
  const copy = await importTs(COPY_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const fixtures = REC_MORNING_READ_FIXTURES;

  if (preflight) {
    const inputTokens = Math.ceil((skill.instructions.length + 600) / 4);
    const worst =
      fixtures.length *
      ((inputTokens / 1e6) * HAIKU_IN + (reader.REC_MORNING_READ_MAX_TOKENS / 1e6) * HAIKU_OUT);
    console.info(
      `rec-morning-read preflight | fixtures=${fixtures.length} model=${lane.model} | worst $${worst.toFixed(6)} | judges=0`,
    );
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('rec-morning-read');
  const cost = makeCost();
  const failures = [];
  for (const fixture of fixtures) {
    const facts = copy.recMorningReply(
      fixture.text,
      new Date(REC_MORNING_READ_NOW),
      REC_MORNING_READ_WHERE,
    );
    if (facts === null) throw new Error(`${fixture.id}: the word test offers no facts`);
    const call = await cachedToolCall({
      tag: `rec-morning-read:${reader.REC_MORNING_READ_MAX_TOKENS}:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: reader.recMorningReadUserMessage({ text: fixture.text, facts, language: 'en' }),
      toolName: 'rec_morning_read',
      toolDescription: 'Return whether these facts answer what the parent is asking.',
      toolSchema: reader.REC_MORNING_READ_TOOL_SCHEMA,
      maxTokens: reader.REC_MORNING_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const reading = reader.acceptRecMorningReading(call.value);
    const ok = reading === fixture.expect;
    if (!ok) failures.push(fixture.id);
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.path}  ${fixture.id}  ${reading} (wanted ${fixture.expect})`,
    );
    if (!ok) console.info(`      reason: ${call.value?.reason ?? ''}`);
  }
  if (dry) {
    console.info(dryReportLine('rec-morning-read'));
    return;
  }
  console.info(
    `rec-morning-read | fixtures=${fixtures.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
