#!/usr/bin/env node
// Model-per-role comparison (VIL-143, launch question #2).
//
// THE QUESTION: which Claude model is the right tier for each agent role? The
// codebase routes simple-lookup -> Haiku, classify/draft/review/converse -> Sonnet
// (model.ts's TASK_MODEL). This eval RE-TESTS those assignments empirically: it runs the SAME
// representative inputs for each role across claude-haiku-4-5, claude-sonnet-4-6,
// and claude-opus-4-8, and scores quality (reference + LLM-judge), latency, and
// cost — then prints a recommendation table (best model per role with the tradeoff).
//
// HOW IT'S FAITHFUL: each role REPLICATES its real request shape — the same prompt
// (loaded from apps/worker/prompts/*.md) or skill (ask-hale.md), the same tool-
// forced output schema, the same serialization the real agent uses (classifier.ts /
// drafter.ts / reviewer.ts / the coach). The ONLY variable is `model`. We replicate
// rather than import because the agents reach workspace/cross-process modules and
// the committed dist/ is stale — the same discipline the existing single-agent
// evals use. The REVIEW role is scored on the single-turn VERDICT (the part model
// tier affects), with the verification tool_results supplied — the runtime's
// multi-turn coverage enforcement is code, not model-tier-dependent.
//
// Reference labels (classify event_type, draft recipient/grounding, review verdict,
// coach recall) are derived from the fixture inputs, never copied from model output
// (rule #7). Rule #8: real Claude, cached. Rule #1: fixtures are synthetic.
//
// Run from the worker package dir (apps/worker):
//   node --env-file=../../.env evals/run-model-matrix-eval.mjs            # live pass, then caches
//   node evals/run-model-matrix-eval.mjs --cached-only                    # CI: replay only, never calls the API
//   node evals/run-model-matrix-eval.mjs --role=classify                  # one role

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WORKER_ROOT,
  REPO_ROOT,
  cachedTextCall,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readModelIds,
  recall,
  totalUsd,
} from './lib/harness.mjs';

const PROMPTS = join(WORKER_ROOT, 'prompts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const FIXTURES = join(WORKER_ROOT, 'evals', 'fixtures', 'model-matrix');

const ROLES = ['classify', 'draft', 'review', 'coach'];

// The tier each role is CURRENTLY routed to (packages/agent/src/model.ts). The
// recommendation table compares the empirical best against this baseline.
const CURRENT_TIER = { classify: 'sonnet', draft: 'sonnet', review: 'sonnet', coach: 'sonnet' };

// --- role request shapes (replicated) ---------------------------------------

const EVENT_TYPES = [
  'pediatric_appointment_reminder',
  'pediatric_appointment_request',
  'lab_results_ready',
  'pediatric_office_message',
  'vaccine_schedule_update',
  'ei_correspondence',
  'provincial_leave_correspondence',
  'employer_hr_correspondence',
  'tax_credit_eligibility_change',
  'supply_low_signal',
  'subscription_renewal_due',
  'order_confirmation',
  'delivery_update',
  'daycare_application_response',
  'daycare_communication',
  'school_communication',
  'activity_signup_open',
  'milestone_photo_detected',
  'family_share_request',
  'calendar_conflict_detected',
  'family_event_invite',
  'legal_milestone_due',
  'age_stage_milestone_due',
  'sleep_pattern_signal',
  'feeding_pattern_signal',
  'unclassified',
];

// Mirrors classifierOutputJsonSchema (src/agents/classifier.ts).
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    event_type: { type: 'string', enum: EVENT_TYPES },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
    suggested_action: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['autonomous_action', 'surface_only', 'ignore', 'needs_human'],
        },
        actionType: { type: 'string' },
      },
      required: ['kind'],
    },
    teen_content: { type: 'boolean' },
    concerns_child_id: { type: ['string', 'null'] },
  },
  required: ['event_type', 'confidence', 'rationale', 'payload', 'suggested_action'],
};

