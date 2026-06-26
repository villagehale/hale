#!/usr/bin/env node
// Cost + accuracy as a family's memory grows (VIL-143, launch question #1).
//
// THE QUESTION: as a family accumulates years of derived memory, does the coach
// stay cheap and accurate? The architecture's answer is the BOUNDED memory_slice
// (apps/web/lib/coach/context.ts: the currently-valid facts capped at
// RELEVANT_FACT_LIMIT + the most-recent RECENT_EPISODE_LIMIT episodes) — the agent
// never reads the raw log. This eval tests that claim against the obvious naive
// alternative (dump EVERY fact + episode into context) across S/M/L history.
//
// HOW IT'S FAITHFUL: it runs the REAL runAgent ask-hale loop over the REAL
// ask-hale skill (imported live via tsx, exactly as run-agent-eval.mjs does), with
// fixture-backed tools dispatched through the REAL guarded invoker. The ONLY thing
// that differs between the two arms is the memory the context + the search_memory
// tool carry: BOUNDED replays the prod slice (top factLimit facts, newest
// episodeLimit episodes); DUMP carries the whole synthetic history. Same skill,
// same model, same questions — so any cost/accuracy delta is attributable to the
// slicing strategy, nothing else.
//
// REFERENCE: the questions + expected recall come from the synthetic family
// generator (evals/lib/synth-family.mjs), derived FROM the generated facts, never
// copied from model output (rule #7). A subset of questions deliberately probe OLD
// facts/episodes — the recall targets a recency-ordered bounded slice is most at
// risk of dropping, and the full-dump's supposed advantage. The hypothesis under
// test: bounded keeps input tokens ~flat S->L and recall high; dump's tokens grow
// with history and its OLD-fact recall degrades (context rot) despite carrying the
// data.
//
// Rule #8: real Claude, cached. Rule #1: the family is synthetic (coarse area, a
// synthetic child name) — no real PII in fixtures or cache.
//
// Run from the worker package dir (apps/worker):
//   node --env-file=../../.env evals/run-memory-cost-eval.mjs            # live pass, then caches
//   node evals/run-memory-cost-eval.mjs --cached-only                    # CI: replay only, never calls the API
//   node evals/run-memory-cost-eval.mjs --size=large                     # restrict to one history size

import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { z } from 'zod';
import { generateFamily, HISTORY_SIZES } from './lib/synth-family.mjs';
import {
  REPO_ROOT,
  cacheGet,
  cacheKey,
  cachePut,
  lazyAnthropic,
  makeCost,
  makeJudge,
  noteUsage,
  readJudgeModel,
  readMemoryLimits,
  recall,
  totalUsd,
  JUDGE_MIN,
} from './lib/harness.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'ask-hale.md');

const SIZES = ['small', 'medium', 'large'];

// Gate thresholds (launch bars). Derived from the hypothesis, not the run:
//  - recall floor: the bounded slice must recall the probed fact in >= this share
//    of questions (a memory that can't answer is worse than slow).
//  - judge floor: answers must score >= JUDGE_MIN (1-5) for faithfulness.
//  - cost-growth ceiling: bounded input tokens from S->L must grow by no more than
//    this factor (the "stays cheap as memory grows" claim). A flat slice is ~1x;
//    we allow headroom for the question/skill text. The dump arm is expected to
//    BLOW PAST this — that contrast is the calibration.
const RECALL_FLOOR = 0.8;
const COST_GROWTH_CEILING = 1.5;

// --- cached agent client (wraps runAgent's repeated messages.create) ---------
// Same design as run-agent-eval.mjs's makeCachedAgentClient: content-address each
// round-trip on (model + system + tools + messages), replay on hit, fail loudly on
// a --cached-only miss. We additionally surface the FIRST call's input-token count
// and total wall latency, the two cost signals this eval reports.

function makeCachedAgentClient(tag, cachedOnly, getClient, cost, meter) {
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
        const key = cacheKey(`${tag}:agent`, canonical);
        const cached = await cacheGet(key);
        const t0 = Date.now();
        if (cached) {
          meter.latencyMs += cached.latencyMs ?? 0;
          if (meter.firstInputTokens === null)
            meter.firstInputTokens = cached.firstInputTokens ?? 0;
          return cached.response;
        }
        if (cachedOnly) {
          console.error(
            `agent cache miss in --cached-only mode (${tag}, key ${key}). Re-run live to populate, then commit the cache.`,
          );
          process.exit(1);
        }
        const response = await getClient().messages.create(params);
        const latencyMs = Date.now() - t0;
        noteUsage(cost, params.model, response.usage);
        const firstInputTokens =
          response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
        meter.latencyMs += latencyMs;
        if (meter.firstInputTokens === null) meter.firstInputTokens = firstInputTokens;
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
        await cachePut(key, { response: stored, latencyMs, firstInputTokens });
        return stored;
      },
    },
  };
}

