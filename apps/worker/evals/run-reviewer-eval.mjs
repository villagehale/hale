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
//   node --env-file=../../launch.env evals/run-reviewer-eval.mjs --model=haiku
//   EVAL_GATEWAY_MODEL=openai/gpt-5.6-luna node --env-file=../../launch.env \
//     evals/run-reviewer-eval.mjs --suite=sms-calendar
//   node --env-file=../../launch.env evals/run-reviewer-eval.mjs \
//     --anthropic-model=claude-sonnet-5-5 --suite=sms-calendar --max-tokens=4096
//   node evals/run-reviewer-eval.mjs --suite=sms-calendar --preflight
//   node evals/run-reviewer-eval.mjs --suite=sms-calendar --broken

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { tsImport } from 'tsx/esm/api';
import {
  PRICE,
  evalAnthropicRequest,
  evalRunTag,
  evalSubjectClient,
  evalSubjectRequest,
} from './lib/harness.mjs';
import { SMS_CALENDAR_REVIEWER_FIXTURES } from './sms-calendar-reviewer-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, 'cache');
const FIXTURES_DIR = join(HERE, 'fixtures', 'reviewer');
const cachedOnly = process.argv.includes('--cached-only');

// reviewer.ts pulls in config.ts, which validates DATABASE_URL at import. This
// eval injects every DB-touching dep (invokeTool, loadChildNames), so it never
// opens a connection — but the import must not crash when no DB env is set (CI's
// eval step has none). A stub URL satisfies the import-time parse; nothing reads it.
process.env.DATABASE_URL ??= 'postgresql://stub:stub@localhost:5432/stub';

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

const cost = {
  liveCalls: 0,
  input: 0,
  cacheCreation: 0,
  cacheRead: 0,
  output: 0,
  latencies: [],
};
let lazyClient;
let lastCallError = null;
function getClient() {
  lazyClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return lazyClient;
}

function makeCachedClient(tag, anthropicModel) {
  return {
    messages: {
      async create(params) {
        const request = anthropicModel
          ? evalAnthropicRequest(
              {
                ...params,
                thinking: { type: 'adaptive' },
                output_config: { effort: 'high' },
              },
              anthropicModel,
            )
          : evalSubjectRequest(params);
        const canonical = JSON.stringify(request);
        const key = cacheKey(evalRunTag(`${tag}:reviewer`), canonical);
        const cached = await cacheGet(key);
        if (cached) {
          if (Number.isFinite(cached.latencyMs)) cost.latencies.push(cached.latencyMs);
          return cached.response;
        }
        if (cachedOnly) {
          console.error(
            `reviewer cache miss in --cached-only mode (${tag}, key ${key}). Re-run live to populate, then commit the cache.`,
          );
          process.exit(1);
        }
        let response;
        const startedAt = Date.now();
        try {
          response = await evalSubjectClient(getClient).messages.create(request);
        } catch (err) {
          lastCallError = {
            name: err instanceof Error ? err.name : 'Error',
            status: typeof err?.status === 'number' ? err.status : null,
            message: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
          };
          throw err;
        }
        const latencyMs = Date.now() - startedAt;
        if (response.stop_reason === 'max_tokens') {
          throw new Error(`${tag}: reviewer response truncated at max_tokens`);
        }
        cost.liveCalls += 1;
        cost.input += response.usage.input_tokens;
        cost.cacheCreation += response.usage.cache_creation_input_tokens ?? 0;
        cost.cacheRead += response.usage.cache_read_input_tokens ?? 0;
        cost.output += response.usage.output_tokens;
        cost.latencies.push(latencyMs);
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
        await cachePut(key, { response: stored, latencyMs });
        return stored;
      },
    },
  };
}

const brokenClient = {
  messages: {
    async create() {
      return {
        id: 'broken-reviewer',
        type: 'message',
        role: 'assistant',
        model: 'broken-reviewer',
        stop_reason: 'tool_use',
        stop_sequence: null,
        content: [
          {
            type: 'tool_use',
            id: 'broken-verdict',
            name: 'submit_verdict',
            input: { verdict: 'approve', rationale: 'rubber-stamp broken control' },
          },
        ],
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  },
};

// A tool invoker that mirrors the INPUT half of the real invokeReviewerTool: it parses
// the model's input through the live tools-contracts schema (a bad call → ok:false),
// then returns the fixture-scripted ok for a valid call. This is what makes a missing
// action_hash surface as ok:false — the exact ISSUE-5 failure mode. The results are
// scripted rather than contract-shaped, so this eval says nothing about the real door's
// output projection (VIL-270); that is pinned by output-contract.test.ts instead.
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
  if (kind.startsWith('ERROR:')) return false;
  if (expect === 'approve') return kind === 'approve';
  if (expect === 'not-approve') return kind !== 'approve';
  return kind === expect; // exact: 'reject' | 'flag_for_human'
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(quantile * ordered.length) - 1];
}

