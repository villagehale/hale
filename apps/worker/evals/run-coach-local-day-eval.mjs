// The family-local day · coach eval (VIL-435, hard rule #8: no LLM mocking).
//
// The subject is the REAL agent loop (`runAgent`) over the REAL coach skill, composed the
// way runtime.ts composes a 1:1 nearby-find turn: coach-channel-sms + coach-nearby-find +
// coach-home-place, then coach-find-private when `nearbyFindTurn` says so, then the
// coach-local-day addendum through the REAL `augmentCoachSkillForLocalDay`. The day facts come from the
// REAL `familyLocalNow` and `localDayContext`, and `find_activities` is the REAL tool
// over a fixture finder (the live web search is not what this suite grades). A judge
// reads each reply against the case's rubric, by meaning; nothing here matches words.
//
//   node evals/run-coach-local-day-eval.mjs --max-usd 1.5   # live, then caches
//   node evals/run-coach-local-day-eval.mjs --broken        # calibration: must FAIL
//   node evals/run-coach-local-day-eval.mjs --cached-only   # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { z } from 'zod';
import { COACH_LOCAL_DAY_FIXTURES } from './coach-local-day-fixtures.mjs';
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
import { judgePrompt } from './lib/judge-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const COACH = join(WEB_ROOT, 'lib', 'channel', 'coach');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Mirrors MAX_STEPS / MAX_TOKENS in apps/web/lib/channel/coach/runtime.ts. */
const MAX_STEPS = 6;
const MAX_TOKENS = 400;

const JUDGE_SYSTEM = judgePrompt('coach-local-day');

function contextFor(fixture, localDay) {
  return {
    parentName: null,
    location: fixture.location,
    planTier: 'free',
    children: [fixture.child],
    focusedChild: null,
    stages: [fixture.child.stage],
    memoryFacts: [],
    recentEpisodes: [],
    transcript: [{ role: 'user', content: fixture.text }],
    question: fixture.text,
    intent: null,
    sourceNote: null,
    channel: 'sms',
    nowIso: fixture.now,
    ...localDay,
    standingQuestions: [],
    registrationWindows: [],
  };
}

function weekOf(fixture, familyLocalNow) {
  const start = new Date(fixture.now);
  return Array.from({ length: 7 }, (_, offset) => {
    const day = familyLocalNow(new Date(start.getTime() + offset * 86_400_000), fixture.timeZone);
    return { date: day.date, weekday: day.weekday };
  });
}

