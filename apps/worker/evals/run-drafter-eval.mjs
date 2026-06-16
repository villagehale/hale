#!/usr/bin/env node
// Drafter eval harness (review finding #14 — the drafter had no eval).
//
// Root CLAUDE.md hard rule #8: no LLM mocking — real Claude responses, cached.
// The drafter is the ONLY agent whose text a family actually receives, so its
// eval gates on what a reader would notice: no placeholder tokens, a length
// bound, no invented specifics (a cheap grounding check), required structural
// fields present, the recipient echoed — PLUS an LLM-as-judge tone score. Draft
// text is open-ended, so we gate on CHECKABLE properties, never exact strings.
//
// IMPORT vs REPLICATE: identical reasoning to run-eval.mjs — src/agents/drafter.ts
// is TypeScript over workspace packages and the committed dist/ is stale, so we
// REPLICATE the exact request shape instead: same prompt file (prompts/drafter.md),
// same model id (SONNET_MODEL, read from src/anthropic/client.ts), and the same
// tool-forced JSON schema (draft_action) that src/agents/drafter.ts uses. The
// judge model id (HAIKU_MODEL) is also read from client.ts — no second source of
// truth for any of those values.
//
// Run from repo root:
//   node --env-file=.env apps/worker/evals/run-drafter-eval.mjs                 # live pass, then caches
//   node --env-file=.env apps/worker/evals/run-drafter-eval.mjs --drafter=broken # calibration: must FAIL
//   node apps/worker/evals/run-drafter-eval.mjs --cached-only                   # CI: replay only, never calls the API

import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const PROMPT_PATH = join(WORKER_ROOT, 'prompts', 'drafter.md');
const CLIENT_PATH = join(WORKER_ROOT, 'src', 'anthropic', 'client.ts');
const FIXTURE_DIR = join(HERE, 'fixtures', 'drafter');
const CACHE_DIR = join(HERE, 'cache');

// List prices (USD per 1M tokens). Source: Anthropic pricing, claude-api skill.
// Sonnet = drafter; Haiku = judge.
const PRICE = {
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 1.0, output: 5.0 },
};

// Gate thresholds.
const JUDGE_MIN = 4; // tone/appropriateness on a 1–5 scale
const PLACEHOLDER_PATTERNS = [
  /\[[A-Z][A-Z _]*\]/, // [NAME], [DATE], [CHILD NAME]
  /\{\{[^}]*\}\}/, // {{name}}
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\bXXX\b/,
  /\bplaceholder\b/i,
  /\blorem ipsum\b/i,
  /<[a-z_]+>/i, // <name>, <date>
];

// --- read the single sources of truth from worker source -------------------

async function readModelIds() {
  const src = await readFile(CLIENT_PATH, 'utf8');
  const sonnet = src.match(/SONNET_MODEL\s*=\s*'([^']+)'/);
  const haiku = src.match(/HAIKU_MODEL\s*=\s*'([^']+)'/);
  if (!sonnet) throw new Error(`could not parse SONNET_MODEL from ${CLIENT_PATH}`);
  if (!haiku) throw new Error(`could not parse HAIKU_MODEL from ${CLIENT_PATH}`);
  return { drafter: sonnet[1], judge: haiku[1] };
}

// The tool-forced JSON schema MUST mirror drafterOutputJsonSchema in
// src/agents/drafter.ts.
const DRAFTER_TOOL = 'draft_action';
const DRAFTER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    payload: { type: 'object', additionalProperties: true },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    recipient_visibility: { type: 'string', enum: ['public', 'internal_only'] },
  },
  required: ['payload', 'confidence', 'rationale', 'recipient_visibility'],
};

// --- fixtures ---------------------------------------------------------------

async function loadFixtures(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) {
    out.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
  }
  return out;
}