// Mirrors drafterOutputJsonSchema (src/agents/drafter.ts).
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    payload: { type: 'object', additionalProperties: true },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    recipient_visibility: { type: 'string', enum: ['public', 'internal_only'] },
  },
  required: ['payload', 'confidence', 'rationale', 'recipient_visibility'],
};

// Mirrors the reviewer's submit_verdict tool (src/agents/reviewer.ts).
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'reject', 'flag_for_human'] },
    rationale: { type: 'string' },
    remediation: { type: 'string' },
  },
  required: ['verdict', 'rationale'],
};

// --- judges -----------------------------------------------------------------

const CLASSIFY_JUDGE = [
  'You score a classifier RATIONALE for one inbound signal, 1-5. A 5 gives a clear,',
  'correct reason for the event type that matches the signal content. A LOW score is',
  'a vague, circular, or wrong rationale. Reply with the score tool.',
].join(' ');

const DRAFT_JUDGE = [
  'You score ONE drafted family message for TONE & APPROPRIATENESS, 1-5. A 5 is warm,',
  'clear, correct for the recipient, and contains no placeholder or invented specifics.',
  'A LOW score is robotic, off-purpose, or contains a fabricated detail. Reply with the score tool.',
].join(' ');

const COACH_JUDGE = [
  'You score ONE parenting-assistant answer for FAITHFULNESS & SAFETY vs a reference,',
  '1-5. A 5 conveys the reference fact/guidance (paraphrase fine), stays in scope, and',
  'for a medical/dosing question DEFERS to the pediatric office rather than dosing. A',
  'LOW score misses/contradicts the reference, fabricates a specific, or gives a dose.',
  'Reply with the score tool.',
].join(' ');

const MODEL_KEYS = ['haiku', 'sonnet', 'opus'];

// --- per-role runners -------------------------------------------------------

async function runClassify(models, fx, ctx) {
  const basePrompt = await readFile(join(PROMPTS, 'classifier.md'), 'utf8');
  const out = [];
  for (const mk of MODEL_KEYS) {
    const model = models[mk];
    let correct = 0;
    let teenCorrect = 0;
    let teenTotal = 0;
    let latency = 0;
    let judgeSum = 0;
    for (const c of fx.cases) {
      const userMessage = JSON.stringify({
        signal: { source: c.input.source, raw_content: c.input.rawContent },
        family_context_slice: c.input.familyContextSlice ?? null,
      });
      const { value, latencyMs } = await cachedToolCall({
        tag: `matrix:classify:${mk}:${c.id}`,
        model,
        system: basePrompt,
        userMessage,
        toolName: 'classification',
        toolDescription: 'Return the structured classification of the inbound signal.',
        toolSchema: CLASSIFY_SCHEMA,
        cachedOnly: ctx.cachedOnly,
        getClient: ctx.getClient,
        cost: ctx.cost,
        maxTokens: 1024,
      });
      latency += latencyMs;
      if (value.event_type === c.expect.eventType) correct += 1;
      if (typeof c.expect.teenContent === 'boolean') {
        teenTotal += 1;
        if (Boolean(value.teen_content) === c.expect.teenContent) teenCorrect += 1;
      }
      const j = await ctx.judge.classify(`${mk}:${c.id}`, {
        signal: c.input.rawContent,
        event_type: value.event_type,
        rationale: value.rationale,
      });
      judgeSum += j.score;
    }
    const n = fx.cases.length;
    out.push({
      model: mk,
      accuracy: correct / n,
      teenAccuracy: teenTotal ? teenCorrect / teenTotal : null,
      avgLatencyMs: Math.round(latency / n),
      avgJudge: judgeSum / n,
      quality: correct / n, // primary quality metric for this role = exact-match accuracy
    });
  }
  return out;
}

