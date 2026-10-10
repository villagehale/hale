#!/usr/bin/env node
// Memory WRITEBACK eval (MEM-12) — "a fact stated at turn N is retrievable at
// turn N+1".
//
// Every other memory eval scores what the model EMITS. None of them proves the
// round trip: that what the coach chose to remember actually survives the write,
// the ranking, and the next turn's context assembly. That round trip is the whole
// promise of a memory layer, and it was the one thing nothing tested — which is
// how a fact select shipped with a LIMIT and no ORDER BY (MEM-1).
//
// IMPORT, don't replicate — the opposite call from run-memory-eval.mjs, and
// deliberately. That harness replicates the request shape because it is scoring a
// PROMPT. This one is scoring a PIPELINE, so a replica would be the bug's hiding
// place: an eval that re-implements the fact select cannot notice the real one is
// unordered. So it runs the REAL ask-hale skill through the REAL agent loop, over
// the REAL tools (guarded invoker included), against a REAL Postgres, and then
// reads back through the REAL loadAgentContext.
//
// The NIGHTLY arm runs the web-side memory inferencer (runInferenceForFamily, the
// live text surface's only memory writer) over a short synthetic transcript, and
// scores what it stored: every save names memoryClass and disposition, a settled
// routine is enduring, a declined activity is declined (never confirmed), and a
// passing question is curiosity.
//
// Rule #8: no LLM mocking. The agent loop talks to real Claude once per fixture,
// then replays from a content-addressed cache. A --cached-only miss FAILS LOUDLY.
//
// Run from repo root:
//   node --env-file=.env apps/worker/evals/run-memory-writeback-eval.mjs   # live, then caches
//   node apps/worker/evals/run-memory-writeback-eval.mjs --cached-only     # CI: replay only
//   node apps/worker/evals/run-memory-writeback-eval.mjs --broken          # calibration: model never saves; nightly saves unlabelled or mislabelled
//   node apps/worker/evals/run-memory-writeback-eval.mjs --unranked        # calibration: pre-MEM-1 select

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { register } from 'tsx/esm/api';
import { readMemoryLimits } from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const WEB_TSCONFIG = join(WEB_ROOT, 'tsconfig.json');
const CACHE_DIR = join(HERE, 'cache');
const FIXTURE_PATH = join(HERE, 'fixtures', 'memory-writeback', 'turns.json');
const NIGHTLY_FIXTURE_PATH = join(HERE, 'fixtures', 'memory-writeback', 'nightly.json');
const SAVE_TOOLS = new Set(['save_memory', 'save_child_fact']);

const PRICE = { input: 3.0, output: 15.0 }; // Sonnet list, USD per 1M tokens.

/** Caps for this writeback eval's own agent loop. */
const MAX_STEPS = 8;
const MAX_TOKENS = 1024;

/**
 * Filler facts seeded before the parent speaks. More than RELEVANT_FACT_LIMIT, so
 * the new fact has to EARN its place in the assembled context rather than fit
 * because the family is small. This is what makes the eval a MEM-1 gate.
 */
const DISTRACTOR_FACTS = 40;

/**
 * Register the TS loader ONCE, then use plain dynamic import. `tsImport()` — which
 * the older evals call per-module — installs a fresh ESM loader on every call, and
 * they stack: the fourth web module in never resolves. One registration, scoped to
 * the web tsconfig so the `~` alias the coach tools import through resolves.
 */
const unregisterTs = register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);
const importWeb = (rel) => importTs(join(WEB_ROOT, rel));

// --- content-addressed cache -------------------------------------------------

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Keys on the request with database-minted uuids masked out. `save_memory` returns
 * the id of the row it just wrote, that id rides back into the loop's next turn as
 * tool_result content, and Postgres mints a fresh one every run — so hashing the
 * raw request makes the second call of every conversation a permanent cache miss
 * and --cached-only unusable in CI. A row id carries nothing the model reasons
 * about; everything that DOES (the skill, the tool schemas, the assembled context,
 * the model id) is still hashed verbatim, and the fixtures pin their own family and
 * child ids so those are stable rather than masked.
 */