// Must match runDrafter's exact serialization:
// { action_type, event, memory_slice, voice_profile, action_template_hint }.
function userMessageFor(fixture) {
  return JSON.stringify({
    action_type: fixture.input.actionType,
    event: fixture.input.event,
    memory_slice: fixture.input.memorySlice ?? null,
    voice_profile: fixture.input.voiceProfile ?? null,
    action_template_hint: fixture.input.actionTemplateHint ?? null,
  });
}

// --- content-addressed cache ------------------------------------------------
// Key = sha256(model + "\n" + prompt + "\n" + userMessage + "\n" + tag). Any
// change to the model id, the prompt, or a fixture input mints a new key, so a
// stale answer is never silently reused. `tag` separates draft vs judge calls.

function cacheKey(model, prompt, userMessage, tag) {
  return createHash('sha256')
    .update(`${model}\n${prompt}\n${userMessage}\n${tag}`)
    .digest('hex');
}

async function cacheGet(key) {
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, 'utf8'));
}

async function cachePut(key, value) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify(value, null, 2));
}

// --- the real drafter path (replicated forceToolJson) -----------------------

function makeRealDrafter(model, prompt, cachedOnly, cost) {
  let client;
  return async function draft(fixture) {
    const userMessage = userMessageFor(fixture);
    const key = cacheKey(model, prompt, userMessage, 'draft');

    const cached = await cacheGet(key);
    if (cached) return cached.parsed;

    if (cachedOnly) {
      console.error(
        `cache miss in --cached-only mode: ${fixture.id} (key ${key}). Re-run without --cached-only against the live model to populate the cache, then commit it.`,
      );
      process.exit(1);
    }

    client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: prompt,
      tools: [
        {
          name: DRAFTER_TOOL,
          description: 'Return the structured draft of the proposed action.',
          input_schema: DRAFTER_JSON_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: DRAFTER_TOOL },
      messages: [{ role: 'user', content: userMessage }],
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === DRAFTER_TOOL);
    if (!toolUse) throw new Error(`${fixture.id}: model returned no ${DRAFTER_TOOL} tool call`);

    cost.liveCalls += 1;
    cost.sonnetIn += response.usage.input_tokens;
    cost.sonnetOut += response.usage.output_tokens;
    await cachePut(key, { parsed: toolUse.input });
    return toolUse.input;
  };
}

// Deliberately broken stand-in for calibration: a placeholder-laden, oversized,
// off-tone, recipient-dropping draft that must drive the gate to FAIL. Makes no
// API call and reads no cache, so it can never accidentally pass.
function makeBrokenDrafter() {
  const filler =
    "As Hale's AI assistant, I am pleased to inform you that {{appointment_date}} is confirmed. ".repeat(
      12,
    );
  const garbage = `Dear [NAME], TODO write the actual reply here. ${filler}`;
  return async function draft() {
    return {
      payload: { subject: 'RE: [SUBJECT]', body: garbage },
      confidence: 0.99,
      rationale: 'constant broken stand-in',
      recipient_visibility: 'public',
    };
  };
}

// --- LLM-as-judge (cached, real haiku) --------------------------------------

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring a single drafted message a parent-assistant',
  'product would send on a parent\'s behalf to a clinic, daycare, family member, or',
  'an internal daily digest. Score TONE & APPROPRIATENESS on a 1–5 integer scale:',
  '5 = warm, natural, first-person from the parent, appropriate to the recipient;',
  '1 = robotic, corporate, performs emotion, refers to itself as an AI, or is wrong',
  'for the context. Reply with ONLY a JSON object via the score tool.',
].join(' ');

const JUDGE_TOOL = 'score';
const JUDGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 5 },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
};

