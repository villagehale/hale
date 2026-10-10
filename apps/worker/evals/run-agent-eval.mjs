#!/usr/bin/env node
// Agent-skill QUALITY eval harness (week-summary, discovery).
//
// Root CLAUDE.md hard rule #8: no LLM mocking — real Claude responses, cached.
// The @hale/agent skills already have LOOP-MECHANICS tests (a fake client feeding
// a tool call back, the maxSteps stop). Those prove plumbing, NOT quality. This
// harness closes that gap: it exercises the REAL agent against real (cached) Claude
// and gates on CHECKABLE properties + a cached LLM-as-judge.
//
// Two suites, each calibrated in BOTH directions (real cached model PASSES; a
// --broken known-bad generator FAILS):
//
//   week-summary  — the weekly-plan composer's VOICE stage (VIL-229). Same REAL
//                   runAgent loop over the REAL week-summary skill, but the skill has
//                   NO tools: the already-composed, already-redacted week `items` ride
//                   in context and the model writes a JSON voice object (greeting/
//                   weekFraming/itemLines/signOff) around them. Gates: non-empty +
//                   length-bounded framing, no invented/alarming/health-beyond-title
//                   token, never opens with a hype phrase, no fabricated specific
//                   (email/$/long-digit) or invented time/link not grounded in an
//                   item, itemLines keyed to real item ids only, and a cached Haiku
//                   judge for calm & faithfulness (>= 4).
//
//   discovery     — web-side village discovery. REPLICATES the exact request shape of
//                   apps/web/lib/village/discover.ts (same prompt apps/worker/prompts/
//                   discovery.md, same SONNET_MODEL, same submit_candidates tool-forced
//                   schema + serialization) — the stale dist / cross-process boundary
//                   makes import impossible, same reasoning as the drafter eval. Gates:
//                   candidates fit the queried stage + area, NO precise-location leak
//                   (rule #1), calibrated confidence honesty, cached Haiku judge for
//                   local-fit (>= 4).
//
// IMPORT vs REPLICATE (same discipline as run-village-eval.mjs):
//   - week-summary: we IMPORT the real runAgent + loadSkill
//     from packages/agent/src via the tsx loader (the way `tsx watch` runs the
//     worker) — so the eval drives the genuine loop + genuine skill instructions,
//     not a re-implementation. The model id comes from the skill's own pickModel
//     (single source: packages/agent/src/model.ts), exactly as the live agents do.
//   - discovery: we REPLICATE the discover.ts request shape (it reaches web-only
//     modules across the process boundary; its model id is read from the worker's
//     SONNET_MODEL, the same constant discover.ts's loadCoachModel reads).
//   - judge: HAIKU_MODEL, read live from src/anthropic/client.ts — no second copy.
//
// Run from the worker package dir (apps/worker), like the other eval scripts:
//   node --env-file=../../.env evals/run-agent-eval.mjs                 # live pass, then caches
//   node --env-file=../../.env evals/run-agent-eval.mjs --broken        # calibration: must FAIL
//   node evals/run-agent-eval.mjs --cached-only                         # CI: replay only, never calls the API
//   node evals/run-agent-eval.mjs --suite=week-summary [...]            # restrict to one suite

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { tsImport } from 'tsx/esm/api';
import { z } from 'zod';
import { evalRunTag, evalSubjectClient, evalSubjectRequest, noteLatency } from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const REPO_ROOT = join(WORKER_ROOT, '..', '..');
const MODEL_TS_PATH = join(REPO_ROOT, 'packages', 'agent', 'src', 'model.ts');
const DISCOVERY_PROMPT_PATH = join(WORKER_ROOT, 'prompts', 'discovery.md');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS_DIR = join(REPO_ROOT, 'packages', 'agent', 'skills');
const FIXTURE_ROOT = join(HERE, 'fixtures');
const CACHE_DIR = join(HERE, 'cache');

// List prices (USD per 1M tokens). Source: Anthropic pricing, claude-api skill.
const PRICE = {
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 1.0, output: 5.0 },
  gateway: { input: 0.15, output: 0.6 },
};

