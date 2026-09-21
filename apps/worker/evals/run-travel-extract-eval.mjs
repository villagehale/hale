// A booking email becomes one text a week before · the eval for the extract-travel-booking
// skill.
//
// SUBJECT: whether the skill reads one confirmation email as the right trip — the city,
// the two dates, and whether the booking's own text says a child is travelling. Nothing
// downstream re-checks any of it. The city is stored, served back to the family in a
// right-to-access copy, and sent to a search engine; `child_evidence` IS the rule "Hale
// never briefs a solo work trip". So this is the gate, and it ships BEFORE the pass that
// calls it (rule #8: no mocking the model; the quality claim is an eval).
//
// WHY EXACT RATHER THAN JUDGED. Every answer here is a place name, two ISO dates and one
// of three words. There is nothing for a judge to add, and a judge would only soften the
// two properties that matter: "Scarborough" must be Toronto, not nearly-Toronto, and a
// solo itinerary must be `none`, not probably-none.
//
// THE LANE IS CARRIED FAITHFULLY. The runtime calls this through `pickLane('extract')` —
// Sonnet 5, thinking adaptive, effort high, max_tokens 1024 — and those fields are part of
// the request AND of the cache key, because a thinking-off replay would measure a
// different model than the one production runs. The tool schema is read out of
// apps/web/lib/travel/extract.ts, so a field added there and not here re-keys the cache
// rather than silently grading a schema production does not send.
//
//   node --env-file=../../.env evals/run-travel-extract-eval.mjs             # live (populates cache)
//   node --env-file=../../.env evals/run-travel-extract-eval.mjs --no-skill  # calibration: must FAIL
//   node evals/run-travel-extract-eval.mjs --cached-only                     # CI: replay, zero API calls
//
// The `--no-skill` arm mints its OWN cache keys and is a calibration run a human does by
// hand; CI runs the real arm, so only the real arm's cache is committed.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { TRAVEL_EXTRACT_FIXTURES } from './travel-extract-fixtures.mjs';
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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'extract-travel-booking.md');
const EXTRACT_TS = join(REPO_ROOT, 'apps', 'web', 'lib', 'travel', 'extract.ts');

const TOOL_NAME = 'travel_booking';

/**
 * The runtime's own ceiling and vocabulary, read from the module rather than restated
 * here: a value changed in one place and not the other would otherwise pass this eval by
 * having been written down twice.
 */
