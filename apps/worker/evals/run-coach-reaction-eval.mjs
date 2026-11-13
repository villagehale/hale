// VIL-680 · the model chooses the tapback · coach eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL agent loop (`runAgent`) over the REAL coach skill, composed the
// way runtime.ts composes a 1:1 iMessage turn lit for reactions: coach-channel-sms as the
// cached prefix, then coach-nearby-find, coach-home-place and the coach-reaction addendum
// (through the REAL `augmentCoachSkillForReactions`) as the system extras, with the REAL
// `react_to_parent_message` verb and the REAL count of the turn's other tools
// (`isOtherToolCall`). The case with a watch running gets the REAL `stop_watching` over
// fixture ports. Every other tool the skill lists is an honest empty stub.
//
// Objective: the REAL `planParentReaction` over the model's choice lands where the case
// says, and the model wrote its reply. Judge: what the parent actually gets (the tapback,
// the words, or both) against the case's situation. The judge is calibrated both ways
// first, on hand-written outcomes (median of three each).
//
// One draw per case, recorded once. A failed draw is a finding and is never re-drawn.
//
//   node evals/run-coach-reaction-eval.mjs --max-usd 3               # live, then caches
//   node evals/run-coach-reaction-eval.mjs --cached-only             # CI: replay only
//   node evals/run-coach-reaction-eval.mjs --cached-only --broken    # known-bad must FAIL

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { z } from 'zod';
import {
  COACH_REACTION_BROKEN_CHOICE,
  COACH_REACTION_CHILD,
  COACH_REACTION_FIXTURES,
  COACH_REACTION_JUDGE_CALIBRATION,
  COACH_REACTION_NOW,
  COACH_REACTION_WATCH,
} from './coach-reaction-fixtures.mjs';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  cacheGet,
  cacheKey,
  cachePut,
  evalRunTag,
  evalSubjectRequest,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  noteUsage,
  readJudgeModel,
  totalUsd,
  withoutMessageCacheMarkers,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const CHANNEL = join(WEB_ROOT, 'lib', 'channel');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Mirrors MAX_STEPS / CHANNEL_COACH_MAX_TOKENS in apps/web/lib/channel/coach/runtime.ts. */
const MAX_STEPS = 6;
const MAX_TOKENS = 2000;

const JUDGE_SYSTEM = judgePrompt('coach-reaction');

function contextFor(fixture) {
  return {
    parentName: null,
    location: { city: 'Toronto', province: 'ON', country: 'CA' },
    planTier: 'free',
    children: [COACH_REACTION_CHILD],
    focusedChild: null,
    stages: [COACH_REACTION_CHILD.stage],
    memoryFacts: [],
    recentEpisodes: [],
    transcript: [...fixture.earlier, { role: 'user', content: fixture.text }],
    question: fixture.text,
    intent: null,
    sourceNote: null,
    channel: 'sms',
    nowIso: COACH_REACTION_NOW,
    standingQuestions: [],
    registrationWindows: [],
  };
}

function toolsFor(agent, real, fixture, calls, listed, onReact) {
  const passthrough = () => z.object({}).passthrough();
  const stub = (name, result) =>
    agent.defineTool({
      name,
      description: `${name} (fixture stub).`,
      inputSchema: passthrough(),
      handler: async () => {
        calls.push(name);
        return result;
      },
    });
  const tools = [
    agent.defineTool({
      name: 'lookup_week',
      description: "THIS family's week: every calendar item. weekOffset 0 is the current week.",
      inputSchema: passthrough(),
      handler: async () => {
        calls.push('lookup_week');
        return { timeZone: 'America/Toronto', events: fixture.events };
      },
    }),
    real.reactToParentMessageTool({
      onReact: (choice) => {
        calls.push('react_to_parent_message');
        onReact(choice);
      },
    }),
  ];
  if (fixture.watching) {
    const stop = real.stopWatchingTool({
      liveWatches: async () => [COACH_REACTION_WATCH],
      release: async () => true,
    });
    tools.push({
      ...stop,
      handler: async (input, ctx) => {
        calls.push('stop_watching');
        return stop.handler(input, ctx);
      },
    });
  }
  // Every other tool the skill lists, as an honest empty stub: this suite grades the choice.
  const have = new Set(tools.map((t) => t.name));
  for (const name of listed) if (!have.has(name)) tools.push(stub(name, { ok: false }));
  return tools;
}