async function main() {
  const modelArg = process.argv.find((arg) => arg.startsWith('--model='))?.split('=')[1];
  const anthropicModel = process.argv
    .find((arg) => arg.startsWith('--anthropic-model='))
    ?.split('=')[1];
  const maxTokensArg = process.argv.find((arg) => arg.startsWith('--max-tokens='))?.split('=')[1];
  const maxTokens = maxTokensArg === undefined ? 4096 : Number(maxTokensArg);
  const only = process.argv.find((arg) => arg.startsWith('--only='))?.split('=')[1];
  const suite = process.argv.find((arg) => arg.startsWith('--suite='))?.split('=')[1] ?? 'legacy';
  const preflight = process.argv.includes('--preflight');
  const broken = process.argv.includes('--broken');
  if (modelArg && modelArg !== 'haiku') {
    throw new Error(`unsupported --model=${modelArg}; expected haiku or omit the flag`);
  }
  if (!['legacy', 'sms-calendar'].includes(suite)) {
    throw new Error(`unsupported --suite=${suite}; expected legacy or sms-calendar`);
  }
  if (modelArg && process.env.EVAL_GATEWAY_MODEL) {
    throw new Error('use either --model=haiku or EVAL_GATEWAY_MODEL, not both');
  }
  if (anthropicModel && (modelArg || process.env.EVAL_GATEWAY_MODEL)) {
    throw new Error('use only one of --anthropic-model, --model=haiku, or EVAL_GATEWAY_MODEL');
  }
  if (anthropicModel && anthropicModel !== 'claude-sonnet-5-5') {
    throw new Error('--anthropic-model currently supports only claude-sonnet-5-5');
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error('--max-tokens must be a positive integer');
  }
  if (broken && (modelArg || anthropicModel || process.env.EVAL_GATEWAY_MODEL || cachedOnly)) {
    throw new Error(
      '--broken is offline; do not combine it with a model override or --cached-only',
    );
  }
  const models = await tsImport('../../../packages/agent/src/model.ts', import.meta.url);
  const { estimateCostUsd } = await tsImport(
    '../../../packages/agent/src/cost.ts',
    import.meta.url,
  );
  const model = modelArg === 'haiku' ? models.HAIKU_MODEL : models.SONNET5_MODEL;
  const modelMode = modelArg === 'haiku' ? 'candidate' : 'current';
  const subjectModel = process.env.EVAL_GATEWAY_MODEL ?? anthropicModel ?? model;
  console.log(
    `reviewer-eval | mode=${broken ? 'broken' : cachedOnly ? 'cached-only' : 'real'} | suite=${suite} | review model=${subjectModel}`,
  );
  const allFixtures =
    suite === 'sms-calendar' ? SMS_CALENDAR_REVIEWER_FIXTURES : await loadFixtures();
  const selectedIds = new Set(only?.split(',').filter(Boolean) ?? []);
  const fixtures = only
    ? allFixtures.filter((fixture) => selectedIds.has(fixture.id))
    : allFixtures;
  if (fixtures.length !== (only ? selectedIds.size : allFixtures.length)) {
    throw new Error(`one or more fixtures did not match --only=${only}`);
  }
  console.log(`fixtures: ${fixtures.length}\n`);
  if (preflight) {
    console.log(
      `preflight: max subject calls=${fixtures.length * 8} (${fixtures.length} fixtures × 8 turns)`,
    );
    return;
  }

  const results = [];
  for (const fx of fixtures) {
    lastCallError = null;
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
    let missingChecks = [];
    try {
      const { verdict, runMetrics } = await runReviewer(
        { familyId: fx.familyId, draft },
        {
          client: broken ? brokenClient : makeCachedClient(fx.id, anthropicModel),
          invokeTool: makeInvokeTool(fx.checkPolicy ?? {}),
          loadChildNames: async () => [],
          modelMode,
          maxTokens,
        },
      );
      verdictKind =
        process.env.EVAL_GATEWAY_MODEL || anthropicModel
          ? verdict.kind
          : runMetrics.modelUsed === model
            ? verdict.kind
            : `ERROR:candidate fell back to ${runMetrics.modelUsed} (${lastCallError?.name ?? 'unknown'}${lastCallError?.status ? ` ${lastCallError.status}` : ''}: ${lastCallError?.message ?? 'no error detail'})`;
      const called = new Set(verdict.toolResults.map((result) => result.tool));
      missingChecks = contracts.REQUIRED_CHECKS[fx.draft.actionType].filter(
        (check) => !called.has(check),
      );
    } catch (err) {
      verdictKind = `ERROR:${err.message}`;
    }
    const pass = verdictMatches(fx.expect, verdictKind) && missingChecks.length === 0;
    results.push({ id: fx.id, expect: fx.expect, got: verdictKind, missingChecks, pass });
    console.log(
      `  ${pass ? 'pass' : 'FAIL'} ${fx.id} — expect ${fx.expect}, got ${verdictKind}${missingChecks.length ? `, missing ${missingChecks.join(',')}` : ''}${pass ? '' : '  <<<<<'}`,
    );
  }

  const failures = results.filter((r) => !r.pass);
  if (!cachedOnly && !broken) {
    const usage = {
      inputTokens: cost.input,
      cacheCreationTokens: cost.cacheCreation,
      cacheReadTokens: cost.cacheRead,
      outputTokens: cost.output,
    };
    const candidateRate = PRICE[subjectModel];
    const usd =
      process.env.EVAL_GATEWAY_MODEL || anthropicModel
        ? candidateRate
          ? ((cost.input + cost.cacheCreation + cost.cacheRead) * candidateRate.input +
              cost.output * candidateRate.output) /
            1e6
          : null
        : estimateCostUsd(model, usage);
    const p50 = percentile(cost.latencies, 0.5);
    const p95 = percentile(cost.latencies, 0.95);
    console.log(
      `\n--- telemetry --- live calls: ${cost.liveCalls} | tokens in=${cost.input} cache-write=${cost.cacheCreation} cache-read=${cost.cacheRead} out=${cost.output} | estimated USD=${usd === null ? 'UNPRICED' : `$${usd.toFixed(4)}`} | p50/p95=${p50 ?? 'n/a'}/${p95 ?? 'n/a'}ms`,
    );
  }
  console.log(`\n--- gate --- ${results.length - failures.length}/${results.length} passed`);
  if (broken) {
    const calibrated = failures.length > 0;
    console.log(
      `broken-mode calibration (rubber-stamp approval must fail): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
    );
    process.exit(calibrated ? 0 : 1);
  }
  console.log(`overall: ${failures.length === 0 ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
