// Shared-group inference · classifier eval (VIL-456, hard rule #8: no LLM mocking).
//
// The subject is the REAL skill through the REAL request shape. The gate is the
// intent label: a wrong reading seats the wrong family or answers banter.
// Judges score meaning. VIL-459: a find-time reading is also checked on the times the
// chat ruled out (objective instants per fixture), parsed by the REAL parser. A pick must
// name the exact offered start the fixture expects, and a titled ask must carry a title.
//
//   node evals/run-shared-group-reading-eval.mjs --estimate     # no API
//   node evals/run-shared-group-reading-eval.mjs --cached-only  # CI once recorded
//   node evals/run-shared-group-reading-eval.mjs --broken       # calibration

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import { SHARED_GROUP_READING_FIXTURES } from './shared-group-reading-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'shared-group-reading.md');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'shared-group-reading.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const MAX_TOKENS = 400; // SHARED_GROUP_READ_MAX_TOKENS in shared-group-reading.ts
const SONNET_IN = 3;
const SONNET_OUT = 15;

function tokens(chars) {
  return Math.ceil(chars / 4);
}

function estimateWorstCase() {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  let worst = 0;
  let expected = 0;
  for (const fixture of SHARED_GROUP_READING_FIXTURES) {
    const input = JSON.stringify(fixture.input);
    const inputTokens = tokens(skill.length + input.length);
    expected += (inputTokens / 1e6) * SONNET_IN + (80 / 1e6) * SONNET_OUT;
    const hold = (inputTokens / 1e6) * SONNET_IN + (MAX_TOKENS / 1e6) * SONNET_OUT;
    worst += hold;
  }
  return { fixtures: SHARED_GROUP_READING_FIXTURES.length, expected, worst };
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const estimateOnly = process.argv.includes('--estimate');
  if (estimateOnly && cachedOnly) {
    console.error('shared-group-reading: pass only one of --estimate and --cached-only');
    process.exit(1);
  }
  const quote = estimateWorstCase();
  if (estimateOnly) {
    console.info(`shared-group-reading estimate | fixtures=${quote.fixtures} | no API calls`);
    console.info(`expected: $${quote.expected.toFixed(4)} USD`);
    console.info(`worst-case one live run: $${quote.worst.toFixed(4)} USD`);
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('shared-group-reading');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { parseSharedGroupReading, sharedGroupReadingJsonSchema, sharedGroupUserMessage } =
    await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const toolSchema = sharedGroupReadingJsonSchema;
  const held = (spans, iso) =>
    spans.some(
      (span) =>
        span.start.getTime() <= new Date(iso).getTime() &&
        new Date(iso).getTime() < span.end.getTime(),
    );

  console.log(
    `shared-group-reading eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );
  const results = [];
  for (const fixture of SHARED_GROUP_READING_FIXTURES) {
    const offered = (fixture.input.offered ?? []).map((slot) => slot.start);
    const reading = broken
      ? { intent: 'question', ruledOut: [], picked: null, planTitle: null, kidNames: [] }
      : parseSharedGroupReading(
          (
            await cachedToolCall({
              tag: `shared-group-reading:${fixture.id}`,
              model,
              lane,
              system: skill.instructions,
              userMessage: sharedGroupUserMessage(fixture.input),
              toolName: 'record_shared_group_reading',
              toolSchema,
              toolDescription: 'What this person meant in the shared group.',
              maxTokens: MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            })
          ).value,
          offered,
        );
    const intent = reading.intent;
    const spans = reading.ruledOut ?? [];
    const timesOk =
      (fixture.covers ?? []).every((iso) => held(spans, iso)) &&
      !(fixture.open ?? []).some((iso) => held(spans, iso));
    const pickOk = !fixture.picked || reading.picked?.toISOString() === fixture.picked;
    const titleOk = !fixture.titled || Boolean(reading.planTitle);
    const fold = (names) => [...names].map((name) => name.toLowerCase()).sort();
    const kids = reading.kidNames ?? [];
    const kidsOk =
      !fixture.kids || JSON.stringify(fold(kids)) === JSON.stringify(fold(fixture.kids));
    results.push({
      fixture,
      intent,
      pass: fixture.accept.includes(intent) && timesOk && pickOk && titleOk && kidsOk,
      kids,
      spans,
      picked: reading.picked ? reading.picked.toISOString() : null,
      title: reading.planTitle ?? null,
    });
  }
  for (const r of results) {
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(32)} intent=${r.intent} accept=${r.fixture.accept.join('|')} ruledOut=${r.spans.length} picked=${r.picked ?? '-'} title=${r.title ?? '-'} kids=${r.kids.join('+') || '-'}`,
    );
    if (!r.pass && r.spans.length > 0) {
      console.log(
        `      spans: ${r.spans.map((x) => `${x.start.toISOString()}..${x.end.toISOString()}`).join(', ')}`,
      );
    }
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.pass);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('shared-group-reading eval harness error:', err);
  process.exit(2);
});