function makeJudge(model, cachedOnly, cost) {
  let client;
  return async function judge(fixture, draftText) {
    const userMessage = JSON.stringify({
      context: fixture.note,
      action_type: fixture.input.actionType,
      draft: draftText,
    });
    const key = cacheKey(model, JUDGE_SYSTEM, userMessage, 'judge');

    const cached = await cacheGet(key);
    if (cached) return cached.parsed;

    if (cachedOnly) {
      console.error(
        `judge cache miss in --cached-only mode: ${fixture.id} (key ${key}). Re-run live to populate, then commit the cache.`,
      );
      process.exit(1);
    }

    client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model,
      max_tokens: 256,
      system: JUDGE_SYSTEM,
      tools: [
        { name: JUDGE_TOOL, description: 'Return the tone score.', input_schema: JUDGE_JSON_SCHEMA },
      ],
      tool_choice: { type: 'tool', name: JUDGE_TOOL },
      messages: [{ role: 'user', content: userMessage }],
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === JUDGE_TOOL);
    if (!toolUse) throw new Error(`${fixture.id}: judge returned no ${JUDGE_TOOL} tool call`);

    cost.liveCalls += 1;
    cost.haikuIn += response.usage.input_tokens;
    cost.haikuOut += response.usage.output_tokens;
    await cachePut(key, { parsed: toolUse.input });
    return toolUse.input;
  };
}

// --- deterministic checks ---------------------------------------------------

// The reader-facing text of a draft. Email drafts use subject + body; digest
// entries use an open, nested shape (the drafter chooses field names per the
// open payload schema), so we fall back to gathering every string value in the
// payload, recursively. This is what the placeholder/length/grounding/tone
// checks all see, regardless of the per-action-type payload shape.
function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
}

function draftText(payload) {
  if (typeof payload.subject === 'string' || typeof payload.body === 'string') {
    const parts = [];
    if (typeof payload.subject === 'string') parts.push(payload.subject);
    if (typeof payload.body === 'string') parts.push(payload.body);
    return parts.join('\n');
  }
  const all = [];
  collectStrings(payload, all);
  return all.join('\n');
}

// "Specifics" a draft must not invent: email addresses, dollar amounts, and
// long digit runs (dates/phones/record numbers). Each such token in the draft
// must appear verbatim in the serialized input — a cheap grounding check that
// catches a hallucinated recipient, price, or date without needing per-fixture
// anchors.
function ungroundedSpecifics(text, inputSerialized) {
  const tokens = [
    ...(text.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []),
    ...(text.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? []),
    ...(text.match(/\d{4,}/g) ?? []),
  ];
  return [...new Set(tokens)].filter((t) => !inputSerialized.includes(t));
}

function checkFixture(fixture, payload, judgeScore) {
  const failures = [];
  const text = draftText(payload);
  const inputSerialized = JSON.stringify(fixture.input);
  const e = fixture.expect;

  for (const field of e.requiredPayloadFields ?? []) {
    const v = payload[field];
    if (typeof v !== 'string' || v.trim().length === 0) {
      failures.push(`missing/empty required field '${field}'`);
    }
  }

  // For action types with an open, nested payload (e.g. add_to_digest_only),
  // assert the draft carries SOME reader-facing text without dictating the
  // field name — the genuine property is "a human can read this", not a schema.
  if (e.requireNonEmptyText && text.trim().length === 0) {
    failures.push('payload carries no reader-facing text');
  }

  for (const pat of PLACEHOLDER_PATTERNS) {
    const m = text.match(pat);
    if (m) failures.push(`placeholder token: ${JSON.stringify(m[0])}`);
  }

  if (typeof e.maxBodyChars === 'number' && text.length > e.maxBodyChars) {
    failures.push(`length ${text.length} > maxBodyChars ${e.maxBodyChars}`);
  }

  if (e.recipientEchoOf) {
    const recipient = fixture.input.event.payload[e.recipientEchoOf];
    const to = typeof payload.to === 'string' ? payload.to : '';
    if (typeof recipient === 'string' && recipient && !to.includes(recipient)) {
      failures.push(`recipient '${recipient}' not echoed in to='${to}'`);
    }
  }

  const ungrounded = ungroundedSpecifics(text, inputSerialized);
  if (ungrounded.length) failures.push(`ungrounded specifics: ${ungrounded.join(', ')}`);

  // The LLM-as-judge scores TONE, which only applies to outbound prose a person
  // reads (the email-type actions). add_to_digest_only emits internal structured
  // data, not a message, so a recipient-tone rubric is a category error there —
  // those fixtures set judgeTone:false and rely on the deterministic battery
  // (placeholder-free, grounded, bounded, non-empty). judgeScore is null for them.
  if (judgeScore !== null && !(judgeScore >= JUDGE_MIN)) {
    failures.push(`tone score ${judgeScore} < ${JUDGE_MIN}`);
  }

  return failures;
}

