// The inbound burst reader eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/inbound-burst-read.md) run through
// the REAL forced-tool-JSON request shape apps/web/lib/channel/router/burst-reader.ts
// builds - REPLICATED here, as the holding-line eval replicates holding-line.ts, because
// that module sits behind the web app's `~/` alias. The SKILL body and the model routing
// ARE imported live, so a skill edit or a re-tiering re-keys the cache and shows up as a
// miss.
//
// WHAT IS AT STAKE. Grouping a correction apart from what it corrects sends the stale
// answer ($600 when the parent said $900). Grouping two unrelated asks together gives one
// muddled reply. A text that asks nothing on its own ("wait, two more coming") must never
// be answered alone.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-inbound-burst-eval.mjs --live      # live, then caches
//   node evals/run-inbound-burst-eval.mjs --broken --cached-only            # calibration: must FAIL
//   node evals/run-inbound-burst-eval.mjs --cached-only                     # CI: replay only
//
// The metric is objective: the grouping must be one of the fixture's allowed partitions.
// An invalid partition (a text missing, repeated or invented, or an empty group) is a hard
// zero. No judge.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { INBOUND_BURST_FIXTURES } from './inbound-burst-fixtures.mjs';
import {
  assertRunFlags,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'inbound-burst-read.md');

// ── the reader's request shape, replicated (burst-reader.ts) ─────────────────

/** Mirrors MAX_TOKENS in burst-reader.ts. */
const MAX_TOKENS = 512;

const READING_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    groups: {
      type: 'array',
      items: { type: 'array', items: { type: 'string' } },
    },
  },
  required: ['reasoning', 'groups'],
};

/** Mirrors `burstReaderUserMessage` in burst-reader.ts (first ask, nothing rejected). */
function burstReaderUserMessage(fixture) {
  return JSON.stringify({
    previousHaleLine: fixture.previousHaleLine,
    messages: fixture.messages,
  });
}

/** Mirrors `partitionProblems` in burst-reader.ts. */
function partitionProblems(refs, groups) {
  const known = new Set(refs);
  const seen = new Set();
  let repeated = false;
  let unknown = false;
  for (const group of groups) {
    for (const ref of group) {
      if (!known.has(ref)) unknown = true;
      else if (seen.has(ref)) repeated = true;
      seen.add(ref);
    }
  }
  const problems = [];
  if (refs.some((ref) => !seen.has(ref))) problems.push('ref_missing');
  if (repeated) problems.push('ref_repeated');
  if (unknown) problems.push('ref_unknown');
  if (groups.some((group) => group.length === 0)) problems.push('empty_group');
  return problems;
}

/** Order-free form: each group sorted by send order, groups sorted by their first ref. */
function canonical(refs, groups) {
  const at = (ref) => refs.indexOf(ref);
  return JSON.stringify(
    groups
      .map((group) => [...group].sort((a, b) => at(a) - at(b)))
      .sort((a, b) => at(a[0]) - at(b[0])),
  );
}

async function main() {
  assertRunFlags(['--broken', '--env-file', '--max-usd']);
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('inbound-burst');
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);

  console.log(
    `inbound-burst eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | reader=${model}`,
  );
  console.log(`corpus: ${INBOUND_BURST_FIXTURES.length} bursts\n`);

  const results = [];
  for (const fixture of INBOUND_BURST_FIXTURES) {
    const refs = fixture.messages.map((message) => message.ref);
    // --broken: a reader that folds everything into one turn. It must fail the corpus.
    const value = broken
      ? { reasoning: 'fold everything', groups: [refs] }
      : (
          await cachedToolCall({
            tag: `inbound-burst:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: burstReaderUserMessage(fixture),
            toolName: 'group_texts',
            toolSchema: READING_TOOL_SCHEMA,
            toolDescription: 'Group the texts the parent sent back to back by what they ask.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    const groups = Array.isArray(value.groups) ? value.groups : [];
    const failures = partitionProblems(refs, groups).map((problem) => `invalid: ${problem}`);
    if (failures.length === 0) {
      const got = canonical(refs, groups);
      const allowed = fixture.allowed.map((partition) => canonical(refs, partition));
      if (!allowed.includes(got)) failures.push(`grouped ${got}, allowed ${allowed.join(' or ')}`);
    }
    results.push({ fixture, groups, reasoning: value.reasoning, failures });
  }

  console.log('--- groupings ---');
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)} ${JSON.stringify(r.groups)}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
    if (r.failures.length > 0 && r.reasoning) console.log(`      reasoning: ${r.reasoning}`);
  }

  const passed = results.filter((r) => r.failures.length === 0).length;
  console.log('\n--- corpus metrics ---');
  console.log(`correct groupings: ${passed}/${results.length}  (all required)`);
  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = passed === results.length;
  console.log('\n--- gate ---');
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const calibrated = !allPass;
  console.log(
    `broken-mode calibration (must fail at least one fixture): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('inbound-burst eval harness error:', err);
  process.exit(2);
});