const JUDGE_MIN = 4; // 1-5 integer scale, the same bar the other agent evals use

// --- single sources of truth -----------------------------------------------

async function readModelIds() {
  const src = await readFile(MODEL_TS_PATH, 'utf8');
  const sonnet = src.match(/SONNET_MODEL\s*=\s*'([^']+)'/);
  const haiku = src.match(/HAIKU_MODEL\s*=\s*'([^']+)'/);
  if (!sonnet) throw new Error(`could not parse SONNET_MODEL from ${MODEL_TS_PATH}`);
  if (!haiku) throw new Error(`could not parse HAIKU_MODEL from ${MODEL_TS_PATH}`);
  return { discovery: sonnet[1], judge: haiku[1] };
}

async function loadFixtures(dirName) {
  const dir = join(FIXTURE_ROOT, dirName);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) {
    out.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
  }
  return out;
}

// --- content-addressed cache ------------------------------------------------
// Key = sha256(tag + "\n" + canonical request). Any change to the model id, the
// prompt/skill, or a fixture input mints a new key, so a stale answer is never
// silently reused; a cache hit makes zero API calls. `tag` separates the suites'
// generator calls from the judge calls.

function cacheKey(tag, payload) {
  return createHash('sha256').update(`${tag}\n${payload}`).digest('hex');
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

// A real Anthropic client created lazily, only when a cache miss forces a live
// call. In --cached-only mode it is never constructed and no key is read.
function lazyAnthropic() {
  let client;
  return () => {
    client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
  };
}

function noteUsage(cost, tier, usage) {
  cost.liveCalls += 1;
  if (tier === 'sonnet') {
    cost.sonnetIn += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
    cost.sonnetOut += usage.output_tokens;
  } else if (tier === 'haiku') {
    cost.haikuIn += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
    cost.haikuOut += usage.output_tokens;
  } else {
    cost.gatewayIn += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
    cost.gatewayOut += usage.output_tokens;
  }
}

// --- cached client for the REAL runAgent loop -------------------------------
// runAgent calls client.messages.create repeatedly (the tool loop). We wrap a
// cache around create(): the key is the canonical (model + system + messages),
// so each round-trip of a deterministic, fixture-driven loop replays exactly.
// On a miss in --cached-only mode we fail loudly rather than silently call live.

function makeCachedAgentClient(tag, cachedOnly, getClient, cost) {
  return {
    messages: {
      async create(params) {
        const request = evalSubjectRequest(params);
        const canonical = JSON.stringify({
          model: request.model,
          system: request.system,
          tools: request.tools,
          messages: request.messages,
          max_tokens: request.max_tokens,
          ...(process.env.EVAL_GATEWAY_MODEL ? { thinking: request.thinking } : {}),
        });
        const key = cacheKey(evalRunTag(`${tag}:agent`), canonical);

        const cached = await cacheGet(key);
        if (cached) return cached.response;

        if (cachedOnly) {
          console.error(
            `agent cache miss in --cached-only mode (${tag}, key ${key}). Re-run live to populate, then commit the cache.`,
          );
          process.exit(1);
        }

        const startedAt = performance.now();
        const response = await evalSubjectClient(getClient).messages.create(request);
        noteLatency(request.model, Math.round(performance.now() - startedAt));
        noteUsage(cost, process.env.EVAL_GATEWAY_MODEL ? 'gateway' : 'sonnet', response.usage);
        // Store the raw SDK message shape runAgent consumes (content + usage +
        // stop_reason). We persist a plain object so JSON round-trips losslessly.
        const stored = {
          id: response.id,
          type: response.type,
          role: response.role,
          model: response.model,
          stop_reason: response.stop_reason,
          stop_sequence: response.stop_sequence,
          content: response.content,
          usage: response.usage,
        };
        await cachePut(key, { response: stored });
        return stored;
      },
    },
  };
}

// --- guard deps for the REAL invoker (rules genuinely fire in the eval) ------
// The eval dispatches every fixture tool through the real invokeTool, so we wire
// real-shaped guards: writeAudit records each call (rule #6 — we assert >=1), and
// checkChildContentAccess refuses a teenager's profile exactly as the live web
// guard does (rule #1/#5) so a model that asks for teen content is blocked here too.

function makeGuardDeps(auditLog, teenChildIds) {
  return {
    async writeAudit(entry) {
      auditLog.push(entry);
    },
    async checkChildContentAccess(_familyId, _toolName, input) {
      const childId = input && typeof input === 'object' ? input.childId : undefined;
      if (childId && teenChildIds.has(childId)) {
        return { ok: false, reason: `teen child ${childId} content is redacted (rule #1)` };
      }
      return { ok: true, reason: 'ok' };
    },
  };
}

// --- LLM-as-judge (cached, real haiku) --------------------------------------

const JUDGE_TOOL = 'score';
const JUDGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 5 },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
};