function cachedAgentClient(tag, cachedOnly, getClient, cost) {
  return {
    messages: {
      async create(params) {
        const request = evalSubjectRequest(params);
        const canonical = JSON.stringify({
          model: request.model,
          system: request.system,
          tools: request.tools,
          messages: withoutMessageCacheMarkers(request.messages),
          max_tokens: request.max_tokens,
          thinking: request.thinking,
          output_config: request.output_config,
        });
        const key = cacheKey(evalRunTag(`${tag}:agent`), canonical);
        const cached = await cacheGet(key);
        if (cached) return cached.response;
        if (cachedOnly) {
          console.error(`agent cache miss in --cached-only mode (${tag}, key ${key}).`);
          process.exit(1);
        }
        const response = await getClient().messages.create(request);
        noteUsage(cost, request.model, response.usage);
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

/** How the judge reads a tapback: a standard name, or the one emoji. */
function tapbackName(reaction) {
  return reaction.type === 'custom' ? reaction.emoji : reaction.type;
}

/** What the parent gets, for the judge, from the plan the router would act on. */
function judgePayload(fixture, outcome) {
  return {
    earlier: fixture.earlier,
    parentText: fixture.text,
    arrivedMedia: [],
    reply: outcome.reply,
    tapback: outcome.tapback,
    sent: outcome.sent,
    situation: fixture.situation,
  };
}

function outcomeOf(plan, reply) {
  if (plan.kind === 'none') return { reply, tapback: null, sent: 'reply_only' };
  return {
    reply,
    tapback: tapbackName(plan.reaction),
    sent: plan.kind === 'alone' ? 'tapback_only' : 'tapback_and_reply',
  };
}

function expectationFailures(fixture, plan) {
  if (fixture.expect === 'alone' && plan.kind !== 'alone') {
    return [`expected the tapback alone, the plan was ${describe(plan)}`];
  }
  if (fixture.expect === 'not_alone' && plan.kind === 'alone') {
    return [`expected the words to go, the plan was ${describe(plan)}`];
  }
  return [];
}

function describe(plan) {
  if (plan.kind === 'none') return `none (${plan.reason})`;
  if (plan.kind === 'beside') return `beside (${plan.why}) ${tapbackName(plan.reaction)}`;
  return `alone ${tapbackName(plan.reaction)}`;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const broken = process.argv.includes('--broken');
  if (broken && !cachedOnly) {
    console.error('coach-reaction: --broken replays the cache; pass it with --cached-only.');
    process.exit(2);
  }
  installEvalSpendCap();
  const getClient = lazyAnthropic('coach-reaction');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const reactionTool = await importTs(join(CHANNEL, 'coach', 'reaction-tool.ts'));
  const { planParentReaction } = await importTs(join(CHANNEL, 'router', 'reaction-plan.ts'));
  const { readParentReaction } = await importTs(join(CHANNEL, 'linq', 'tapback.ts'));
  const { augmentCoachSkillForStopWatching, stopWatchingTool } = await importTs(
    join(CHANNEL, 'spots', 'stop-tool.ts'),
  );
  const real = {
    reactToParentMessageTool: reactionTool.reactToParentMessageTool,
    stopWatchingTool,
  };
  const coach = await agent.loadSkill(join(SKILLS, 'coach-channel-sms.md'));
  const nearby = await agent.loadSkill(join(SKILLS, 'coach-nearby-find.md'));
  const homePlace = await agent.loadSkill(join(SKILLS, 'coach-home-place.md'));
  const reaction = await agent.loadSkill(join(SKILLS, 'coach-reaction.md'));
  const composed = reactionTool.augmentCoachSkillForReactions(
    {
      ...coach,
      instructions: `${coach.instructions}\n\n${nearby.instructions}\n\n${homePlace.instructions}`,
    },
    reaction,
  );
  // As runtime.ts sends it: the disk coach-channel-sms bytes are the cached prefix, and
  // everything appended to them rides as one system extra.
  const systemExtras = [composed.instructions.slice(coach.instructions.length + 2)];
  const skillFor = (fixture) => ({
    ...augmentCoachSkillForStopWatching(composed, fixture.watching === true),
    instructions: coach.instructions,
  });

  const judgeModel = await readJudgeModel();
  const calibrationJudge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'coach-reaction',
    cachedOnly,
    getClient,
    cost,
    { samples: JUDGE_SAMPLES_MEDIAN },
  );
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'coach-reaction', cachedOnly, getClient, cost);

  console.info(
    `coach-reaction eval${cachedOnly ? ' (cached-only)' : ''}${broken ? ' --broken' : ''} | coach=${agent.pickModel(composed.meta.task)} judge=${judgeModel}`,
  );
  const byId = new Map(COACH_REACTION_FIXTURES.map((fixture) => [fixture.id, fixture]));

  const calibration = [];
  if (!broken) {
    for (const row of COACH_REACTION_JUDGE_CALIBRATION) {
      const fixture = byId.get(row.fixture);
      const verdict = await calibrationJudge(
        row.id,
        judgePayload(fixture, { reply: row.reply, tapback: row.tapback, sent: row.sent }),
      );
      const passed = verdict.score >= JUDGE_MIN;
      const failures =
        passed === (row.expect === 'pass')
          ? []
          : [`calibration: expected ${row.expect}, judge:${verdict.score} (${verdict.reason})`];
      calibration.push({ row, verdict, failures });
    }
  }

  const results = [];
  for (const fixture of COACH_REACTION_FIXTURES) {
    const calls = [];
    const failures = [];
    let choice = null;
    let otherToolCalls = 0;
    const skill = skillFor(fixture);
    const run = await agent.runAgent({
      skill,
      systemExtras,
      context: contextFor(fixture),
      tools: toolsFor(agent, real, fixture, calls, skill.meta.tools, (chosen) => {
        choice = chosen;
      }),
      client: cachedAgentClient(`coach-reaction:${fixture.id}`, cachedOnly, getClient, cost),
      maxSteps: MAX_STEPS,
      maxTokens: MAX_TOKENS,
      toolContext: { familyId: 'fixture-family', actor: 'fixture-parent' },
      guardDeps: {
        async writeAudit(entry) {
          if (reactionTool.isOtherToolCall(entry.actionTaken)) otherToolCalls += 1;
        },
        async checkChildContentAccess() {
          return { ok: true, reason: 'ok' };
        },
      },
    });
    const reply = run.answer ?? '';
    if (!run.answer) failures.push(`no_answer after ${run.steps} steps`);
    // --broken: the recorded turn, with a thumbs-up as the whole answer in its place.
    const chosen = broken
      ? {
          reaction: readParentReaction(COACH_REACTION_BROKEN_CHOICE.reaction),
          alone: COACH_REACTION_BROKEN_CHOICE.alone,
        }
      : choice;
    const plan = planParentReaction({
      choice: chosen ? { ...chosen, otherToolCalls } : null,
      voiceMemo: false,
      attempts: 1,
      mints: 0,
      unplacedAnswer: false,
      bubbles: [reply],
    });
    failures.push(...expectationFailures(fixture, plan));
    if (!broken) {
      const verdict = await judge(fixture.id, judgePayload(fixture, outcomeOf(plan, reply)));
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, reply, calls, plan, failures });
  }

  for (const c of calibration) {
    console.info(
      `${c.failures.length === 0 ? 'PASS' : 'FAIL'}  ${c.row.id.padEnd(24)} judge:${c.verdict.score} of ${(c.verdict.samples ?? []).join('/')}`,
    );
    for (const f of c.failures) console.info(`      · ${f}`);
  }
  for (const r of results) {
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(24)} plan=${describe(r.plan)} calls=[${r.calls.join(',')}] "${r.reply.replace(/\s+/g, ' ')}"`,
    );
    for (const f of r.failures) console.info(`      · ${f}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const ok = [...calibration, ...results].every((r) => r.failures.length === 0);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('coach-reaction eval harness error:', err);
  process.exit(2);
});