// --- main -------------------------------------------------------------------

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--drafter='));
  const mode = arg ? arg.split('=')[1] : 'real';
  const cachedOnly = process.argv.includes('--cached-only');

  const { drafter: drafterModel, judge: judgeModel } = await readModelIds();
  const prompt = await readFile(PROMPT_PATH, 'utf8');
  const fixtures = await loadFixtures(FIXTURE_DIR);

  const cost = { liveCalls: 0, sonnetIn: 0, sonnetOut: 0, haikuIn: 0, haikuOut: 0 };
  const draft =
    mode === 'broken' ? makeBrokenDrafter() : makeRealDrafter(drafterModel, prompt, cachedOnly, cost);
  const judge = makeJudge(judgeModel, cachedOnly, cost);

  console.log(
    `drafter-eval | mode=${mode}${cachedOnly ? ' (cached-only)' : ''} | drafter=${drafterModel} | judge=${judgeModel}`,
  );
  console.log(`fixtures: ${fixtures.length} | judge_min=${JUDGE_MIN} | cache: evals/cache/`);
  console.log('');

  const failedFixtures = [];
  for (const fixture of fixtures) {
    const result = await draft(fixture);
    const payload = result.payload ?? {};
    const text = draftText(payload);
    // Tone is judged only for outbound prose (judgeTone, default true). Internal
    // digest entries opt out (see checkFixture). Broken mode is a pure
    // deterministic calibration — its placeholder-laden, oversized, ungrounded
    // text already fails, so we never spend a live judge call there.
    const judgeTone = fixture.expect.judgeTone !== false;
    const score = mode === 'broken' || !judgeTone ? null : (await judge(fixture, text)).score;
    const failures = checkFixture(fixture, payload, score);
    if (failures.length) {
      failedFixtures.push({ id: fixture.id, failures });
      console.log(`  FAIL ${fixture.id}`);
      for (const f of failures) console.log(`       - ${f}`);
    } else {
      console.log(`  pass ${fixture.id}${score === null ? '' : ` (tone ${score})`}`);
    }
  }

  const estUsd =
    (cost.sonnetIn / 1e6) * PRICE.sonnet.input +
    (cost.sonnetOut / 1e6) * PRICE.sonnet.output +
    (cost.haikuIn / 1e6) * PRICE.haiku.input +
    (cost.haikuOut / 1e6) * PRICE.haiku.output;

  console.log('');
  console.log('--- cost ---');
  console.log(`live API calls this run: ${cost.liveCalls}`);
  console.log(
    `tokens: sonnet in=${cost.sonnetIn} out=${cost.sonnetOut} | haiku in=${cost.haikuIn} out=${cost.haikuOut}`,
  );
  console.log(`estimated cost this run: $${estUsd.toFixed(4)} USD`);

  // Calibration contract: the REAL (cached) model must pass every fixture; the
  // BROKEN stand-in must fail at least one (it fails all, by construction).
  const allPass = failedFixtures.length === 0;
  const expectPass = mode !== 'broken';

  console.log('');
  console.log('--- gate ---');
  console.log(`fixtures failing checks: ${failedFixtures.length}/${fixtures.length}`);
  if (expectPass) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  } else {
    // In broken mode, FAILING is the success condition — calibration proves the
    // gate has teeth. Exit 0 iff the broken drafter was correctly rejected.
    const calibrated = !allPass;
    console.log(
      `broken-mode calibration (must fail at least one): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
    );
    process.exit(calibrated ? 0 : 1);
  }
}

main().catch((err) => {
  console.error('drafter eval harness error:', err);
  process.exit(2);
});