function makeJudge(model, judgeSystem, tag, cachedOnly, getClient, cost) {
  return async function judge(payload) {
    const userMessage = JSON.stringify(payload);
    const key = cacheKey(`${tag}:judge`, `${model}\n${judgeSystem}\n${userMessage}`);

    const cached = await cacheGet(key);
    if (cached) return cached.parsed;

    if (cachedOnly) {
      console.error(
        `judge cache miss in --cached-only mode (${tag}, key ${key}). Re-run live to populate, then commit the cache.`,
      );
      process.exit(1);
    }

    const response = await getClient().messages.create({
      model,
      max_tokens: 256,
      system: judgeSystem,
      tools: [
        { name: JUDGE_TOOL, description: 'Return the score.', input_schema: JUDGE_JSON_SCHEMA },
      ],
      tool_choice: { type: 'tool', name: JUDGE_TOOL },
      messages: [{ role: 'user', content: userMessage }],
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === JUDGE_TOOL);
    if (!toolUse) throw new Error(`judge (${tag}) returned no ${JUDGE_TOOL} tool call`);
    noteUsage(cost, 'haiku', response.usage);
    await cachePut(key, { parsed: toolUse.input });
    return toolUse.input;
  };
}

// --- shared hallucination check ---------------------------------------------
// An email / dollar / long-digit token that appears in the answer but NOT in any
// of the grounded strings the tools/fixture handed the agent is a fabricated
// specific. Cheap, deterministic, high-signal.

function ungroundedSpecifics(text, grounded) {
  const hay = grounded.join(' ');
  const tokens = [
    ...(text.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []),
    ...(text.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? []),
    ...(text.match(/\d{4,}/g) ?? []),
  ];
  return [...new Set(tokens)].filter((t) => !hay.includes(t));
}

function containsAny(haystackLower, tokens) {
  return (tokens ?? []).filter((t) => haystackLower.includes(t.toLowerCase()));
}

// --- voice-object parse + invented-fact lint (VIL-229) ----------------------
// The voice skills answer with a single JSON object of voice fields. We replicate
// the first-balanced-object extraction + the facts lint (times/URLs not grounded in
// the injected slots) the web composer runs — same discipline as the discovery
// replicate: the web modules are cross-process, so the eval mirrors the contract.

function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseVoiceObject(answer) {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Times/URLs in `text` not present in any grounded slot — the invented-fact guard. */
function inventedTimesUrls(text, grounded) {
  const hay = grounded.join(' ');
  const toks = [
    ...(text.match(/\b\d{1,2}:\d{2}\b/g) ?? []),
    ...(text.match(/https?:\/\/\S+/g) ?? []).map((u) => u.replace(/[).,;:!?'"]+$/, '')),
  ];
  return [...new Set(toks)].filter((t) => !hay.includes(t));
}

// ===========================================================================
// SUITE 4: week-summary (real runAgent loop, real skill, NO tools)
// ===========================================================================
// The weekly-plan composer's VOICE stage (VIL-229). The skill has NO tools:
// the already-composed, already-redacted week `items` ride in
// context, and the model writes a JSON voice object (greeting/weekFraming/itemLines/
// signOff) around them. So the eval drives the REAL runAgent loop over the REAL
// week-summary.md skill with an empty tools array (and real guard deps — they never
// fire without a tool call, but keep the eval path identical
// to prod), then parses + validates the answer the SAME way composeVoice does
// (firstJsonObject + a strict schema) before checking it.

const weekVoiceSchema = z
  .object({
    greeting: z.string(),
    weekFraming: z.string(),
    itemLines: z.record(z.string()).default({}),
    signOff: z.string(),
  })
  .strict();

const WEEK_SUMMARY_JUDGE_SYSTEM = [
  'You are a strict reviewer scoring the VOICE object (greeting, weekFraming,',
  "itemLines, signOff) Hale wrote to sit atop a family's already-composed upcoming-",
  'week plan. Score CALM & FAITHFULNESS on a 1-5 integer scale. A 5 is warm, calm,',
  'written in ordinary SENTENCE CASE (every sentence starting with a capital, the',
  'greeting and sign-off included — a lowercase dialect is a different voice from the',
  'one every other Hale surface writes in, and it is marked down here), keeps',
  'weekFraming to one/two sentences naming only the one or',
  'two most notable SUPPLIED items, any itemLines are brief framings (never restating',
  'a time/date), and — on an empty item list — weekFraming simply says the week is',
  'quiet. A LOW score is alarming or cold tone, opening with "Great news!"/"Exciting!",',
  'a wall of text, OR — most important — any claim NOT supported by the supplied items',
  '(an invented appointment, name, date, or time) or health detail beyond an item',
  'title (a diagnosis, a dose, a named clinic). Reply with ONLY the score tool.',
].join(' ');

// Never open with a hype phrase — the skill's explicit "Never open with 'Great
// news!', 'Exciting!'" voice rule. Anchored to the start so a mid-sentence mention
// is not a false positive.
const BANNED_SUMMARY_OPENER = /^\s*(great news|exciting)\b/i;

// Deterministic broken stand-in: opens with the banned "Great news!", invents an
// appointment (a child, clinic, therapy, phone, and price none of which are in any
// fixture's items), invents a time + link in the sign-off, and pads well past one/two
// sentences. Every deterministic check (opener, forbidden token, ungrounded specific,
// invented-fact lint, length) must reject it — no API call, no cache read.
function brokenWeekVoiceAnswer() {
  return {
    greeting: 'Great news!',
    weekFraming: [
      "huge week ahead — don't forget kai's dentist appointment on 2026-08-15 at",
      "bright smiles clinic, plus rowan's therapy session; call 4165559999 to confirm and budget about $80.",
      'here is a very long extra clause padding this summary well past one or two calm sentences so the length bound is clearly exceeded; '.repeat(
        4,
      ),
    ].join(' '),
    itemLines: {},
    signOff: 'see you at 9:15 sharp — https://evil.example.com/click',
  };
}

function checkWeekVoice(fixture, voice, judgeScore) {
  const failures = [];
  if (!voice) {
    failures.push('voice object failed to parse/validate against the strict schema');
    return failures;
  }
  const e = fixture.expect;
  const { greeting, weekFraming, itemLines, signOff } = voice;

  for (const [field, value] of [
    ['greeting', greeting],
    ['weekFraming', weekFraming],
    ['signOff', signOff],
  ]) {
    if (typeof value !== 'string' || value.trim().length === 0) failures.push(`empty ${field}`);
  }

  // Length bound on the narrative sentence: one/two calm sentences, never a wall of text.
  if (typeof e.maxChars === 'number' && weekFraming.length > e.maxChars) {
    failures.push(
      `weekFraming ${weekFraming.length} chars > maxChars ${e.maxChars} (not one/two sentences)`,
    );
  }

  const allText = [greeting, weekFraming, signOff, ...Object.values(itemLines ?? {})].join(' ');
  const lower = allText.toLowerCase();

  // No invented / alarming / health-beyond-title tokens, anywhere in the voice.
  for (const tok of containsAny(lower, e.forbiddenTokens)) {
    failures.push(`forbidden content: ${JSON.stringify(tok)}`);
  }

  // Calm voice: never open with a hype phrase.
  if (
    e.mustStayCalm &&
    (BANNED_SUMMARY_OPENER.test(greeting) || BANNED_SUMMARY_OPENER.test(weekFraming))
  ) {
    failures.push(`banned hype opener: ${JSON.stringify((greeting || weekFraming).slice(0, 24))}`);
  }

  // Sentence case, held mechanically. The judge used to be told a 5 was
  // "lowercase-friendly", which sanctioned by rubric the one Hale surface with its own
  // typography (2026-08-13 tone audit) — so this is checked rather than graded, the way
  // every other decidable voice property in this battery is.
  for (const [field, value] of [
    ['greeting', greeting],
    ['weekFraming', weekFraming],
    ['signOff', signOff],
  ]) {
    const first = String(value).trim().charAt(0);
    if (first !== '' && first === first.toLowerCase() && first !== first.toUpperCase()) {
      failures.push(`${field} opens lower case: ${JSON.stringify(String(value).slice(0, 32))}`);
    }
  }

  // No fabricated specifics: any email / $ / long-digit token must be grounded in an
  // item title or date the skill was handed (it invents nothing — rule #1). With no
  // tools, the items ARE the entire grounding set.
  const grounded = (fixture.context.items ?? []).flatMap((i) => [i.title, i.when ?? '']);
  const ungrounded = ungroundedSpecifics(allText, grounded);
  if (ungrounded.length) failures.push(`ungrounded specifics: ${ungrounded.join(', ')}`);

  // The facts-lint every voice string carries in prod (composeVoice/findInventedFacts):
  // a clock time or URL not present in a grounded slot is a fabrication.
  const invented = inventedTimesUrls(allText, grounded);
  if (invented.length)
    failures.push(`invented time/url not grounded in any item: ${invented.join(', ')}`);

  // itemLines is keyed by the item's index (the id the composer hands the model) — a
  // key outside that range means the model invented an item.
  const validIds = new Set((fixture.context.items ?? []).map((_item, i) => String(i)));
  for (const key of Object.keys(itemLines ?? {})) {
    if (!validIds.has(key)) failures.push(`itemLines has unknown item id ${JSON.stringify(key)}`);
  }

  if (judgeScore !== null && !(judgeScore >= JUDGE_MIN)) {
    failures.push(`calm/faithfulness score ${judgeScore} < ${JUDGE_MIN}`);
  }
  return failures;
}

async function runWeekSummarySuite(opts) {
  const { agent, broken, cachedOnly, getClient, cost, judge } = opts;
  const fixtures = await loadFixtures('agent-week-summary');
  const skill = await agent.loadSkill(join(SKILLS_DIR, 'week-summary.md'));
  const results = [];

  console.log('--- week-summary (real runAgent loop, real skill, no tools) ---');
  for (const fixture of fixtures) {
    const auditLog = [];
    // Mirror the composer's weekVoiceContext: each item keyed by its index — the id
    // the model's itemLines answer is keyed by.
    const context = {
      items: (fixture.context.items ?? []).map((item, i) => ({ id: String(i), ...item })),
    };
    let voice;
    if (broken) {
      voice = brokenWeekVoiceAnswer();
    } else {
      const client = makeCachedAgentClient(
        `week-summary:${fixture.id}`,
        cachedOnly,
        getClient,
        cost,
      );
      const guardDeps = makeGuardDeps(auditLog, new Set());
      const run = await agent.runAgent({
        skill,
        context,
        tools: [],
        client,
        maxSteps: 1,
        maxTokens: 512,
        toolContext: { familyId: fixture.context.familyId, actor: 'system' },
        guardDeps,
      });
      if (run.answer === null) {
        results.push({ id: fixture.id, failures: ['agent returned no answer'] });
        console.log(`  FAIL ${fixture.id}\n       - agent returned no answer`);
        continue;
      }
      const raw = parseVoiceObject(run.answer);
      const parsed = raw ? weekVoiceSchema.safeParse(raw) : null;
      voice = parsed?.success ? parsed.data : null;
    }

    const score =
      broken || !voice ? null : (await judge(weekSummaryJudgePayload(fixture, voice))).score;
    const failures = checkWeekVoice(fixture, voice, score);
    record(results, fixture, failures, score);
  }
  return results;
}

function weekSummaryJudgePayload(fixture, voice) {
  return { items: fixture.context.items ?? [], voice };
}

// ===========================================================================
// SUITE 3: discovery (replicated discover.ts request shape)
// ===========================================================================

const DISCOVERY_TOOL = 'submit_candidates';
// MUST mirror candidatesJsonSchema in apps/web/lib/village/discover.ts.
const DISCOVERY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          sourceUrl: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          coverageNote: { type: 'string' },
        },
        required: ['title', 'description', 'confidence', 'coverageNote'],
      },
    },
  },
  required: ['candidates'],
};
const DISCOVERY_LIMIT = 8; // matches discover.ts DEFAULT_LIMIT