function toolsFor(agent, findActivitiesTool, familyLocalNow, fixture, calls, listed) {
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
  const finder = {
    async find() {
      calls.push('find_activities');
      return { found: true, picks: fixture.picks };
    },
  };
  const tools = [
    agent.defineTool({
      name: 'lookup_week',
      description:
        "THIS family's week: `days` (the seven dates with their weekdays) and every calendar item. weekOffset 0 is the current week.",
      inputSchema: passthrough(),
      handler: async () => {
        calls.push('lookup_week');
        return { timeZone: fixture.timeZone, days: weekOf(fixture, familyLocalNow), events: [] };
      },
    }),
    stub('search_village', { candidates: [], inVerification: 0, standingOption: null }),
    findActivitiesTool({
      reader: {
        place: async () => ({ status: 'known', town: fixture.location.city }),
        stage: async () => fixture.child.stage,
        householdNames: async () => [],
      },
      finder,
      onPromise: () => {},
    }),
  ];
  // Every other tool the skill lists, as an honest empty stub: this suite grades the day.
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
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('coach-local-day');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { augmentCoachSkillForLocalDay, localDayContext } = await importTs(
    join(COACH, 'local-day.ts'),
  );
  const { familyLocalNow } = await importTs(join(COACH, 'local-now.ts'));
  const { augmentCoachSkillForFindPrivate, nearbyFindTurn } = await importTs(
    join(COACH, 'find-private.ts'),
  );
  const { findActivitiesTool } = await importTs(
    join(WEB_ROOT, 'lib', 'channel', 'activity', 'tools.ts'),
  );
  const coach = await agent.loadSkill(join(SKILLS, 'coach-channel-sms.md'));
  const nearby = await agent.loadSkill(join(SKILLS, 'coach-nearby-find.md'));
  const homePlace = await agent.loadSkill(join(SKILLS, 'coach-home-place.md'));
  const findPrivate = await agent.loadSkill(join(SKILLS, 'coach-find-private.md'));
  const localDaySkill = await agent.loadSkill(join(SKILLS, 'coach-local-day.md'));
  // Production appends nearby-find then home-place on every channel turn (VIL-542).
  const base = {
    ...coach,
    instructions: `${coach.instructions}\n\n${nearby.instructions}\n\n${homePlace.instructions}`,
  };
  const judgeModel = await readJudgeModel('sonnet');
  // Median of three on the real replies (one tail draw must not decide a case); the
  // broken replies are a one-off calibration of the rubric, so one draw each.
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'coach-local-day',
    cachedOnly,
    getClient,
    cost,
    {
      samples: broken ? 1 : JUDGE_SAMPLES_MEDIAN,
    },
  );

  console.log(
    `coach-local-day eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | coach=${agent.pickModel(base.meta.task)} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of COACH_LOCAL_DAY_FIXTURES) {
    const calls = [];
    const failures = [];
    const localNow = familyLocalNow(new Date(fixture.now), fixture.timeZone);
    const localDay = localDayContext(localNow, fixture.forecast);
    const transcript = [{ role: 'user', content: fixture.text }];
    const composed = augmentCoachSkillForLocalDay(
      augmentCoachSkillForFindPrivate(
        base,
        nearbyFindTurn(fixture.text, transcript) ? findPrivate : null,
      ),
      localDaySkill,
    );
    const extraText = composed.instructions.startsWith(`${base.instructions}\n\n`)
      ? composed.instructions.slice(base.instructions.length + 2)
      : '';
    const skill = extraText
      ? { ...composed, instructions: base.instructions }
      : composed;
    let reply = fixture.broken;
    if (!broken) {
      const run = await agent.runAgent({
        skill,
        ...(extraText ? { systemExtras: [extraText] } : {}),
        context: contextFor(fixture, localDay),
        tools: toolsFor(
          agent,
          findActivitiesTool,
          familyLocalNow,
          fixture,
          calls,
          skill.meta.tools,
        ),
        client: cachedAgentClient(`coach-local-day:${fixture.id}`, cachedOnly, getClient, cost),
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
      reply = run.answer ?? '';
      if (!run.answer)
        failures.push(`no_answer after ${run.steps} steps (calls: ${calls.join(', ') || 'none'})`);
    }
    const verdict = await judge(fixture.id, {
      parentText: fixture.text,
      facts: {
        localNow,
        location: fixture.location,
        // The coach holds the child's age (contextFor); a judge without it grades a
        // correct "fits your 26-month-old" as an invented family detail.
        children: [fixture.child],
        forecast: fixture.forecast,
        picks: fixture.picks.map(({ url, ...pick }) => pick),
      },
      rubric: fixture.rubric,
      reply,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, reply, calls, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(24)} calls=[${r.calls.join(',')}] "${r.reply.replace(/\s+/g, ' ')}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('coach-local-day', [judge.plan]));
    process.exit(0);
  }
  if (!broken) process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
  // Calibration: EVERY broken reply must fail its own rubric, not just one of them.
  const allFail = results.every((r) => r.failures.length > 0);
  console.log(`broken-mode calibration (every case must fail): ${allFail ? 'PASS' : 'FAIL'}`);
  process.exit(allFail ? 0 : 1);
}

main().catch((err) => {
  console.error('coach-local-day eval harness error:', err);
  process.exit(2);
});
