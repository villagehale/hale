// One coach answer as several short iMessage bubbles · coach eval (hard rule #8: no LLM
// mocking).
//
// The subject is the REAL agent loop (`runAgent`) over the REAL coach skill, composed the
// way runtime.ts composes a lit 1:1 iMessage turn: coach-channel-sms as the cached prefix,
// then coach-nearby-find, coach-home-place and the coach-bubbles addendum (through the REAL
// `augmentCoachSkillForBubbles`) as the system extras. The answer then goes through the
// REAL post-processor and split (`toSmsBubbles`, `joinReplyBubbles`, `splitReplyBubbles`),
// so the bubbles graded are the bubbles the router would send, the offer `offer_full_plan`
// registered appended to the last one as runtime.ts appends it. Calendar and village tools
// are fixture stubs, `lookup_week` reading a case's events through the production week
// window (lib/fixture-week.mjs); `find_activities` is the real definition with a fixture
// result, and `promise_activity_followup`, `offer_full_plan` and `get_framework_guidance`
// are the real tools.
//
// Objective: the shape of the set and the tools a case must call (coach-bubbles-grade.mjs).
// Judge: the question, the language and the splitting, against each case's rubric. The
// judge is calibrated both ways first, on hand-written sets (median of three each).
//
// Each case is drawn three times with one judge call per draw, under the rule in
// lib/n-of-m.mjs, printed before any draw: a quality case passes on two of three, a
// `bar: 'safety'` case fails on any failed draw. Every draw is committed; a failed draw is
// never re-drawn.
//
//   node evals/run-coach-bubbles-eval.mjs --max-usd 3    # live, then caches
//   node evals/run-coach-bubbles-eval.mjs --cached-only  # CI: replay only
//   node evals/run-coach-bubbles-eval.mjs --dry          # price it, no calls

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { z } from 'zod';
import {
  COACH_BUBBLES_FIXTURES,
  COACH_BUBBLES_JUDGE_CALIBRATION,
  COACH_BUBBLES_NOW,
  COACH_BUBBLES_TIME_ZONE,
} from './coach-bubbles-fixtures.mjs';
import { bubbleShapeFailures } from './coach-bubbles-grade.mjs';
import { fixtureWeek } from './lib/fixture-week.mjs';
import {
  DRY_SUBJECT_PLAN,
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  cacheGet,
  cacheKey,
  cachePut,
  dryReportLine,
  dryRequestPlanEntry,
  dryStandInText,
  evalRunTag,
  evalSubjectRequest,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  noteUsage,
  readJudgeModel,
  totalUsd,
  withoutMessageCacheMarkers,
} from './lib/harness.mjs';
import { coachHelpLines } from './lib/coach-help-lines.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';
import {
  DRAWS,
  SAMPLING_RULE,
  drawPassed,
  drawTag,
  foldSubjectDraws,
  samplingBar,
} from './lib/n-of-m.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const COACH = join(WEB_ROOT, 'lib', 'channel', 'coach');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Mirrors MAX_STEPS / CHANNEL_COACH_MAX_TOKENS in apps/web/lib/channel/coach/runtime.ts. */
const MAX_STEPS = 6;
const MAX_TOKENS = 2000;

const JUDGE_SYSTEM = judgePrompt('coach-bubbles');

function contextFor(fixture, helpLines) {
  const transcript = [...(fixture.transcript ?? []), { role: 'user', content: fixture.text }];
  return {
    parentName: null,
    location: fixture.location,
    planTier: 'free',
    children: fixture.children,
    focusedChild: null,
    stages: fixture.children.map((child) => child.stage),
    memoryFacts: [],
    recentEpisodes: [],
    transcript,
    question: fixture.text,
    intent: null,
    sourceNote: null,
    channel: 'sms',
    nowIso: COACH_BUBBLES_NOW,
    standingQuestions: [],
    registrationWindows: [],
    helpLines,
  };
}