// Guard deps: the real invoker runs, so rule #6 (an audit row per tool call) fires.
// No teen child in this synthetic family, so child-content access is always ok.
function makeGuardDeps(auditLog) {
  return {
    async writeAudit(entry) {
      auditLog.push(entry);
    },
    async checkChildContentAccess() {
      return { ok: true, reason: 'ok' };
    },
  };
}

function zPassthrough() {
  return z.object({}).passthrough();
}

// Build the context + the search_memory slice for one arm. BOUNDED mirrors
// context.ts exactly: facts are the currently-valid set capped at factLimit;
// episodes are the newest episodeLimit (the generator already sorts newest-first).
// DUMP carries the entire history. Both shapes match MemoryFactContext /
// MemoryEpisodeContext so the real skill reads them unchanged.
function buildArm(family, arm, limits) {
  const factCtx = family.facts.map((f) => ({
    factType: f.factType,
    factKey: f.factKey,
    factValue: f.factValue,
    confidence: f.confidence,
  }));
  const epCtx = family.episodes.map((e) => ({
    occurredAt: e.occurredAt,
    episodeType: e.episodeType,
    summary: e.summary,
  }));

  const facts = arm === 'bounded' ? factCtx.slice(0, limits.factLimit) : factCtx;
  const episodes = arm === 'bounded' ? epCtx.slice(0, limits.episodeLimit) : epCtx;

  const context = {
    familyId: 'synth-family-1',
    parentName: 'Sam',
    location: {
      city: family.child.city,
      province: family.child.province,
      country: family.child.country,
    },
    planTier: 'family',
    children: [
      {
        id: family.child.id,
        stage: family.child.stage,
        name: family.child.name,
        ageMonths: family.child.ageMonths,
        teenRedacted: false,
      },
    ],
    focusedChild: {
      id: family.child.id,
      stage: family.child.stage,
      name: family.child.name,
      ageMonths: family.child.ageMonths,
      teenRedacted: false,
      companion: null,
    },
    stages: [family.child.stage],
    memoryFacts: facts,
    recentEpisodes: episodes,
    transcript: [],
    intent: null,
  };
  return { context, facts, episodes };
}

const JUDGE_SYSTEM = [
  'You are a strict grader scoring how well a parenting assistant ANSWERED a',
  'specific recall question about a family, given the reference answer. Score 1-5.',
  'A 5 states the same fact as the reference (paraphrase is fine) and adds nothing',
  'contradictory or invented. A LOW score MISSES the fact, gets it WRONG, says it',
  "doesn't know when the reference shows it should, or fabricates a specific not in",
  'the reference. Judge ONLY factual correctness vs the reference. Reply with the score tool.',
].join(' ');

// Calibration stand-in: a memory-blind coach that never reads the slice and
// recalls nothing. Deterministic, makes NO API call and reads NO cache (same
// discipline as the other evals' broken generators), so the gate's teeth are
// proven without spend: starved of memory, fact recall collapses and the gate
// must fail.
const BROKEN_ANSWER =
  "i don't have that information on file. you might want to check your own notes.";

async function runArm(opts) {
  const { agent, skill, family, arm, limits, broken, cachedOnly, getClient, cost, judge } = opts;
  const { context } = buildArm(family, arm, limits);

  const per = [];
  let inputTokensSum = 0;
  let latencySum = 0;

  for (const q of family.referenceQA) {
    let answer;
    let score;
    if (broken) {
      answer = BROKEN_ANSWER;
      score = 1; // a memory-blind answer is unfaithful by construction
    } else {
      const auditLog = [];
      const meter = { firstInputTokens: null, latencyMs: 0 };
      // search_memory returns THIS arm's slice — so the slicing strategy is honoured
      // both in the injected context and at the tool boundary the skill calls.
      const tools = buildTools(agent, context);
      const client = makeCachedAgentClient(
        `mem-cost:${family.size}:${arm}:${q.id}`,
        cachedOnly,
        getClient,
        cost,
        meter,
      );
      const run = await agent.runAgent({
        skill,
        context: { ...context, question: q.question },
        tools,
        client,
        maxSteps: 6,
        maxTokens: 1024,
        toolContext: { familyId: context.familyId, actor: 'eval-actor' },
        guardDeps: makeGuardDeps(auditLog),
      });
      answer = run.answer ?? '';
      score = (
        await judge(`${family.size}:${arm}:${q.id}`, {
          question: q.question,
          reference: q.referenceAnswer,
          answer,
        })
      ).score;
      inputTokensSum += meter.firstInputTokens ?? 0;
      latencySum += meter.latencyMs;
    }
    const r = recall(answer, q.mustRecall);
    per.push({ id: q.id, kind: q.kind, targetsOld: q.targetsOld, recall: r, score, answer });
  }

  const n = per.length;
  const factQ = per.filter((p) => p.kind === 'fact');
  const epQ = per.filter((p) => p.kind === 'episode');
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    arm,
    size: family.size,
    avgInputTokens: Math.round(inputTokensSum / n),
    avgLatencyMs: Math.round(latencySum / n),
    // Fact-store recall is the gated metric (consolidated, bounded — must hold).
    factRecall: mean(factQ.map((p) => p.recall)),
    factMinScore: factQ.length ? Math.min(...factQ.map((p) => p.score)) : null,
    // Episode-store recall is REPORTED: the bounded slice is expected to lose old
    // episodes a full-dump retains — the documented cost of bounding.
    episodeRecall: mean(epQ.map((p) => p.recall)),
    avgScore: mean(per.map((p) => p.score)),
    per,
  };
}

