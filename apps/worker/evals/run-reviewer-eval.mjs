// Reviewer verdict eval — the coverage the reviewer never had (rule #8).
//
// Runs the REAL runReviewer loop (apps/worker/src/agents/reviewer.ts, via the tsx
// loader) against fixture drafts, with a realistic tool invoker that VALIDATES the
// model's tool input through the REAL @hale/tools-contracts schemas (a bad call —
// e.g. omitting actionHash — returns ok:false exactly like the live invoker) and
// otherwise returns each check's fixture-scripted result. So the eval exercises
// BOTH the model's tool-use (does it pass the draft's action_hash?) and its verdict
// logic (approve/flag/reject), plus the unmocked deterministic coverage downgrade.
//
// Calibrated both directions: a clean internal write APPROVES (ISSUE-5 guard); a
// duplicate and an over-cap spend do NOT (the gate is not a rubber stamp).
//
// Usage:
//   node --env-file=../../.env evals/run-reviewer-eval.mjs   # live, then caches
//   node evals/run-reviewer-eval.mjs --cached-only           # CI: replay only

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, 'cache');
const FIXTURES_DIR = join(HERE, 'fixtures', 'reviewer');
const cachedOnly = process.argv.includes('--cached-only');

// --- real code, loaded live via the tsx loader -----------------------------
const reviewerMod = await tsImport('../src/agents/reviewer.ts', import.meta.url);
const { computeActionHash } = await tsImport('../src/agents/action-hash.ts', import.meta.url);
const contracts = await tsImport('../../../packages/tools-contracts/src/index.ts', import.meta.url);
const runReviewer = reviewerMod.runReviewer;
const REVIEWER_TOOLS = contracts.REVIEWER_TOOLS;

// --- content-addressed cache (never calls live in --cached-only) ------------
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

const cost = { liveCalls: 0, in: 0, out: 0 };
let lazyClient;
function getClient() {
  lazyClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return lazyClient;
}

function makeCachedClient(tag) {
  return {
    messages: {
      async create(params) {
        const canonical = JSON.stringify({
          model: params.model,
          system: params.system,
          tools: params.tools,
          messages: params.messages,
          max_tokens: params.max_tokens,
        });
        const key = cacheKey(`${tag}:reviewer`, canonical);
        const cached = await cacheGet(key);
        if (cached) return cached.response;
        if (cachedOnly) {
          console.error(
            `reviewer cache miss in --cached-only mode (${tag}, key ${key}). Re-run live to populate, then commit the cache.`,
          );
          process.exit(1);
        }
        const response = await getClient().messages.create(params);
        cost.liveCalls += 1;
        cost.in += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
        cost.out += response.usage.output_tokens;
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

// A tool invoker that mirrors the REAL invokeReviewerTool: it parses the model's
// input through the live tools-contracts schema (a bad call → ok:false), then
// returns the fixture-scripted ok for a valid call. This is what makes a missing
// action_hash surface as ok:false — the exact ISSUE-5 failure mode.
function makeInvokeTool(checkPolicy) {
  return async (name, rawInput) => {
    const spec = REVIEWER_TOOLS[name];
    if (!spec) return { tool: name, ok: false, result: { error: `unknown tool ${name}` } };
    try {
      spec.input.parse(rawInput);
    } catch (err) {
      if (process.env.REVIEWER_EVAL_DEBUG) {
        console.error(`  [debug] ${name} parse FAIL — model sent: ${JSON.stringify(rawInput)}`);
      }
      return { tool: name, ok: false, result: { error: `invalid input: ${err.message}` } };
    }
    const ok = checkPolicy[name] ?? true;
    return { tool: name, ok, result: { simulated: true, ok } };
  };
}

async function loadFixtures() {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
  const out = [];
  for (const f of files) out.push(JSON.parse(await readFile(join(FIXTURES_DIR, f), 'utf8')));
  return out;
}

function verdictMatches(expect, kind) {
  if (expect === 'approve') return kind === 'approve';
  if (expect === 'not-approve') return kind !== 'approve';
  return kind === expect; // exact: 'reject' | 'flag_for_human'
}

async function main() {
  const model = (await tsImport('../../../packages/agent/src/model.ts', import.meta.url))
    .SONNET5_MODEL;
  console.log(
    `reviewer-eval | mode=${cachedOnly ? 'cached-only' : 'real'} | review model=${model}`,
  );
  const fixtures = await loadFixtures();
  console.log(`fixtures: ${fixtures.length}\n`);

  const results = [];
  for (const fx of fixtures) {
    // Stamp a deterministic action_hash onto the draft payload, exactly as the
    // orchestrator now does, so the model has a real key to pass to the check.
    const identity =
      typeof fx.draft.payload.candidate_id === 'string'
        ? fx.draft.payload.candidate_id
        : fx.draft.id;
    const draft = {
      ...fx.draft,
      eventId: `evt-${fx.draft.id}`,
      familyId: fx.familyId,
      draftConfidence: { score: 1, rationale: 'eval fixture' },
      rationale: 'eval fixture',
      draftedAt: '2026-07-06T00:00:00.000Z',
      payload: {
        ...fx.draft.payload,
        action_hash: computeActionHash(fx.familyId, fx.draft.actionType, identity),
      },
    };
    let verdictKind = 'ERROR';
    try {
      const { verdict } = await runReviewer(
        { familyId: fx.familyId, draft },
        {
          client: makeCachedClient(fx.id),
          invokeTool: makeInvokeTool(fx.checkPolicy ?? {}),
          loadChildNames: async () => [],
        },
      );
      verdictKind = verdict.kind;
    } catch (err) {
      verdictKind = `ERROR:${err.message}`;
    }
    const pass = verdictMatches(fx.expect, verdictKind);
    results.push({ id: fx.id, expect: fx.expect, got: verdictKind, pass });
    console.log(
      `  ${pass ? 'pass' : 'FAIL'} ${fx.id} — expect ${fx.expect}, got ${verdictKind}${pass ? '' : '  <<<<<'}`,
    );
  }

  const failures = results.filter((r) => !r.pass);
  if (!cachedOnly) {
    const usd = (cost.in / 1e6) * 3 + (cost.out / 1e6) * 15; // Sonnet-tier approx
    console.log(
      `\n--- cost --- live calls: ${cost.liveCalls} | tokens in=${cost.in} out=${cost.out} | ~$${usd.toFixed(4)}`,
    );
  }
  console.log(`\n--- gate --- ${results.length - failures.length}/${results.length} passed`);
  console.log(`overall: ${failures.length === 0 ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