/** What `lookup_week` returns for a case: its events in the week asked for, on the family's
 * clock, and the Monday that week starts on. */
async function weekFor(fixture, input = {}) {
  const { weekStart, events } = await fixtureWeek(fixture.events ?? [], input, {
    now: COACH_BUBBLES_NOW,
    timeZone: COACH_BUBBLES_TIME_ZONE,
  });
  return { weekStart, result: { timeZone: COACH_BUBBLES_TIME_ZONE, events } };
}

function toolsFor(agent, linkRef, real, fixture, calls, turn, listed) {
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
      handler: async (input) => {
        calls.push('lookup_week');
        const week = await weekFor(fixture, input);
        turn.weeks.push(week);
        return week.result;
      },
    }),
    agent.defineTool({
      name: 'search_village',
      description:
        "Local classes, groups, and activities already discovered for THIS family's area. `candidates` are OFFERABLE: each carries a verified `venue` and `when`. Quote `title` as given. A candidate with a page carries `ref`.",
      inputSchema: passthrough(),
      handler: async () => {
        calls.push('search_village');
        // What the model sees: each page's ref, never its URL (coach/tools.ts).
        return {
          candidates: (fixture.village ?? []).map(({ url, ...candidate }) => ({
            ...candidate,
            ref: linkRef(url),
          })),
          inVerification: 0,
          standingOption: null,
        };
      },
    }),
    agent.defineTool({
      name: 'propose_calendar_move',
      description:
        'DRAFT a re-time of one existing event for the parent to approve. It does NOT move anything. `eventId` must come from lookup_week.',
      inputSchema: passthrough(),
      handler: async () => {
        calls.push('propose_calendar_move');
        return { drafted: true, actionId: 'action-1', newWhen: fixture.draftedWhen };
      },
    }),
    agent.defineTool({
      name: 'propose_calendar_add',
      description:
        "DRAFT a new item on the family's calendar for the parent to approve. Nothing is placed until they do.",
      inputSchema: passthrough(),
      handler: async () => {
        calls.push('propose_calendar_add');
        return { drafted: true, actionId: 'action-1', when: fixture.draftedWhen };
      },
    }),
    // The real definition (what the model reads) with the fixture's search result in the
    // shape the real handler returns. No picks unless the case says otherwise.
    {
      ...real.findActivitiesTool({ reader: {}, finder: {}, onPromise() {} }),
      handler: async () => {
        calls.push('find_activities');
        return fixture.web ?? { found: false, reason: 'no_picks' };
      },
    },
    // The real verbs: de-identification, the offer gate and its recompose loop all run.
    real.promiseActivityFollowUpTool({
      reader: { householdNames: async () => [] },
      onPromise(promise) {
        calls.push('promise_activity_followup');
        turn.promises.push(promise);
      },
    }),
    real.offerFullPlanTool((offer) => {
      calls.push('offer_full_plan');
      turn.offer = offer;
    }),
    (() => {
      // Canada, as every case's location says.
      const guidance = real.frameworkGuidanceTool('CA');
      return {
        ...guidance,
        handler: async (input, ctx) => {
          calls.push('get_framework_guidance');
          const result = await guidance.handler(input, ctx);
          turn.guidance.push(result);
          return result;
        },
      };
    })(),
  ];
  // Every other tool the skill lists, as an honest empty stub: this suite grades the bubbles.
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
        if (isDryRun()) {
          DRY_SUBJECT_PLAN.push({
            ...dryRequestPlanEntry(`${tag}:agent`, request),
            cached: Boolean(cached),
          });
          if (!cached) {
            return {
              id: 'dry',
              type: 'message',
              role: 'assistant',
              model: request.model,
              content: [{ type: 'text', text: dryStandInText(request.max_tokens ?? 1024) }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            };
          }
        }
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

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('coach-bubbles');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { augmentCoachSkillForBubbles } = await importTs(join(COACH, 'bubbles.ts'));
  const { joinReplyBubbles, splitReplyBubbles, toSmsBubbles } = await importTs(
    join(COACH, 'reply.ts'),
  );
  const { linkRef } = await importTs(join(COACH, 'activity-links.ts'));
  const { findActivitiesTool, promiseActivityFollowUpTool } = await importTs(
    join(WEB_ROOT, 'lib', 'channel', 'activity', 'tools.ts'),
  );
  const { offerFullPlanTool } = await importTs(
    join(WEB_ROOT, 'lib', 'channel', 'plan', 'offer.ts'),
  );
  const { frameworkGuidanceTool } = await importTs(
    join(WEB_ROOT, 'lib', 'coach', 'framework-tool.ts'),
  );
  const real = {
    findActivitiesTool,
    promiseActivityFollowUpTool,
    offerFullPlanTool,
    frameworkGuidanceTool,
  };
  const coach = await agent.loadSkill(join(SKILLS, 'coach-channel-sms.md'));
  const nearby = await agent.loadSkill(join(SKILLS, 'coach-nearby-find.md'));
  const homePlace = await agent.loadSkill(join(SKILLS, 'coach-home-place.md'));
  const bubbles = await agent.loadSkill(join(SKILLS, 'coach-bubbles.md'));
  const composed = augmentCoachSkillForBubbles(
    {
      ...coach,
      instructions: `${coach.instructions}\n\n${nearby.instructions}\n\n${homePlace.instructions}`,
    },
    bubbles,
  );
  // As runtime.ts sends it: the disk coach-channel-sms bytes are the cached prefix, and
  // everything appended to them rides as one system extra.
  const skill = { ...composed, instructions: coach.instructions };
  const systemExtras = [composed.instructions.slice(coach.instructions.length + 2)];

  const judgeModel = await readJudgeModel();
  const calibrationJudge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'coach-bubbles',
    cachedOnly,
    getClient,
    cost,
    { samples: JUDGE_SAMPLES_MEDIAN },
  );
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'coach-bubbles', cachedOnly, getClient, cost);

  console.log(
    `coach-bubbles eval${cachedOnly ? ' (cached-only)' : ''} | coach=${agent.pickModel(skill.meta.task)} judge=${judgeModel}`,
  );
  console.log(SAMPLING_RULE);
  // What the judge may hold the reply to. The week is what `lookup_week` returned, and only
  // when the turn read it: an empty week a turn read is a fact ("nothing else that
  // afternoon"), not an invention. A turn that read more than one week gets each, with
  // the Monday it starts on, so this week's empty read is not taken for next week's.
  const factsFor = (fixture, turn = { weeks: [], guidance: [] }) => ({
    now: COACH_BUBBLES_NOW,
    timeZone: COACH_BUBBLES_TIME_ZONE,
    children: fixture.children,
    village: (fixture.village ?? []).map(({ url, ...pick }) => pick),
    ...(turn.weeks.length === 1 ? { weekRead: turn.weeks[0].result } : {}),
    ...(turn.weeks.length > 1
      ? { weekRead: turn.weeks.map(({ weekStart, result }) => ({ weekStart, ...result })) }
      : {}),
    drafted: fixture.draftedWhen ?? null,
    ...(fixture.web ? { web: fixture.web } : {}),
    ...(turn.guidance.length > 0 ? { guidance: turn.guidance } : {}),
  });
  const byId = new Map(COACH_BUBBLES_FIXTURES.map((fixture) => [fixture.id, fixture]));

  // The judge first, on sets written by hand: a count lead-in must fail and the same answer
  // without it must pass, or the scores below mean nothing.
  const calibration = [];
  for (const row of COACH_BUBBLES_JUDGE_CALIBRATION) {
    const fixture = byId.get(row.fixture);
    const verdict = await calibrationJudge(row.id, {
      parentText: fixture.text,
      facts: factsFor(
        fixture,
        row.weekRead ? { weeks: [await weekFor(fixture)], guidance: [] } : undefined,
      ),
      rubric: fixture.rubric,
      bubbles: row.bubbles,
    });
    const passed = verdict.score >= JUDGE_MIN;
    const failures =
      verdict.dry || passed === (row.expect === 'pass')
        ? []
        : [`calibration: expected ${row.expect}, judge:${verdict.score} (${verdict.reason})`];
    calibration.push({ row, verdict, failures });
  }

  /** One draw of one case: what the router would send, its checks and its judge score. */
  async function drawOnce(fixture, draw) {
    const tag = drawTag(fixture.id, draw);
    const calls = [];
    const turn = { promises: [], offer: null, guidance: [], weeks: [] };
    const failures = [];
    const run = await agent.runAgent({
      skill,
      systemExtras,
      context: contextFor(fixture, await coachHelpLines(fixture.location)),
      tools: toolsFor(agent, linkRef, real, fixture, calls, turn, skill.meta.tools),
      client: cachedAgentClient(`coach-bubbles:${tag}`, cachedOnly, getClient, cost),
      maxSteps: MAX_STEPS,
      maxTokens: MAX_TOKENS,
      toolContext: { familyId: 'fixture-family', actor: 'fixture-parent' },
      guardDeps: {
        async writeAudit() {},
        async checkChildContentAccess() {
          return { ok: true, reason: 'ok' };
        },
      },
    });
    let sent = [];
    if (!run.answer) {
      failures.push(`no_answer after ${run.steps} steps`);
    } else {
      const activityLinks = (fixture.village ?? []).map(({ url }) => ({ ref: linkRef(url), url }));
      sent = splitReplyBubbles(
        joinReplyBubbles(
          toSmsBubbles(run.answer, {
            children: fixture.replyChildren ?? [],
            now: new Date(COACH_BUBBLES_NOW),
            activityLinks,
            ...(turn.offer ? { planOffer: turn.offer.sentence } : {}),
            bubbles: true,
          }),
        ),
      );
      failures.push(
        ...bubbleShapeFailures(sent, fixture, { calls, offer: turn.offer?.sentence ?? null }),
      );
    }
    const verdict = await judge(tag, {
      parentText: fixture.text,
      facts: factsFor(fixture, turn),
      rubric: fixture.rubric,
      bubbles: sent,
    });
    if (!verdict.dry && verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    const score = verdict.dry ? null : verdict.score;
    return { sent, calls, failures, score, passed: drawPassed({ failures, score }, JUDGE_MIN) };
  }

  const results = [];
  for (const fixture of COACH_BUBBLES_FIXTURES) {
    const draws = [];
    for (let draw = 0; draw < DRAWS; draw += 1) draws.push(await drawOnce(fixture, draw));
    results.push({ fixture, draws, failures: foldSubjectDraws(fixture, draws) });
  }

  for (const c of calibration) {
    console.log(
      `${c.failures.length === 0 ? 'PASS' : 'FAIL'}  ${c.row.id.padEnd(24)} expect=${c.row.expect} judge=${c.verdict.score}`,
    );
    for (const f of c.failures) console.log(`      · ${f}`);
  }
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(24)} bar=${samplingBar(r.fixture)} judge=${r.draws.map((d) => d.score ?? '-').join('/')}`,
    );
    r.draws.forEach((d, at) => {
      console.log(
        `      reply ${at + 1} ${d.passed ? 'pass' : 'FAIL'} calls=[${d.calls.join(',')}] bubbles=${JSON.stringify(d.sent)}`,
      );
      for (const f of d.failures) console.log(`        - ${f}`);
    });
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('coach-bubbles', [calibrationJudge.plan, judge.plan]));
    process.exit(0);
  }
  process.exit([...calibration, ...results].every((r) => r.failures.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error('coach-bubbles eval harness error:', err);
  process.exit(2);
});