async function readRuntimeContract() {
  const src = await readFile(EXTRACT_TS, 'utf8');
  const maxTokens = /const MAX_TOKENS = (\d+);/.exec(src);
  if (!maxTokens) throw new Error(`could not parse MAX_TOKENS from ${EXTRACT_TS}`);
  const values = /export const CHILD_EVIDENCE_VALUES = \[([\s\S]*?)\] as const;/.exec(src);
  if (!values) throw new Error(`could not parse CHILD_EVIDENCE_VALUES from ${EXTRACT_TS}`);
  const childEvidence = [...values[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // The property names the runtime's tool schema declares. Parsed rather than trusted, so
  // a seventh field added in production is a cache miss here instead of an untested field.
  const schemaBlock = /export const travelToolJsonSchema = \{([\s\S]*?)\n\} as const;/.exec(src);
  if (!schemaBlock) throw new Error(`could not parse travelToolJsonSchema from ${EXTRACT_TS}`);
  const properties = [...schemaBlock[1].matchAll(/^ {4}([a-z_]+): \{/gm)].map((m) => m[1]);
  return { maxTokens: Number(maxTokens[1]), childEvidence, properties };
}

function toolSchema(childEvidence) {
  return {
    type: 'object',
    properties: {
      destination_city: {
        type: ['string', 'null'],
        description: 'The municipality travelled TO. Never a street, a property or a district.',
      },
      destination_region: {
        type: ['string', 'null'],
        description: 'The province, state or country, when the email states it plainly.',
      },
      start_date: { type: ['string', 'null'], description: 'YYYY-MM-DD departure / check-in.' },
      end_date: {
        type: ['string', 'null'],
        description: 'YYYY-MM-DD return / check-out, or null.',
      },
      child_evidence: {
        type: 'string',
        enum: childEvidence,
        description: "Why the booking's own text says a child is travelling, or 'none'.",
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['destination_city', 'start_date', 'child_evidence', 'confidence'],
  };
}

/** The user message the runtime composes — the same JSON, field for field. */
function userMessage(fixture) {
  return JSON.stringify({
    email: { subject: fixture.subject, from: fixture.from, body: fixture.body },
    received_at: fixture.receivedAt,
    household_child_first_names: fixture.childFirstNames,
  });
}

/**
 * One cached call on the EXTRACT lane. The harness's `cachedToolCall` cannot carry
 * `thinking` / `output_config`, and leaving them off would replay a model production does
 * not run — so this is the lane-faithful version, keyed on the same fields it sends.
 */
async function cachedTravelCall({ tag, model, system, message, schema, maxTokens, cachedOnly, getClient, cost }) {
  const thinking = { type: 'adaptive' };
  const outputConfig = { effort: 'high' };
  const canonical = JSON.stringify({
    model,
    system,
    userMessage: message,
    schema,
    thinking,
    outputConfig,
    maxTokens,
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
    max_tokens: maxTokens,
    thinking,
    output_config: outputConfig,
    system,
    tools: [
      {
        name: TOOL_NAME,
        description: 'Return the structured travel-booking extraction.',
        input_schema: schema,
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: message }],
  });
  // A truncated forced tool call is not an answer and must never be cached as one: it
  // arrives as `input: {}` and reads downstream as "this email said nothing".
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `${tag}: tool call truncated at max_tokens (${maxTokens}) - raise the budget; nothing cached`,
    );
  }
  const toolUse = response.content.find(
    (block) => block.type === 'tool_use' && block.name === TOOL_NAME,
  );
  if (!toolUse) throw new Error(`${tag}: model returned no ${TOOL_NAME} tool call`);
  noteUsage(cost, model, response.usage);
  await cachePut(key, { value: toolUse.input, stopReason: response.stop_reason });
  return { value: toolUse.input, stopReason: response.stop_reason, cached: false };
}

/** Case-, accent- and punctuation-insensitive, so one place compares as one thing. */
function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Failure strings; empty means the fixture passed. */
function check(fixture, value) {
  const problems = [];
  const want = fixture.expect;

  const city = value?.destination_city ?? null;
  if (want.city === null) {
    if (city !== null && fold(city) !== '') problems.push(`CITY want=null got=${String(city)}`);
  } else {
    const accepted = Array.isArray(want.city) ? want.city : [want.city];
    if (!accepted.some((option) => fold(option) === fold(city))) {
      problems.push(`CITY want=${accepted.join('|')} got=${String(city)}`);
    }
  }

  if (want.region !== undefined) {
    if (fold(value?.destination_region) !== fold(want.region)) {
      problems.push(`REGION want=${want.region} got=${String(value?.destination_region)}`);
    }
  }

  // The dates are graded only where there IS a trip: a null city already ends it
  // downstream, so requiring the model to also suppress dates it can plainly see would
  // grade something the product never reads.
  if (want.city !== null) {
    for (const [field, key] of [
      ['start', 'start_date'],
      ['end', 'end_date'],
    ]) {
      const got = value?.[key] ?? null;
      if (got !== want[field]) problems.push(`${key.toUpperCase()} want=${want[field]} got=${String(got)}`);
    }
  }

  const evidence = value?.child_evidence ?? 'none';
  if (evidence !== want.childEvidence) {
    problems.push(`CHILD_EVIDENCE want=${want.childEvidence} got=${String(evidence)}`);
  }

  const confidence = value?.confidence;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    problems.push(`CONFIDENCE not a 0-1 number (${String(confidence)})`);
  }

  const serialised = JSON.stringify(value ?? {});
  for (const forbidden of fixture.forbidInOutput ?? []) {
    if (serialised.toLowerCase().includes(String(forbidden).toLowerCase())) {
      problems.push(`LEAKED ${forbidden}`);
    }
  }
  // THE CONFIRMATION-NUMBER GUARD, on every fixture and not only the one that names it.
  // An ISO date is never six consecutive digits, so any 6+ run in a returned field is a
  // reference, an order number or an amount — the class of value this feature must never
  // store, export or send to a search engine.
  for (const [field, got] of Object.entries(value ?? {})) {
    if (typeof got === 'string' && /\d{6,}/.test(got)) {
      problems.push(`DIGIT RUN in ${field}: ${got}`);
    }
  }
  return problems;
}

async function main() {
  const noSkill = process.argv.includes('--no-skill');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const models = await readModelIds();
  // The skill declares task: extract → Sonnet 5. Read from model.ts, never hardcoded.
  const model = models.sonnet5;
  const { maxTokens, childEvidence, properties } = await readRuntimeContract();
  const schema = toolSchema(childEvidence);

  // The runtime's schema and this one must declare the same fields, or the corpus is
  // grading a shape production does not send.
  const mine = Object.keys(schema.properties).sort();
  if (JSON.stringify(mine) !== JSON.stringify([...properties].sort())) {
    throw new Error(
      `tool schema drift: runtime declares ${properties.join(',')} and this eval sends ${mine.join(',')}`,
    );
  }

  // THE MUTATION GATE. With the skill body deleted the model is left with the tool
  // schema's own one-line descriptions — which is exactly what "the model's priors" looks
  // like. If that still passes, this eval is measuring Claude and not the skill.
  const system = noSkill
    ? 'Read the email and return the travel_booking tool call.'
    : skill.instructions;

  console.log(
    `travel-extract-eval | mode=${noSkill ? 'no-skill' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );
  console.log(
    `skill=${skill.meta.name} task=${skill.meta.task} max_tokens=${maxTokens} | corpus: ${TRAVEL_EXTRACT_FIXTURES.length} bookings\n`,
  );

  const getClient = lazyAnthropic();
  const cost = makeCost();
  let failed = 0;
  let live = 0;

  for (const fixture of TRAVEL_EXTRACT_FIXTURES) {
    const result = await cachedTravelCall({
      tag: `travel-extract:${noSkill ? 'no-skill:' : ''}${fixture.id}`,
      model,
      system,
      message: userMessage(fixture),
      schema,
      maxTokens,
      cachedOnly,
      getClient,
      cost,
    });
    if (!result.cached) live += 1;

    const problems = check(fixture, result.value);
    if (result.stopReason === 'max_tokens') problems.push('TRUNCATED at max_tokens');
    if (problems.length === 0) {
      console.log(`PASS  ${fixture.id}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${fixture.id} — ${fixture.why}`);
      for (const problem of problems) console.log(`      ${problem}`);
    }
  }

  console.log(`\nlive calls: ${live} | est. cost: $${totalUsd(cost).toFixed(4)}`);
  console.log('--- gate ---');
  console.log(
    `${TRAVEL_EXTRACT_FIXTURES.length - failed}/${TRAVEL_EXTRACT_FIXTURES.length} bookings read exactly`,
  );

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