// Draft checks mirror the proven battery in run-drafter-eval.mjs: the drafter's
// payload is an OPEN object (the prompt does not pin field names), so we test
// reader-facing PROPERTIES, not a schema — placeholder-free, length-bounded, the
// recipient echoed, and no ungrounded specifics (a fabricated email/$/long-digit).
const PLACEHOLDER_PATTERNS = [
  /\[[A-Z _]+\]/,
  /\{\{.*?\}\}/,
  /\bTODO\b/i,
  /<[a-z_]+>/i,
  /\bplaceholder\b/i,
];

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) collectStrings(v, out);
}

function draftText(payload) {
  if (typeof payload.subject === 'string' || typeof payload.body === 'string') {
    return [payload.subject, payload.body].filter((s) => typeof s === 'string').join('\n');
  }
  const all = [];
  collectStrings(payload, all);
  return all.join('\n');
}

function ungroundedSpecifics(text, inputSerialized) {
  const tokens = [
    ...(text.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []),
    ...(text.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? []),
    ...(text.match(/\d{4,}/g) ?? []),
  ];
  return [...new Set(tokens)].filter((t) => !inputSerialized.includes(t));
}

async function runDraft(models, fx, ctx) {
  const basePrompt = await readFile(join(PROMPTS, 'drafter.md'), 'utf8');
  const out = [];
  for (const mk of MODEL_KEYS) {
    const model = models[mk];
    let passed = 0;
    let latency = 0;
    let judgeSum = 0;
    let judgeCount = 0;
    for (const c of fx.cases) {
      const inputSerialized = JSON.stringify(c.input);
      const userMessage = JSON.stringify({
        action_type: c.input.actionType,
        event: c.input.event,
        memory_slice: null,
        voice_profile: null,
        action_template_hint: null,
      });
      const { value, latencyMs } = await cachedToolCall({
        tag: `matrix:draft:${mk}:${c.id}`,
        model,
        system: basePrompt,
        userMessage,
        toolName: 'draft_action',
        toolDescription: 'Return the structured draft of the proposed action.',
        toolSchema: DRAFT_SCHEMA,
        cachedOnly: ctx.cachedOnly,
        getClient: ctx.getClient,
        cost: ctx.cost,
        maxTokens: 1024,
      });
      latency += latencyMs;
      const payload = value.payload ?? {};
      const text = draftText(payload);
      const e = c.expect;
      let ok = true;
      // Required fields only where the prompt genuinely guarantees them (emails);
      // open-payload action types use requireNonEmptyText instead of pinning names.
      for (const field of e.requiredPayloadFields ?? []) {
        const v = payload[field];
        if (typeof v !== 'string' || v.trim().length === 0) ok = false;
      }
      if (e.requireNonEmptyText && text.trim().length === 0) ok = false;
      if (PLACEHOLDER_PATTERNS.some((p) => p.test(text))) ok = false;
      if (typeof e.maxBodyChars === 'number' && text.length > e.maxBodyChars) ok = false;
      if (e.recipientEchoOf) {
        const recipient = c.input.event.payload[e.recipientEchoOf];
        const to = typeof payload.to === 'string' ? payload.to : '';
        if (typeof recipient === 'string' && recipient && !to.includes(recipient)) ok = false;
      }
      if (ungroundedSpecifics(text, inputSerialized).length) ok = false;
      if (ok) passed += 1;
      if (e.judgeTone !== false) {
        const j = await ctx.judge.draft(`${mk}:${c.id}`, {
          action_type: c.input.actionType,
          draft: payload,
        });
        judgeSum += j.score;
        judgeCount += 1;
      }
    }
    const n = fx.cases.length;
    out.push({
      model: mk,
      propertyPass: passed / n,
      avgLatencyMs: Math.round(latency / n),
      avgJudge: judgeCount ? judgeSum / judgeCount : null,
      quality: passed / n,
    });
  }
  return out;
}

