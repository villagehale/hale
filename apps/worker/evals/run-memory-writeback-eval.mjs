#!/usr/bin/env node
// Memory WRITEBACK eval — the nightly inferencer.
//
// The web-side memory inferencer (runInferenceForFamily, the live text surface's
// only memory writer) runs over a short synthetic transcript, and the gate scores
// what it stored: every save names memoryClass and disposition, a settled routine
// is enduring, a declined activity is declined (never confirmed), and a passing
// question is curiosity.
//
// IMPORT, don't replicate. This scores a pipeline, so it calls the REAL
// runInferenceForFamily against a REAL Postgres (PGlite + the committed migration
// chain) and reads the rows back. Only the network hop is replayed.
//
// Rule #8: no LLM mocking. The inferencer talks to real Claude once per fixture,
// then replays from a content-addressed cache. A --cached-only miss FAILS LOUDLY.
//
// Run from repo root:
//   node --env-file=.env apps/worker/evals/run-memory-writeback-eval.mjs   # live, then caches
//   node apps/worker/evals/run-memory-writeback-eval.mjs --cached-only     # CI: replay only
//   node apps/worker/evals/run-memory-writeback-eval.mjs --broken          # calibration: nightly saves unlabelled or mislabelled

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { register } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const WEB_TSCONFIG = join(WEB_ROOT, 'tsconfig.json');
const CACHE_DIR = join(HERE, 'cache');
const NIGHTLY_FIXTURE_PATH = join(HERE, 'fixtures', 'memory-writeback', 'nightly.json');
const SAVE_TOOLS = new Set(['save_memory', 'save_child_fact']);

const PRICE = { input: 3.0, output: 15.0 }; // Sonnet list, USD per 1M tokens.

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
        cost.input +=
          response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
        cost.output += response.usage.output_tokens;
        await cachePut(key, { request, response });
        return response;
      },
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
  const mode = process.argv.includes('--broken') ? 'broken' : 'real';

  const modules = {
    pglite: await importWeb('lib/testing/pglite.ts'),
    inference: await importWeb('lib/cron/inference.ts'),
    classify: await importWeb('lib/memory/classify-write.ts'),
    db: await import('@hale/db'),
    drizzle: await import('drizzle-orm'),
  };

  const nightlyFixtures = JSON.parse(await readFile(NIGHTLY_FIXTURE_PATH, 'utf8'));
  const total = nightlyFixtures.length;
  const cost = { liveCalls: 0, input: 0, output: 0 };

  console.log(
    `memory-writeback-eval | mode=${mode}${cachedOnly ? ' (cached-only)' : ''} | fixtures: ${nightlyFixtures.length} nightly`,
  );
  console.log('cache: evals/cache/');
  console.log('');

  const failedFixtures = [];
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
  // must pass; the broken arm (unlabelled or mislabelled saves) must be rejected.
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
