// Feedback that reaches the next parent · the eval for the activity-verdict skill.
//
// SUBJECT: whether the skill reads one parent's reply to "how did it go?" as the right
// state. Nothing downstream re-checks it — the verdict IS the row, and a row is what
// another family is eventually shown — so this is the gate, and it ships BEFORE the
// pass that calls it (rule #8: no mocking the model; the quality claim is an eval, not
// a process commitment).
//
// WHY EXACT RATHER THAN JUDGED. Every answer here is one of four words and a subset of
// eight. There is nothing for a judge to add and a judge would only soften the one
// property that matters: "it was fine" must be `none`, not nearly-none.
//
// THE LANE IS CARRIED FAITHFULLY. The runtime calls this through `pickLane('classify')`
// — Sonnet 5, thinking adaptive, effort high — and those fields are part of the request
// AND of the cache key, because a thinking-off replay would measure a different model
// than the one production runs.
//
//   node --env-file=../../.env evals/run-activity-verdict-eval.mjs             # live (populates cache)
//   node --env-file=../../.env evals/run-activity-verdict-eval.mjs --no-skill  # calibration: must FAIL
//   node evals/run-activity-verdict-eval.mjs --cached-only                     # CI: replay, zero API calls

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { VERDICT_FIXTURES } from './activity-verdict-fixtures.mjs';
import {
  REPO_ROOT,
  cacheGet,
  cacheKey,
  cachePut,
  lazyAnthropic,
  makeCost,
  noteUsage,
  readModelIds,
  totalUsd,
} from './lib/harness.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'activity-verdict.md');
const SCHEMA_TS = join(REPO_ROOT, 'packages', 'db', 'src', 'schema', 'activity-reviews.ts');

/** The output cap the runtime uses (lib/reviews/verdict.ts). It bounds thinking AND text
 * together on Sonnet 5, which is why the long fixture exists. */
const MAX_TOKENS = 512;

/** The vocabularies, read from the schema rather than restated here, so a tag added to
 * the CHECK and not to the skill cannot pass this eval by being written down twice. */