const DISCOVERY_JUDGE_SYSTEM = [
  "You are a strict reviewer scoring ONE list of local activity candidates Hale's",
  'discovery agent proposed for a child at a given family stage in a coarse area',
  '(an FSA / neighbourhood / municipality — never a precise address). Score LOCAL',
  'FIT & HONESTY on a 1-5 integer scale. A 5: every candidate suits the stage and',
  'is the kind of honest, broadly-true local option a thoughtful parent would',
  'recommend, with calibrated confidence (a generic "there is probably a library"',
  'is NOT asserted as a verified, scheduled class). A LOW score: candidates out of',
  'stage, fabricated specifics (made-up class times, prices, instructors), or',
  'over-confident filler. Reply with ONLY the score tool.',
].join(' ');

function discoveryUserMessageFor(fixture) {
  // MUST match discoverForFamily's serialization in discover.ts.
  return JSON.stringify({
    area_coarse: fixture.input.areaCoarse,
    stage: fixture.input.stage,
    interests: fixture.input.interests,
    limit: DISCOVERY_LIMIT,
  });
}

async function realDiscovery(model, prompt, fixture, cachedOnly, getClient, cost) {
  const userMessage = discoveryUserMessageFor(fixture);
  const key = cacheKey('discovery:agent', `${model}\n${prompt}\n${userMessage}`);

  const cached = await cacheGet(key);
  if (cached) return cached.parsed;

  if (cachedOnly) {
    console.error(
      `discovery cache miss in --cached-only mode: ${fixture.id} (key ${key}). Re-run live to populate, then commit the cache.`,
    );
    process.exit(1);
  }

  const response = await getClient().messages.create({
    model,
    max_tokens: 4096,
    system: prompt,
    tools: [
      {
        name: DISCOVERY_TOOL,
        description: 'Return the structured local activity candidates.',
        input_schema: DISCOVERY_JSON_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: DISCOVERY_TOOL },
    messages: [{ role: 'user', content: userMessage }],
  });
  const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === DISCOVERY_TOOL);
  if (!toolUse) throw new Error(`${fixture.id}: model returned no ${DISCOVERY_TOOL} tool call`);
  noteUsage(cost, 'sonnet', response.usage);
  await cachePut(key, { parsed: toolUse.input });
  return toolUse.input;
}

