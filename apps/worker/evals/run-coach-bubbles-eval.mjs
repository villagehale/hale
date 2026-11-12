// One coach answer as several short iMessage bubbles · coach eval (hard rule #8: no LLM
// mocking).
//
// The subject is the REAL agent loop (`runAgent`) over the REAL coach skill, composed the
// way runtime.ts composes a lit 1:1 iMessage turn: coach-channel-sms as the cached prefix,
// then coach-nearby-find, coach-home-place and the coach-bubbles addendum (through the REAL
// `augmentCoachSkillForBubbles`) as the system extras. The answer then goes through the
// REAL post-processor and split (`toSmsBubbles`, `joinReplyBubbles`, `splitReplyBubbles`),
// so the bubbles graded are the bubbles the router would send. Tools are fixture stubs.
//
// Objective: the shape of the set (coach-bubbles-grade.mjs). Judge (median of three): the
// question, the language and the splitting, against each case's rubric.
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
  COACH_BUBBLES_NOW,
  COACH_BUBBLES_TIME_ZONE,
} from './coach-bubbles-fixtures.mjs';
import { bubbleShapeFailures } from './coach-bubbles-grade.mjs';
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

/** Mirrors MAX_STEPS / CHANNEL_COACH_MAX_TOKENS in apps/web/lib/channel/coach/runtime.ts. */
const MAX_STEPS = 6;
const MAX_TOKENS = 2000;

const JUDGE_SYSTEM = judgePrompt('coach-bubbles');

function contextFor(fixture) {
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
  };
}

function toolsFor(agent, linkRef, fixture, calls, listed) {
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
        return { timeZone: COACH_BUBBLES_TIME_ZONE, events: fixture.events ?? [] };
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
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'coach-bubbles', cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES_MEDIAN,
  });

  console.log(
    `coach-bubbles eval${cachedOnly ? ' (cached-only)' : ''} | coach=${agent.pickModel(skill.meta.task)} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of COACH_BUBBLES_FIXTURES) {
    const calls = [];
    const failures = [];
    const run = await agent.runAgent({
      skill,
      systemExtras,
      context: contextFor(fixture),
      tools: toolsFor(agent, linkRef, fixture, calls, skill.meta.tools),
      client: cachedAgentClient(`coach-bubbles:${fixture.id}`, cachedOnly, getClient, cost),
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
            bubbles: true,
          }),
        ),
      );
      failures.push(...bubbleShapeFailures(sent, fixture));
    }
    const verdict = await judge(fixture.id, {
      parentText: fixture.text,
      facts: {
        now: COACH_BUBBLES_NOW,
        timeZone: COACH_BUBBLES_TIME_ZONE,
        children: fixture.children,
        village: (fixture.village ?? []).map(({ url, ...pick }) => pick),
        events: fixture.events ?? [],
        drafted: fixture.draftedWhen ?? null,
      },
      rubric: fixture.rubric,
      bubbles: sent,
    });
    if (!verdict.dry && verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, sent, calls, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(24)} calls=[${r.calls.join(',')}] bubbles=${JSON.stringify(r.sent)}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('coach-bubbles', [judge.plan]));
    process.exit(0);
  }
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error('coach-bubbles eval harness error:', err);
  process.exit(2);
});