async function readVocabularies() {
  const src = await readFile(SCHEMA_TS, 'utf8');
  const list = (name) => {
    const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(src);
    if (!m) throw new Error(`could not parse ${name} from ${SCHEMA_TS}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  return { verdicts: list('ACTIVITY_VERDICTS'), tags: list('ACTIVITY_REVIEW_TAGS') };
}

function toolSchema(verdicts) {
  return {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: [...verdicts, 'none'],
        description: 'What the reply amounted to, or "none" when the words do not say.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          "At most three tags from the skill's closed list, for things the parent actually said. Empty is normal.",
      },
    },
    required: ['verdict'],
  };
}

/**
 * One cached call on the CLASSIFY lane. The harness's `cachedToolCall` cannot carry
 * `thinking`/`output_config`, and leaving them off would replay a model production does
 * not run — so this is the lane-faithful version, keyed on the same fields it sends.
 */
async function cachedVerdictCall({
  tag,
  model,
  system,
  userMessage,
  schema,
  cachedOnly,
  getClient,
  cost,
}) {
  const thinking = { type: 'adaptive' };
  const outputConfig = { effort: 'high' };
  const canonical = JSON.stringify({
    model,
    system,
    userMessage,
    schema,
    thinking,
    outputConfig,
    maxTokens: MAX_TOKENS,
  });
  const key = cacheKey(tag, canonical);

  const cached = await cacheGet(key);
  if (cached) return { value: cached.value, stopReason: cached.stopReason, cached: true };
  if (cachedOnly) {
    throw new Error(
      `${tag}: --cached-only and no cached response (key ${key}). Run the eval live once to populate the cache.`,
    );
  }

  const response = await getClient().messages.create({
    model,
    max_tokens: MAX_TOKENS,
    thinking,
    output_config: outputConfig,
    system,
    tools: [
      {
        name: 'activity_verdict',
        description: 'Return what this reply amounted to.',
        input_schema: schema,
      },
    ],
    tool_choice: { type: 'tool', name: 'activity_verdict' },
    messages: [{ role: 'user', content: userMessage }],
  });
  // A truncated forced tool call is not an answer and must never be cached as one: it
  // arrives as `input: {}` and reads downstream as "the parent said nothing".
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `${tag}: tool call truncated at max_tokens (${MAX_TOKENS}) - raise the budget; nothing cached`,
    );
  }
  const toolUse = response.content.find(
    (block) => block.type === 'tool_use' && block.name === 'activity_verdict',
  );
  if (!toolUse) throw new Error(`${tag}: model returned no activity_verdict tool call`);
  noteUsage(cost, model, response.usage);
  await cachePut(key, { value: toolUse.input, stopReason: response.stop_reason });
  return { value: toolUse.input, stopReason: response.stop_reason, cached: false };
}

/** Failure strings; empty means the fixture passed. */
function check(fixture, value, knownTags) {
  const problems = [];
  const verdict = value?.verdict;
  if (verdict !== fixture.verdict) {
    problems.push(`VERDICT want=${fixture.verdict} got=${String(verdict)}`);
  }

  const got = Array.isArray(value?.tags) ? value.tags.map(String) : [];
  for (const tag of got) {
    if (!knownTags.includes(tag)) problems.push(`OFF-VOCABULARY TAG ${tag}`);
  }
  if (got.length > 3) problems.push(`TOO MANY TAGS (${got.length})`);
  for (const want of fixture.tags) {
    if (!got.includes(want)) problems.push(`MISSING TAG ${want}`);
  }
  // A tag the parent did not say is what travels to another household, so an extra one
  // is a hard fail rather than a rounding error.
  for (const tag of got) {
    if (!fixture.tags.includes(tag)) problems.push(`UNSTATED TAG ${tag}`);
  }

  // Rule #1: nothing that could carry a name has a field to live in, and this asserts it
  // against the whole serialised answer rather than a field list.
  const serialised = JSON.stringify(value ?? {});
  for (const forbidden of fixture.forbidInOutput ?? []) {
    if (serialised.includes(forbidden)) problems.push(`LEAKED ${forbidden}`);
  }
  return problems;
}

async function main() {
  const noSkill = process.argv.includes('--no-skill');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const models = await readModelIds();
  // The skill declares task: classify → Sonnet 5. Read from model.ts, never hardcoded.
  const model = models.sonnet5;
  const { verdicts, tags: knownTags } = await readVocabularies();
  const schema = toolSchema(verdicts);

  // THE MUTATION GATE. With the skill body deleted the model is left with the tool
  // schema's own one-line descriptions — which is exactly what "the model's priors"
  // looks like. If that still passes, this eval is measuring Claude and not the skill.
  const system = noSkill
    ? 'Read the message and return the verdict tool call.'
    : skill.instructions;

  console.log(
    `activity-verdict-eval | mode=${noSkill ? 'no-skill' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );
  console.log(`skill=${skill.meta.name} task=${skill.meta.task} max_tokens=${MAX_TOKENS}\n`);

  const getClient = lazyAnthropic();
  const cost = makeCost();
  let failed = 0;
  let live = 0;

  for (const fixture of VERDICT_FIXTURES) {
    const result = await cachedVerdictCall({
      tag: `activity-verdict:${noSkill ? 'no-skill:' : ''}${fixture.id}`,
      model,
      system,
      userMessage: fixture.body,
      schema,
      cachedOnly,
      getClient,
      cost,
    });
    if (!result.cached) live += 1;

    const problems = check(fixture, result.value, knownTags);
    if (result.stopReason === 'max_tokens') problems.push('TRUNCATED at max_tokens');
    if (problems.length === 0) {
      console.log(`PASS  ${fixture.id}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${fixture.id} — ${fixture.why}`);
      console.log(`      body: ${fixture.body.slice(0, 120)}`);
      for (const problem of problems) console.log(`      ${problem}`);
    }
  }

  console.log(`\nlive calls: ${live} | est. cost: $${totalUsd(cost).toFixed(4)}`);
  console.log('--- gate ---');
  console.log(`${VERDICT_FIXTURES.length - failed}/${VERDICT_FIXTURES.length} fixtures exact`);

  if (!noSkill) {
    const ok = failed === 0;
    console.log(`real-mode gate (all fixtures must pass): ${ok ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(ok ? 0 : 1);
  }

  const calibrated = failed > 0;
  console.log(
    `no-skill calibration (must fail at least one): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