function buildTools(agent, context) {
  const getChildProfile = agent.defineTool({
    name: 'get_child_profile',
    description: "Read one of THIS family's children by id: derived stage, age, stage guidance.",
    inputSchema: zPassthrough(),
    touchesChildContent: true,
    handler: async (input) => {
      const c = context.children.find((x) => x.id === input.childId) ?? context.children[0];
      return {
        found: true,
        name: c.name,
        stage: c.stage,
        ageMonths: c.ageMonths,
        whatsNow: [],
        whatsNext: [],
      };
    },
  });
  const searchMemory = agent.defineTool({
    name: 'search_memory',
    description: 'Recall currently-valid memory facts and recent episodes for THIS family.',
    inputSchema: zPassthrough(),
    handler: async () => ({ facts: context.memoryFacts, episodes: context.recentEpisodes }),
  });
  const saveMemory = agent.defineTool({
    name: 'save_memory',
    description: 'Persist a durable fact the parent STATED about THIS family.',
    inputSchema: zPassthrough(),
    handler: async () => ({ saved: true, factId: 'fixture-fact' }),
  });
  const getFrameworkGuidance = agent.defineTool({
    name: 'get_framework_guidance',
    description: 'Stage guidance: what matters now, milestones, the Canadian health cadence.',
    inputSchema: zPassthrough(),
    handler: async (input) => ({
      stage: input.stage,
      whatsNow: [],
      milestones: [],
      nextHealth: [],
    }),
  });
  const searchVillage = agent.defineTool({
    name: 'search_village',
    description: "Surface local activities already discovered for THIS family's area.",
    inputSchema: zPassthrough(),
    handler: async () => ({ candidates: [] }),
  });
  return [getChildProfile, searchMemory, saveMemory, getFrameworkGuidance, searchVillage];
}

