// VIL-520 · Carpool reader eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/carpool-reading.md, called the way the runtime calls it
// (apps/web/lib/channel/linq/carpool-reading.ts): the same user message, tool, schema, lane
// and max_tokens, imported from that file. The grade runs the runtime's own parse
// (`parseCarpoolReading`) and pickup resolver (`resolveCarpoolPickup`) on the model's
// reading and checks the structured outcome: intent, driver, local day and hour, and the
// instant stored. No wording is graded. Every `now` is a fixed clock from the fixtures.
//
// Runs cached-only in ci.yml (eval:carpool). A miss never spends.
//
//   node evals/carpool-eval.mjs --dry           # worst-case price to record; no API, nothing written
//   node evals/carpool-eval.mjs --cached-only   # replay; a miss exits 1
//   HALE_SPEND_LEDGER=... node --env-file=../../.env evals/carpool-eval.mjs --record --max-usd 0.10

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  CARPOOL_READING_FIXTURES,
  gradeCarpoolReading,
  gradeSharedKept,
} from './carpool-reading-fixtures.mjs';
import {
  PRICE,
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'carpool-reading.md');
const READING_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'carpool-reading.ts');
const APPLY_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'carpool-apply.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 3);
}

function worstCaseUsd({ lane, skill, reading }) {
  const price = PRICE[lane.model];
  if (!price) throw new Error(`no list price for ${lane.model}`);
  let usd = 0;
  for (const fixture of CARPOOL_READING_FIXTURES) {
    const input =
      estimateTokens(skill.instructions) +
      estimateTokens(reading.carpoolUserMessage(fixture.input)) +
      estimateTokens(reading.CARPOOL_READING_TOOL_SCHEMA);
    usd += (input / 1e6) * price.input + (reading.CARPOOL_READING_MAX_TOKENS / 1e6) * price.output;
  }
  return usd;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const cachedOnly = process.argv.includes('--cached-only');
  const record = process.argv.includes('--record');
  if ([dry, cachedOnly, record].filter(Boolean).length !== 1) {
    console.error(
      'carpool: pass exactly one of --dry, --cached-only or --record. Only --record calls the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const reading = await importTs(READING_SRC);
  const apply = await importTs(APPLY_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);

  if (dry) {
    const usd = worstCaseUsd({ lane, skill, reading });
    console.info(
      `carpool: worst case to record ${CARPOOL_READING_FIXTURES.length} fixtures (${lane.model}), every call at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`,
    );
    return;
  }

  if (record) installEvalSpendCap();
  const getClient = lazyAnthropic('carpool');
  const cost = makeCost();
  console.info(`carpool eval | mode=${record ? 'record' : 'cached-only'} | subject=${lane.model}`);
  let passed = true;
  for (const fixture of CARPOOL_READING_FIXTURES) {
    const { value } = await cachedToolCall({
      tag: `carpool-reading:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: reading.carpoolUserMessage(fixture.input),
      toolName: reading.CARPOOL_READING_TOOL,
      toolSchema: reading.CARPOOL_READING_TOOL_SCHEMA,
      toolDescription: reading.CARPOOL_READING_TOOL_DESCRIPTION,
      maxTokens: reading.CARPOOL_READING_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const parsed = reading.parseCarpoolReading(value);
    const pickupAt =
      apply.resolveCarpoolPickup(parsed, fixture.input.timeZone)?.toISOString() ?? null;
    const failures = gradeCarpoolReading(fixture.expect, { reading: parsed, pickupAt });
    if (fixture.shared) {
      const kept = apply.keepWhatTheChatSaid(parsed, [fixture.input.text]);
      failures.push(...gradeSharedKept(fixture.expect, kept));
    }
    console.info(
      `${failures.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(32)} ${parsed.intent} ${parsed.pickupDate ?? '-'} ${parsed.pickupTime ?? '-'} ${pickupAt ?? '-'}`,
    );
    for (const f of failures) console.info(`      · ${f}`);
    if (failures.length > 0) passed = false;
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(passed ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('carpool eval harness error:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