function cacheKey(payload) {
  return createHash('sha256').update(payload.replace(UUID_PATTERN, '<uuid>')).digest('hex');
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

/**
 * A real Anthropic client with a replay cache in front of `messages.create`. The
 * agent loop cannot tell the difference — which is the point: the loop, the tool
 * dispatch and the guards are all the production ones, and only the network hop is
 * replayed. Keyed on the ENTIRE request, so a changed skill, tool schema or model
 * id mints a new key instead of silently reusing a stale answer.
 */
function cachingClient({ cachedOnly, cost }) {
  let live;
  return {
    messages: {
      create: async (request) => {
        const canonical = JSON.stringify(request);
        const key = cacheKey(canonical);
        const cached = await cacheGet(key);
        if (cached) return cached.response;

        if (cachedOnly) {
          // The request is stored beside the response, so a miss can be diffed
          // against the entry it should have matched instead of guessed at.
          const dump = join(CACHE_DIR, 'MISS.json');
          await mkdir(CACHE_DIR, { recursive: true });
          await writeFile(dump, canonical);
          console.error(
            `cache miss in --cached-only mode (key ${key}). Request written to ${dump}. Re-run live (node --env-file=.env ...) to populate, then commit the cache.`,
          );
          process.exit(1);
        }

        live ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await live.messages.create(request);
        cost.liveCalls += 1;
        cost.input += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
        cost.output += response.usage.output_tokens;
        await cachePut(key, { request, response });
        return response;
      },
    },
  };
}

/**
 * Calibration arm: a client that answers warmly and never calls a tool. It is the
 * single most likely real-world failure — the coach says "got it, I'll remember"
 * and writes nothing — so the gate has to reject it. Makes no API call and reads no
 * cache, so it can never accidentally pass.
 */
function forgetfulClient() {
  return {
    messages: {
      create: async () => ({
        id: 'msg_forgetful',
        type: 'message',
        role: 'assistant',
        model: 'broken',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: "Got it — I'll remember that for you." }],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    },
  };
}

/**
 * Nightly calibration arm: the inferencer's omission habit and its mislabel, with no
 * API call. The routine is saved with no class at all, and the decline and the
 * question are both filed as confirmed identity. The gate must reject all three.
 */
function mislabelingNightlyClient(fixture) {
  const childId = fixture.children[0].id;
  let turn = 0;
  return {
    messages: {
      create: async () => {
        turn += 1;
        const usage = { input_tokens: 0, output_tokens: 0 };
        if (turn > 1) {
          return {
            id: 'msg_mislabel_done',
            type: 'message',
            role: 'assistant',
            model: 'broken',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Saved three facts.' }],
            usage,
          };
        }
        const save = (id, input) => ({ type: 'tool_use', id, name: 'save_child_fact', input });
        return {
          id: 'msg_mislabel',
          type: 'message',
          role: 'assistant',
          model: 'broken',
          stop_reason: 'tool_use',
          content: [
            save('toolu_nap', {
              childId,
              category: 'routines',
              factKey: 'nap_schedule',
              summary: 'one nap, 12:30 to 2:30',
              confidence: 0.95,
            }),
            save('toolu_hockey', {
              childId,
              category: 'preferences',
              factKey: 'hockey',
              summary: 'hockey this winter',
              confidence: 0.95,
              memoryClass: 'enduring',
              disposition: 'confirmed',
            }),
            save('toolu_music', {
              category: 'preferences',
              factKey: 'music_classes',
              summary: 'toddler music classes',
              confidence: 0.8,
              memoryClass: 'enduring',
              disposition: 'confirmed',
            }),
          ],
          usage,
        };
      },
    },
  };
}

/** Every tool_use the model emitted, as the loop received it, cached or live. */
function recordingClient(inner, calls) {
  return {
    messages: {
      create: async (request) => {
        const response = await inner.messages.create(request);
        for (const block of response.content) {
          if (block.type === 'tool_use') calls.push({ name: block.name, input: block.input });
        }
        return response;
      },
    },
  };
}

// --- the retrieval arm -------------------------------------------------------

/**
 * The pre-MEM-1 fact select, kept ONLY as the second calibration arm: capped, but
 * unordered and unscoped. Retrieval is the half of the round trip a writeback eval
 * exists to cover, so it needs its own broken stand-in — otherwise "the fact came
 * back" could be passing on a select that returns an arbitrary 30 rows.
 */
async function unrankedFacts(database, schema, drizzle, familyId, limit) {
  const { and, eq, isNull } = drizzle;
  return database
    .select({
      childId: schema.familyMemoryFacts.childId,
      factType: schema.familyMemoryFacts.factType,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      confidence: schema.familyMemoryFacts.confidence,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    )
    .limit(limit);
}

// --- scoring ------------------------------------------------------------------

/**
 * Did the fact survive? Deterministic, and derived from the FIXTURE's reference
 * terms rather than from whatever the model emitted (rule #7) — so this measures
 * recall of what the parent actually said, not self-consistency.
 */
function scoreRecall(facts, mustRecall) {
  const haystack = JSON.stringify(facts).toLowerCase();
  const hit = mustRecall.filter((term) => haystack.includes(term.toLowerCase()));
  return { hit, missed: mustRecall.filter((t) => !hit.includes(t)) };
}

function checkTurn(fixture, { savedFacts, retrieved }) {
  const failures = [];

  if (savedFacts.length === 0) {
    failures.push('the coach saved nothing — no fact was written for a fact the parent stated');
  }

  const { missed } = scoreRecall(retrieved, fixture.mustRecall);
  if (missed.length > 0) {
    failures.push(`not retrievable next turn — missing ${missed.map((m) => `"${m}"`).join(', ')}`);
  }

  // Provenance obligations MEM-2 put on every write. A fact that comes back but
  // carries no event time or a default confidence is a fact the ranking cannot order.
  for (const fact of savedFacts) {
    if (fact.validFrom === null || fact.validFrom === undefined) {
      failures.push(`fact '${fact.factKey}' has no valid_from`);
    }
    if (typeof fact.confidence !== 'number') {
      failures.push(`fact '${fact.factKey}' has no numeric confidence`);
    }
  }

  return failures;
}

// --- one fixture, end to end ---------------------------------------------------

async function runTurn({ fixture, mode, cachedOnly, cost, modules, factLimit }) {
  const { pglite, coachTools, coachSkill, coachGuards, context, agent, db, drizzle } = modules;

  const test = await pglite.createTestDb();
  try {
    // Ids come from the fixture, not the database's uuid default: the cache key is
    // the whole request, and the assembled context carries child ids — so a random
    // id would make every run a cache miss and --cached-only unusable in CI.
    const { familyId } = await pglite.seedFamily(
      test.database,
      fixture.familyName,
      fixture.familyId,
    );
    // The same clock dates the child and assembles context. A wall clock in
    // memoryBrief.asOf (or a DOB taken from "now" while context uses another
    // instant) makes the content-addressed cache miss on every run.
    const now = new Date(fixture.turnAt);
    for (const child of fixture.children ?? []) {
      await pglite.seedChild(
        test.database,
        familyId,
        child.name,
        child.ageMonths,
        child.id,
        now,
      );
    }

    // Crowd the memory so retrieval is a ranking problem, not a lookup: more
    // distractors than the fact cap, all at the confidence floor, so a correct
    // ranking prefers the freshly-stated fact and an unordered select buries it.
    //
    // They sort ahead of the new fact under BOTH orders an unordered select can
    // come back in, which is what gives the --unranked arm teeth. Heap order:
    // they are inserted first. Index order (Postgres serves this select from
    // `memory_facts_lookup_idx`, keyed on fact_type then fact_key): `preference`
    // is first in the fact-type enum, and the `0000_` prefix sorts below any key
    // the coach would choose. Without this the arm passed by luck — `routine`
    // happens to precede `logistic` in the enum, so the new fact landed inside
    // the window and the retrieval half of the round trip was never gated.
    await test.database.insert(db.schema.familyMemoryFacts).values(
      Array.from({ length: DISTRACTOR_FACTS }, (_, i) => ({
        familyId,
        childId: null,
        factType: 'preference',
        factKey: `0000_background_${String(i).padStart(3, '0')}`,
        factValue: { note: `unrelated background detail ${i}` },
        confidence: 0.7,
        validFrom: new Date(Date.UTC(2026, 0, 1 + i)),
      })),
    );

    // ---- TURN N: the parent states the fact, through the real agent loop ----
    const turnNContext = await context.loadAgentContext(
      {
        familyId,
        question: fixture.statement,
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      test.database,
      now,
    );

    const client = mode === 'broken' ? forgetfulClient() : cachingClient({ cachedOnly, cost });
    await agent.runAgent({
      skill: await coachSkill.loadAskHaleSkill(),
      context: turnNContext,
      tools: coachTools.buildAskHaleTools(test.database, new Date(fixture.turnAt)),
      client,
      maxSteps: MAX_STEPS,
      maxTokens: MAX_TOKENS,
      toolContext: { familyId, actor: 'eval-parent' },
      guardDeps: coachGuards.buildGuardDeps(test.database, 'eval-parent'),
    });

    const savedFacts = (
      await test.database
        .select()
        .from(db.schema.familyMemoryFacts)
        .where(drizzle.eq(db.schema.familyMemoryFacts.familyId, familyId))
    ).filter((f) => f.inferredBy === 'ask-hale');

    // ---- TURN N+1: a fresh assembly, the way the next message would see it ----
    const retrieved =
      mode === 'unranked'
        ? await unrankedFacts(test.database, db.schema, drizzle, familyId, factLimit)
        : (
            await context.loadAgentContext(
              {
                familyId,
                question: fixture.followUp,
                intent: null,
                focusedChildId: null,
                transcript: [],
                sourceNote: null,
              },
              test.database,
              now,
            )
          ).memoryFacts;

    return { savedFacts, retrieved };
  } finally {
    await test.close();
  }
}

// --- the nightly arm -----------------------------------------------------------

async function runNightly({ fixture, mode, cachedOnly, cost, modules }) {
  const { pglite, inference, db, drizzle } = modules;

  const test = await pglite.createTestDb();
  try {
    const { familyId } = await pglite.seedFamily(
      test.database,
      fixture.familyName,
      fixture.familyId,
    );
    const now = new Date(fixture.runAt);
    for (const child of fixture.children) {
      await pglite.seedChild(test.database, familyId, child.name, child.ageMonths, child.id, now);
    }

    const [conversation] = await test.database
      .insert(db.schema.conversations)
      .values({ familyId })
      .returning({ id: db.schema.conversations.id });
    // Explicit times: the read orders by created_at, and the request is the cache key.
    await test.database.insert(db.schema.messages).values(
      fixture.transcript.map((turn) => ({
        conversationId: conversation.id,
        role: turn.role,
        content: turn.content,
        childId: turn.childId ?? null,
        createdAt: new Date(now.getTime() - turn.minutesBefore * 60_000),
      })),
    );

    const calls = [];
    const inner =
      mode === 'broken' ? mislabelingNightlyClient(fixture) : cachingClient({ cachedOnly, cost });
    await inference.runInferenceForFamily(
      familyId,
      test.database,
      { client: recordingClient(inner, calls) },
      now,
    );

    const rows = (
      await test.database
        .select()
        .from(db.schema.familyMemoryFacts)
        .where(drizzle.eq(db.schema.familyMemoryFacts.familyId, familyId))
    ).filter((row) => row.validUntil === null);

    return { calls, rows };
  } finally {
    await test.close();
  }
}

/**
 * Scored from the fixture's own expectations (rule #7): which item each stored
 * row is about is read from its key and value, and the class and disposition
 * are read back through the same helpers the brief and the ranker use.
 */
function checkNightly(fixture, { calls, rows }, classify) {
  const failures = [];

  const saves = calls.filter((call) => SAVE_TOOLS.has(call.name));
  if (saves.length === 0) failures.push('the nightly inferencer called no save tool');
  for (const save of saves) {
    for (const field of ['memoryClass', 'disposition']) {
      if (!save.input?.[field]) {
        failures.push(`${save.name}('${save.input?.factKey}') omitted ${field}`);
      }
    }
  }

  for (const expected of fixture.expect) {
    const about = rows.filter((row) => {
      const text = JSON.stringify([row.factKey, row.factValue]).toLowerCase();
      return expected.terms.some((term) => text.includes(term));
    });
    if (expected.required && about.length === 0) {
      failures.push(`${expected.item}: nothing stored`);
    }
    for (const row of about) {
      const kind = classify.promptKind(row.memoryKind, row.factValue);
      const disposition = classify.readDisposition(row.factValue);
      if (kind !== expected.kind || disposition !== expected.disposition) {
        failures.push(
          `${expected.item} ('${row.factKey}') stored ${kind}/${disposition}, expected ${expected.kind}/${expected.disposition}`,
        );
      }
    }
  }

  return failures;
}

// --- main ----------------------------------------------------------------------

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const mode = process.argv.includes('--broken')
    ? 'broken'
    : process.argv.includes('--unranked')
      ? 'unranked'
      : 'real';

  const modules = {
    pglite: await importWeb('lib/testing/pglite.ts'),
    coachTools: await importWeb('lib/coach/tools.ts'),
    coachSkill: await importWeb('lib/coach/skill.ts'),
    coachGuards: await importWeb('lib/coach/guards.ts'),
    context: await importWeb('lib/coach/context.ts'),
    inference: await importWeb('lib/cron/inference.ts'),
    classify: await importWeb('lib/memory/classify-write.ts'),
    agent: await importTs(join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts')),
    db: await import('@hale/db'),
    drizzle: await import('drizzle-orm'),
  };

  const fixtures = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  // The retrieval calibration arm says nothing about classification.
  const nightlyFixtures =
    mode === 'unranked' ? [] : JSON.parse(await readFile(NIGHTLY_FIXTURE_PATH, 'utf8'));
  const total = fixtures.length + nightlyFixtures.length;
  const cost = { liveCalls: 0, input: 0, output: 0 };
  // Read from context.ts rather than hardcoded, so a cap change re-tunes the eval
  // instead of silently making the distractor set too small to prove anything.
  const { factLimit } = await readMemoryLimits();

  console.log(
    `memory-writeback-eval | mode=${mode}${cachedOnly ? ' (cached-only)' : ''} | fixtures: ${fixtures.length} coach + ${nightlyFixtures.length} nightly`,
  );
  console.log(
    `distractor facts per family: ${DISTRACTOR_FACTS} (fact cap ${factLimit}) | cache: evals/cache/`,
  );
  console.log('');

  const failedFixtures = [];
  for (const fixture of fixtures) {
    const result = await runTurn({ fixture, mode, cachedOnly, cost, modules, factLimit });
    const failures = checkTurn(fixture, result);
    if (failures.length) {
      failedFixtures.push({ id: fixture.id, failures });
      console.log(`  FAIL ${fixture.id}`);
      for (const f of failures) console.log(`       - ${f}`);
    } else {
      console.log(`  pass ${fixture.id} (${result.savedFacts.length} fact(s) written, retrievable)`);
    }
  }

  for (const fixture of nightlyFixtures) {
    const result = await runNightly({ fixture, mode, cachedOnly, cost, modules });
    const failures = checkNightly(fixture, result, modules.classify);
    if (failures.length) {
      failedFixtures.push({ id: fixture.id, failures });
      console.log(`  FAIL ${fixture.id}`);
      for (const f of failures) console.log(`       - ${f}`);
    } else {
      const stored = result.rows
        .map(
          (row) =>
            `${row.factKey}=${modules.classify.promptKind(row.memoryKind, row.factValue)}/${modules.classify.readDisposition(row.factValue)}`,
        )
        .join(', ');
      console.log(`  pass ${fixture.id} (${stored})`);
    }
  }

  const estUsd = (cost.input / 1e6) * PRICE.input + (cost.output / 1e6) * PRICE.output;
  console.log('');
  console.log('--- cost ---');
  console.log(`live API calls this run: ${cost.liveCalls}`);
  console.log(`tokens: in=${cost.input} out=${cost.output}`);
  console.log(`estimated cost this run: $${estUsd.toFixed(4)} USD`);

  const allPass = failedFixtures.length === 0;
  console.log('');
  console.log('--- gate ---');
  console.log(`fixtures failing checks: ${failedFixtures.length}/${total}`);
  console.log(`overall (${mode}): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);

  // Calibration is the contract that this gate has teeth. The real (cached) run
  // must pass; BOTH broken arms must be rejected — one for the write half, one for
  // the retrieval half. A stand-in that slips through means the rubric is toothless.
  await unregisterTs();
  if (mode !== 'real' && allPass) {
    console.error(`CALIBRATION BROKEN: the deliberately-bad '${mode}' arm passed the gate.`);
    process.exit(1);
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('memory writeback eval harness error:', err);
  process.exit(2);
});