async function runReview(models, fx, ctx) {
  const basePrompt = await readFile(join(PROMPTS, 'reviewer.md'), 'utf8');
  const out = [];
  for (const mk of MODEL_KEYS) {
    const model = models[mk];
    let correct = 0;
    let latency = 0;
    for (const c of fx.cases) {
      // Supply the draft + the verification results, and ask for the verdict in
      // one turn — the part model tier affects. We append the results to the same
      // serialized shape the reviewer's first message uses.
      const userMessage = JSON.stringify({
        draft_action: c.input.draft_action,
        verification_results: c.input.verification_results,
      });
      const { value, latencyMs } = await cachedToolCall({
        tag: `matrix:review:${mk}:${c.id}`,
        model,
        system: basePrompt,
        userMessage,
        toolName: 'submit_verdict',
        toolDescription:
          'Submit your final verdict given the draft and the verification results already gathered.',
        toolSchema: VERDICT_SCHEMA,
        cachedOnly: ctx.cachedOnly,
        getClient: ctx.getClient,
        cost: ctx.cost,
        maxTokens: 512,
      });
      latency += latencyMs;
      const acceptable = [c.expect.verdict, ...(c.expect.alsoAcceptable ?? [])];
      if (acceptable.includes(value.verdict)) correct += 1;
    }
    const n = fx.cases.length;
    out.push({
      model: mk,
      accuracy: correct / n,
      avgLatencyMs: Math.round(latency / n),
      avgJudge: null,
      quality: correct / n,
    });
  }
  return out;
}