// Deterministic broken stand-in: an out-of-stage candidate, fabricated specifics
// (a precise street address + phone + price), an over-confident generic. Every
// deterministic check must reject it. No API call, no cache read.
function brokenDiscovery() {
  return {
    candidates: [
      {
        title: 'Teen driver-prep bootcamp',
        description: 'Driving lessons every Tuesday 6pm at 123 Main Street, call 4165550000, $499.',
        confidence: 0.99,
        coverageNote: 'definitely happening',
      },
    ],
  };
}

function checkDiscovery(fixture, parsed, judgeScore) {
  const failures = [];
  const e = fixture.expect;
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

  if (candidates.length === 0) {
    // An empty list is honest IF the fixture allows it; otherwise it's a miss.
    if (!e.allowEmpty) failures.push('no candidates returned');
    return failures;
  }
  if (candidates.length > DISCOVERY_LIMIT) {
    failures.push(`returned ${candidates.length} candidates > limit ${DISCOVERY_LIMIT}`);
  }

  const blob = candidates
    .map((c) => `${c.title} ${c.description} ${c.coverageNote ?? ''}`)
    .join(' ');
  const lowerBlob = blob.toLowerCase();

  // Stage fit: no wrong-stage vocabulary anywhere in the list.
  for (const tok of containsAny(lowerBlob, e.forbiddenStageTokens)) {
    failures.push(`wrong-stage token for ${fixture.input.stage}: ${JSON.stringify(tok)}`);
  }

  // Privacy (rule #1): no precise-location leak. A street address, a 5/6-char
  // Canadian full postal code (vs the coarse FSA prefix), or any forbidden
  // location token fabricates/pinpoints a finer location than the coarse area.
  const streetAddr = blob.match(
    /\b\d{1,5}\s+[A-Z][A-Za-z]+\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Way|Cres|Crescent)\b/,
  );
  if (streetAddr) failures.push(`precise street address leaked (rule #1): ${streetAddr[0]}`);
  const fullPostal = blob.match(/\b[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d\b/);
  if (fullPostal) failures.push(`full postal code leaked (rule #1): ${fullPostal[0]}`);
  for (const tok of containsAny(lowerBlob, e.forbiddenLocationTokens)) {
    failures.push(`forbidden precise-location token (rule #1): ${JSON.stringify(tok)}`);
  }

  // Calibrated honesty: discover.ts has no per-candidate grounding URL/listing in
  // its input, so no candidate may assert near-certainty. Confidence must be a
  // valid probability and must not be pinned at 1 (over-confident filler), and at
  // least one candidate must be below the over-confidence ceiling (the list can't
  // be uniformly maxed out).
  for (const c of candidates) {
    if (!(typeof c.confidence === 'number' && c.confidence > 0 && c.confidence <= 1)) {
      failures.push(`candidate '${c.title}' confidence ${c.confidence} not a valid probability`);
    }
    if (c.confidence >= e.maxConfidence) {
      failures.push(
        `candidate '${c.title}' confidence ${c.confidence} >= ${e.maxConfidence} (over-confident; nothing here is grounded)`,
      );
    }
    if (typeof c.coverageNote !== 'string' || c.coverageNote.trim().length === 0) {
      failures.push(`candidate '${c.title}' has empty coverageNote (honesty contract)`);
    }
  }

  // No fabricated contact specifics: a phone-like or price token is ungrounded —
  // discover.ts gets NO listing, so any such specific is invented.
  const ungrounded = ungroundedSpecifics(blob, [discoveryUserMessageFor(fixture)]);
  if (ungrounded.length) failures.push(`ungrounded specifics: ${ungrounded.join(', ')}`);

  if (judgeScore !== null && !(judgeScore >= JUDGE_MIN)) {
    failures.push(`local-fit score ${judgeScore} < ${JUDGE_MIN}`);
  }
  return failures;
}

