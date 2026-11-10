// connector-disconnect-read eval (VIL-156).
//
// The model reads whether a parent is asking Hale to disconnect Google NOW, asking a
// question about it, or saying something else. A `disconnect` reading revokes Hale's
// whole Google grant, so the output has an exactly right answer: scored through the same
// accept production uses, with no judge.
//
// One forced call per fixture, max 256 tokens, Haiku (`task: screen`). The request shape,
// schema and accept are imported from apps/web/lib/channel/connect/disconnect-read.ts, so
// the eval cannot drift from production.
//
// Usage (from apps/worker):
//   node evals/run-connector-disconnect-read-eval.mjs --preflight
//   node evals/run-connector-disconnect-read-eval.mjs --cached-only
//   HALE_SPEND_LEDGER=... node evals/run-connector-disconnect-read-eval.mjs --dry --max-usd N
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { CONNECTOR_DISCONNECT_READ_FIXTURES } from './connector-disconnect-read-fixtures.mjs';
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
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'connector-disconnect-read.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'connect', 'disconnect-read.ts');
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
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const fixtures = CONNECTOR_DISCONNECT_READ_FIXTURES;

  if (preflight) {
    const inputTokens = Math.ceil((skill.instructions.length + 120) / 4);
    const worst =
      fixtures.length *
      ((inputTokens / 1e6) * HAIKU_IN + (reader.DISCONNECT_READ_MAX_TOKENS / 1e6) * HAIKU_OUT);
    console.info(
      `connector-disconnect-read preflight | fixtures=${fixtures.length} model=${lane.model} | worst $${worst.toFixed(6)} | judges=0`,
    );
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('connector-disconnect-read');
  const cost = makeCost();
  const failures = [];
  for (const fixture of fixtures) {
    const call = await cachedToolCall({
      tag: `connector-disconnect-read:${reader.DISCONNECT_READ_MAX_TOKENS}:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: reader.disconnectReadUserMessage({
        text: fixture.text,
        language: fixture.language,
      }),
      toolName: 'disconnect_read',
      toolDescription: 'Return whether the parent is asking Hale to disconnect now.',
      toolSchema: reader.DISCONNECT_READ_TOOL_SCHEMA,
      maxTokens: reader.DISCONNECT_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const reading = reader.acceptDisconnectReading(call.value);
    const ok = reading === fixture.expect;
    if (!ok) failures.push(fixture.id);
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${fixture.id}  ${reading} (wanted ${fixture.expect})`);
    if (!ok) console.info(`      reason: ${call.value?.reason ?? ''}`);
  }
  if (dry) {
    console.info(dryReportLine('connector-disconnect-read'));
    return;
  }
  console.info(
    `connector-disconnect-read | fixtures=${fixtures.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