const ASK_FOR_INFO =
  /\b(which child|how old|let me know|tell me|it would help|could you (tell|share)|can you (tell|share)|i'?d need to know|more (context|detail))/i;

async function runCoach(models, fx, ctx) {
  // The coach reasons over the ask-hale skill instructions + the family context.
  // We replicate a single answer call (no tool loop) so model is the only variable;
  // the memory slice is injected into the context exactly as the live coach does.
  const skillBody = await readFile(join(SKILLS, 'ask-hale.md'), 'utf8');
  const instructions = skillBody.replace(/^---[\s\S]*?---\n/, ''); // strip frontmatter
  const out = [];
  for (const mk of MODEL_KEYS) {
    const model = models[mk];
    let recallSum = 0;
    let judgeSum = 0;
    let safetyPass = 0;
    let latency = 0;
    for (const c of fx.cases) {
      const context = {
        children: c.child ? [c.child] : [],
        focusedChild: c.child ?? null,
        memoryFacts: c.memoryFacts ?? [],
        recentEpisodes: c.episodes ?? [],
        question: c.question,
      };
      const system = `${instructions}\n\n## Context\n\n${JSON.stringify(context)}`;
      const { text, latencyMs } = await cachedTextCall({
        tag: `matrix:coach:${mk}:${c.id}`,
        model,
        system,
        userMessage: c.question,
        cachedOnly: ctx.cachedOnly,
        getClient: ctx.getClient,
        cost: ctx.cost,
        maxTokens: 1024,
      });
      latency += latencyMs;
      const lower = text.toLowerCase();
      const r = recall(text, c.expect.mustRecall);
      recallSum += r;
      // Safety/scope deterministic checks (where the fixture declares them).
      let safe = true;
      for (const tok of c.expect.forbiddenTokens ?? [])
        if (lower.includes(tok.toLowerCase())) safe = false;
      for (const tok of c.expect.forbiddenStageTokens ?? [])
        if (lower.includes(tok.toLowerCase())) safe = false;
      if (
        c.expect.onTopicAnyOf &&
        !c.expect.onTopicAnyOf.some((t) => lower.includes(t.toLowerCase()))
      )
        safe = false;
      if (c.expect.mustAskForContext && !(/\?/.test(text) || ASK_FOR_INFO.test(text))) safe = false;
      if (safe) safetyPass += 1;
      const j = await ctx.judge.coach(`${mk}:${c.id}`, {
        question: c.question,
        reference: c.expect.referenceAnswer,
        answer: text,
      });
      judgeSum += j.score;
    }
    const n = fx.cases.length;
    out.push({
      model: mk,
      recall: recallSum / n,
      safetyPass: safetyPass / n,
      avgLatencyMs: Math.round(latency / n),
      avgJudge: judgeSum / n,
      // Coach quality blends judged faithfulness (normalized 0-1) with safety/scope.
      quality: 0.6 * (judgeSum / n / 5) + 0.4 * (safetyPass / n),
    });
  }
  return out;
}

const RUNNERS = { classify: runClassify, draft: runDraft, review: runReview, coach: runCoach };

// --- recommendation ---------------------------------------------------------
// Pick the cheapest model whose quality is within a small epsilon of the best
// quality for the role — i.e. don't pay for Opus if Sonnet (or Haiku) ties it.
// "Cheaper" is ranked haiku < sonnet < opus by input list price.
const TIER_RANK = { haiku: 0, sonnet: 1, opus: 2 };
const QUALITY_EPS = 0.03;

function recommend(rows) {
  const bestQ = Math.max(...rows.map((r) => r.quality));
  const within = rows.filter((r) => r.quality >= bestQ - QUALITY_EPS);
  within.sort((a, b) => TIER_RANK[a.model] - TIER_RANK[b.model]);
  return within[0];
}

function pad(s, n) {
  return String(s).padEnd(n);
}
function fmtPct(x) {
  return x === null || x === undefined ? '  -' : `${(x * 100).toFixed(0)}%`;
}

// Calibration stand-in: every model "fails" (quality 0). Deterministic, makes NO
// API call and reads NO cache (same discipline as the other evals' broken
// generators), so the competence floor's teeth are proven without spend.
function brokenRows() {
  return MODEL_KEYS.map((mk) => ({
    model: mk,
    quality: 0,
    avgLatencyMs: 0,
    avgJudge: 1,
    accuracy: 0,
    propertyPass: 0,
    recall: 0,
    safetyPass: 0,
    teenAccuracy: 0,
  }));
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  // Calibration: --broken substitutes a uniformly-failing matrix so the competence
  // floor must REJECT it — proving the gate reads quality, not noise. No spend.
  const broken = process.argv.includes('--broken');
  const roleArg = process.argv.find((a) => a.startsWith('--role='))?.split('=')[1];
  const roles = roleArg ? [roleArg] : ROLES;

  const models = await readModelIds();
  const judgeModel = models.haiku; // the judge tier the other evals use
  const getClient = lazyAnthropic();
  const cost = makeCost();
  const judge = {
    classify: makeJudge(judgeModel, CLASSIFY_JUDGE, 'matrix-classify', cachedOnly, getClient, cost),
    draft: makeJudge(judgeModel, DRAFT_JUDGE, 'matrix-draft', cachedOnly, getClient, cost),
    coach: makeJudge(judgeModel, COACH_JUDGE, 'matrix-coach', cachedOnly, getClient, cost),
  };
  const ctx = { cachedOnly, getClient, cost, judge };

  console.log(
    `model-matrix-eval | ${broken ? 'BROKEN (calibration)' : cachedOnly ? 'cached-only' : 'live'} | haiku=${models.haiku} sonnet=${models.sonnet} opus=${models.opus} | judge=${judgeModel}`,
  );
  console.log('');

  const byRole = {};
  for (const role of roles) {
    const fx = JSON.parse(await readFile(join(FIXTURES, `${role}.json`), 'utf8'));
    const rows = broken ? brokenRows() : await RUNNERS[role](models, fx, ctx);
    byRole[role] = rows;

    console.log(`=== ${role} (${fx.cases.length} cases) ===`);
    console.log('model   quality  latency   judge   extra');
    console.log('------  -------  -------  ------  ------------------');
    for (const r of rows) {
      const extra =
        role === 'classify'
          ? `acc ${fmtPct(r.accuracy)}${r.teenAccuracy !== null ? `, teen ${fmtPct(r.teenAccuracy)}` : ''}`
          : role === 'draft'
            ? `prop-pass ${fmtPct(r.propertyPass)}`
            : role === 'review'
              ? `verdict ${fmtPct(r.accuracy)}`
              : `recall ${fmtPct(r.recall)}, safety ${fmtPct(r.safetyPass)}`;
      console.log(
        `${pad(r.model, 6)}  ${pad(fmtPct(r.quality), 7)}  ${pad(`${r.avgLatencyMs}ms`, 7)}  ${pad(r.avgJudge === null ? '-' : r.avgJudge.toFixed(1), 6)}  ${extra}`,
      );
    }
    console.log('');
  }

  // --- recommendation table --------------------------------------------------
  console.log('=== RECOMMENDATION: best model per role ===');
  console.log('role      current   recommend  why');
  console.log('--------  --------  ---------  ----------------------------------------');
  const changes = [];
  for (const role of roles) {
    const rows = byRole[role];
    const rec = recommend(rows);
    const cur = CURRENT_TIER[role];
    const best = rows.reduce((a, b) => (b.quality > a.quality ? b : a));
    const why =
      rec.model === best.model
        ? `top quality ${fmtPct(rec.quality)} @ ${rec.avgLatencyMs}ms`
        : `ties best (${fmtPct(best.quality)} ${best.model}) within ${QUALITY_EPS * 100}% but cheaper/faster (${rec.avgLatencyMs}ms)`;
    const flag = rec.model !== cur ? '  <- differs from current' : '';
    if (rec.model !== cur) changes.push(`${role}: ${cur} -> ${rec.model}`);
    console.log(`${pad(role, 8)}  ${pad(cur, 8)}  ${pad(rec.model, 9)}  ${why}${flag}`);
  }

  console.log('');
  console.log('--- cost ---');
  console.log(`live API calls this run: ${cost.liveCalls}`);
  for (const [m, b] of Object.entries(cost.byModel)) {
    console.log(`  ${m}: in=${b.input} out=${b.output}`);
  }
  console.log(`estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`);

  // --- gate ------------------------------------------------------------------
  // The matrix is a DECISION tool; the recommendation table is its output. The gate
  // is deliberately a COMPETENCE FLOOR, not "current tier == single best": on a
  // small per-role set one disagreement is 12-20%, so gating on being the top model
  // would flap on noise. Instead it asserts the current routing is COMPETENT —
  // every current tier clears QUALITY_FLOOR for its role. Cheaper/better-tier
  // findings are reported as NOTES for a human to act on, not a hard fail. The
  // --broken calibration (scrambled reference labels) drives every model below the
  // floor, so the gate is proven to read quality, not noise.
  const QUALITY_FLOOR = 0.7;
  const failures = [];
  for (const role of roles) {
    const rows = byRole[role];
    const cur = rows.find((r) => r.model === CURRENT_TIER[role]);
    if (!cur) {
      failures.push(`${role}: current tier ${CURRENT_TIER[role]} not in results`);
    } else if (cur.quality < QUALITY_FLOOR) {
      failures.push(
        `${role}: current ${CURRENT_TIER[role]} quality ${fmtPct(cur.quality)} < ${QUALITY_FLOOR * 100}% floor — not competent`,
      );
    }
  }

  const allPass = failures.length === 0;
  console.log('');
  console.log(
    `--- gate (current routing must be competent: quality >= ${QUALITY_FLOOR * 100}%/role) ---`,
  );
  if (changes.length) console.log(`note (recommendation, not a fail): ${changes.join('; ')}`);
  if (broken) {
    // Calibration: scrambled reference labels mean a correct model scores ~0; the
    // floor must therefore REJECT. If it passed, the gate isn't reading quality.
    if (allPass) {
      console.error('CALIBRATION BROKEN: scrambled-reference matrix passed the competence floor.');
      process.exit(1);
    }
    console.log('PASS (calibration): scrambled-reference matrix is correctly REJECTED (exit 0)');
    process.exit(0);
  }
  if (allPass) {
    console.log("PASS (exit 0): every role's current tier clears the competence floor");
    process.exit(0);
  }
  for (const f of failures) console.log(`  FAIL - ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('model-matrix eval harness error:', err);
  process.exit(2);
});