async function runDiscoverySuite(opts) {
  const { broken, cachedOnly, getClient, cost, judge, discoveryModel } = opts;
  const fixtures = await loadFixtures('agent-discovery');
  const prompt = await readFile(DISCOVERY_PROMPT_PATH, 'utf8');
  const results = [];

  console.log('--- discovery (replicated discover.ts request, cached) ---');
  for (const fixture of fixtures) {
    const parsed = broken
      ? brokenDiscovery()
      : await realDiscovery(discoveryModel, prompt, fixture, cachedOnly, getClient, cost);
    const score = broken ? null : (await judge(discoveryJudgePayload(fixture, parsed))).score;
    const failures = checkDiscovery(fixture, parsed, score);
    record(results, fixture, failures, score);
  }
  return results;
}

function discoveryJudgePayload(fixture, parsed) {
  return {
    area_coarse: fixture.input.areaCoarse,
    stage: fixture.input.stage,
    interests: fixture.input.interests,
    candidates: parsed.candidates ?? [],
  };
}

// --- shared result printing -------------------------------------------------

function record(results, fixture, failures, score) {
  if (failures.length) {
    results.push({ id: fixture.id, failures });
    console.log(`  FAIL ${fixture.id}`);
    for (const f of failures) console.log(`       - ${f}`);
  } else {
    results.push({ id: fixture.id, failures: [] });
    console.log(`  pass ${fixture.id}${score === null ? '' : ` (judge ${score})`}`);
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const suiteArg = process.argv.find((a) => a.startsWith('--suite='));
  const only = suiteArg ? suiteArg.split('=')[1] : null;

  const agent = await tsImport(AGENT_SRC, import.meta.url);

  const { discovery: discoveryModel, judge: judgeModel } = await readModelIds();
  const getClient = lazyAnthropic();
  const cost = {
    liveCalls: 0,
    sonnetIn: 0,
    sonnetOut: 0,
    haikuIn: 0,
    haikuOut: 0,
    gatewayIn: 0,
    gatewayOut: 0,
  };

  const weekSummaryJudge = makeJudge(
    judgeModel,
    WEEK_SUMMARY_JUDGE_SYSTEM,
    'week-summary',
    cachedOnly,
    getClient,
    cost,
  );
  const discoveryJudge = makeJudge(
    judgeModel,
    DISCOVERY_JUDGE_SYSTEM,
    'discovery',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `agent-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | discovery=${discoveryModel} | judge=${judgeModel}`,
  );
  console.log(`judge_min=${JUDGE_MIN} | cache: evals/cache/`);
  console.log('');

  const all = [];
  const suites = [
    [
      'week-summary',
      () =>
        runWeekSummarySuite({
          agent,
          broken,
          cachedOnly,
          getClient,
          cost,
          judge: weekSummaryJudge,
        }),
    ],
    [
      'discovery',
      () =>
        runDiscoverySuite({
          broken,
          cachedOnly,
          getClient,
          cost,
          judge: discoveryJudge,
          discoveryModel,
        }),
    ],
  ];

  let total = 0;
  for (const [name, run] of suites) {
    if (only && name !== only) continue;
    const results = await run();
    total += results.length;
    all.push(...results.filter((r) => r.failures.length));
    console.log('');
  }

  const estUsd =
    (cost.sonnetIn / 1e6) * PRICE.sonnet.input +
    (cost.sonnetOut / 1e6) * PRICE.sonnet.output +
    (cost.haikuIn / 1e6) * PRICE.haiku.input +
    (cost.haikuOut / 1e6) * PRICE.haiku.output +
    (cost.gatewayIn / 1e6) * PRICE.gateway.input +
    (cost.gatewayOut / 1e6) * PRICE.gateway.output;

  console.log('--- cost ---');
  console.log(`live API calls this run: ${cost.liveCalls}`);
  console.log(
    `tokens: sonnet in=${cost.sonnetIn} out=${cost.sonnetOut} | haiku in=${cost.haikuIn} out=${cost.haikuOut} | gateway in=${cost.gatewayIn} out=${cost.gatewayOut}`,
  );
  console.log(`estimated cost this run: $${estUsd.toFixed(4)} USD`);

  const allPass = all.length === 0;
  console.log('');
  console.log('--- gate ---');
  console.log(`fixtures failing checks: ${all.length}/${total}`);
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  // Broken mode: FAILING is the success condition — calibration proves teeth.
  const calibrated = !allPass;
  console.log(
    `broken-mode calibration (must fail at least one): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('agent eval harness error:', err);
  process.exit(2);
});