function fmtPct(x) {
  return x === null ? '  n/a' : `${(x * 100).toFixed(0).padStart(3)}%`;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  // Calibration: --broken swaps in a memory-blind coach (recalls nothing) so fact
  // recall must collapse below the floor and the gate must FAIL — proving the gate
  // has teeth without any spend (no API call, no cache read in broken mode).
  const broken = process.argv.includes('--broken');
  const sizeArg = process.argv.find((a) => a.startsWith('--size='))?.split('=')[1];
  const sizes = sizeArg ? [sizeArg] : SIZES;

  const limits = await readMemoryLimits();
  const judgeModel = await readJudgeModel();
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);

  const getClient = lazyAnthropic();
  const cost = makeCost();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'mem-cost', cachedOnly, getClient, cost);

  console.log(
    `mem-cost-eval | ${broken ? 'BROKEN (calibration)' : cachedOnly ? 'cached-only' : 'live'} | coach=${skill.meta.task} | bounded slice = ${limits.factLimit} facts / ${limits.episodeLimit} episodes`,
  );
  console.log('');

  const rows = [];
  for (const size of sizes) {
    const family = generateFamily(size);
    console.log(
      `[${size}] history: ${family.counts.facts} facts, ${family.counts.episodes} episodes (${HISTORY_SIZES[size].months}mo) | ${family.referenceQA.length} questions`,
    );
    for (const arm of ['bounded', 'dump']) {
      const r = await runArm({
        agent,
        skill,
        family,
        arm,
        limits,
        broken,
        cachedOnly,
        getClient,
        cost,
        judge,
      });
      rows.push(r);
    }
  }

  // --- table -----------------------------------------------------------------
  console.log('');
  console.log('=== cost + accuracy: bounded slice vs naive full-dump ===');
  console.log('size    arm      in_tok  latency  fact_recall  episode_recall  judge');
  console.log('------  -------  ------  -------  -----------  --------------  -----');
  for (const r of rows) {
    console.log(
      `${r.size.padEnd(6)}  ${r.arm.padEnd(7)}  ${String(r.avgInputTokens).padStart(6)}  ${(`${r.avgLatencyMs}ms`).padStart(7)}  ${fmtPct(r.factRecall).padStart(11)}  ${fmtPct(r.episodeRecall).padStart(14)}  ${r.avgScore.toFixed(1)}`,
    );
  }

  // --- cost-growth summary (the headline) ------------------------------------
  const bySizeArm = (s, a) => rows.find((r) => r.size === s && r.arm === a);
  const growth = (arm) => {
    const sm = bySizeArm('small', arm);
    const lg = bySizeArm('large', arm);
    if (!sm || !lg) return null;
    return lg.avgInputTokens / sm.avgInputTokens;
  };
  const boundedGrowth = growth('bounded');
  const dumpGrowth = growth('dump');
  console.log('');
  console.log('=== input-token growth, small -> large history ===');
  if (boundedGrowth !== null) console.log(`bounded slice: ${boundedGrowth.toFixed(2)}x`);
  if (dumpGrowth !== null) console.log(`naive dump:    ${dumpGrowth.toFixed(2)}x`);

  // --- the documented tradeoff ----------------------------------------------
  // Report (not gate) the episode-recall gap: the price the bounded slice pays for
  // staying cheap is losing OLD episodes a full-dump retains. Surfacing it is the
  // honest half of the answer — bounded wins on cost, dump wins on deep episodic
  // recall; the launch bet is that fact recall + cost matter more for the coach.
  const med = bySizeArm('large', 'bounded') ?? bySizeArm('medium', 'bounded');
  const medDump = med && bySizeArm(med.size, 'dump');
  if (med && medDump && med.episodeRecall !== null) {
    console.log('');
    console.log('=== documented tradeoff (reported, not gated) ===');
    console.log(
      `[${med.size}] old-episode recall: bounded ${fmtPct(med.episodeRecall).trim()} vs dump ${fmtPct(medDump.episodeRecall).trim()} — the cost of bounding`,
    );
  }

  console.log('');
  console.log('--- cost ---');
  console.log(`live API calls this run: ${cost.liveCalls}`);
  console.log(`estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`);

  // --- gate ------------------------------------------------------------------
  // The bounded arm IS the product. The launch claim it must defend: as memory
  // grows, the coach stays CHEAP (input-token growth S->L under the ceiling) and
  // FACT-accurate (fact-store recall above the floor + faithful at every size).
  // Episode-store loss is the reported tradeoff above, not a gate (the bounded
  // slice is recency-only by design — gating on it would gate the architecture out).
  const failures = [];
  for (const r of rows.filter((x) => x.arm === 'bounded')) {
    if (r.factRecall !== null && r.factRecall < RECALL_FLOOR) {
      failures.push(
        `[${r.size}] bounded fact-recall ${(r.factRecall * 100).toFixed(0)}% < ${RECALL_FLOOR * 100}%`,
      );
    }
    if (r.factMinScore !== null && r.factMinScore < JUDGE_MIN) {
      failures.push(`[${r.size}] bounded fact min judge ${r.factMinScore} < ${JUDGE_MIN}`);
    }
  }
  if (
    sizes.length === SIZES.length &&
    boundedGrowth !== null &&
    boundedGrowth > COST_GROWTH_CEILING
  ) {
    failures.push(
      `bounded input-token growth ${boundedGrowth.toFixed(2)}x > ${COST_GROWTH_CEILING}x ceiling`,
    );
  }

  const allPass = failures.length === 0;
  console.log('');
  console.log('--- gate (bounded slice = the product) ---');
  if (broken) {
    // Calibration: the memory-blind coach MUST be rejected. If it passed, the gate
    // is toothless — surface that as a hard failure, not a silent pass.
    if (allPass) {
      console.error('CALIBRATION BROKEN: the memory-blind coach passed the gate.');
      process.exit(1);
    }
    console.log('PASS (calibration): the memory-blind coach is correctly REJECTED (exit 0)');
    process.exit(0);
  }
  if (allPass) {
    console.log('PASS (exit 0): bounded slice stays cheap + fact-accurate as memory grows');
    process.exit(0);
  }
  for (const f of failures) console.log(`  FAIL - ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('mem-cost eval harness error:', err);
  process.exit(2);
});
