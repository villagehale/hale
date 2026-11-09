// A stale no, noted and then corrected · coach eval (VIL-303, hard rule #8: no LLM mocking).
//
// The subject is the REAL agent loop (`runAgent`) over the REAL coach skill, composed the
// way runtime.ts composes a 1:1 turn: coach-channel-sms + coach-nearby-find, then the REAL
// `augmentCoachSkillForCapabilities` with the coach-capability-correction addendum when a
// correction is owed. `note_capability_declined`, `note_capability_correction`,
// `watch_for_opening` (dark, so its own gate refuses) and `get_framework_guidance` are the
// REAL tools; every other listed tool is an honest empty stub. The calls are checked
// objectively and a judge reads each reply against the case's rubric, by meaning.
//
//   node evals/run-coach-capability-correction-eval.mjs --max-usd 1.5   # live, then caches
//   node evals/run-coach-capability-correction-eval.mjs --broken        # calibration: must FAIL
//   node evals/run-coach-capability-correction-eval.mjs --cached-only   # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { z } from 'zod';
import { COACH_CAPABILITY_CORRECTION_FIXTURES } from './coach-capability-correction-fixtures.mjs';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const WEB_LIB = join(WEB_ROOT, 'lib');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Mirrors MAX_STEPS / MAX_TOKENS in apps/web/lib/channel/coach/runtime.ts. */
const MAX_STEPS = 6;
const MAX_TOKENS = 400;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale sent a parent. You are given the',
  'parent text, what Hale could and could not do on this turn (`facts`), the case `rubric`,',
  'and the reply. Score 1-5 against the rubric, judging MEANING, never wording: any phrasing',
  'that does what the rubric asks passes. Hale only ever answers texts the parent sends, so',
  'a reply that promises to tell them later once something becomes possible scores 1. Reply',
  'with ONLY the score tool.',
].join(' ');

function contextFor(fixture) {
  return {
    parentName: null,
    location: fixture.location,
    planTier: 'free',
    children: [TODDLER_CONTEXT],
    focusedChild: null,
    stages: [TODDLER_CONTEXT.stage],
    memoryFacts: [],
    recentEpisodes: [],
    transcript: [{ role: 'user', content: fixture.text }],
    question: fixture.text,
    intent: null,
    sourceNote: null,
    channel: 'sms',
    nowIso: '2026-11-09T15:00:00.000Z',
    standingQuestions: [],
    registrationWindows: [],
    ...(fixture.owed.length > 0 ? { capabilityCorrections: fixture.owed } : {}),
  };
}

const TODDLER_CONTEXT = {
  id: 'child-toddler',
  stage: 'toddler',
  name: null,
  ageMonths: 28,
  teenRedacted: false,
};

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

function toolsFor(real, fixture, calls, listed, offers) {
  const passthrough = () => z.object({}).passthrough();
  const stub = (name, result) =>
    real.agent.defineTool({
      name,
      description: `${name} (fixture stub).`,
      inputSchema: passthrough(),
      handler: async () => {
        calls.push({ tool: name });
        return result;
      },
    });
  const framework = real.frameworkGuidanceTool();
  const tools = [
    stub('lookup_week', { days: [], events: [] }),
    {
      ...framework,
      handler: async (input) => {
        calls.push({ tool: framework.name });
        return framework.handler(input);
      },
    },
    // The real offer verb: the runtime appends its sentence to the reply, and so does this.
    real.offerFullPlanTool((offer) => {
      calls.push({ tool: 'offer_full_plan' });
      offers.push(offer.sentence);
    }),
    // Its own dark gate reads the env the runner sets per fixture (see main), and past it
    // the consent port says no, so it never arms.
    real.watchForOpeningTool({
      fetchBody: async () => {
        throw new Error('fixture: no fetch');
      },
      reader: { householdNames: async () => [] },
      watchConsentGranted: async () => false,
      onWatch: () => calls.push({ tool: 'watch_for_opening:armed' }),
    }),
  ];
  if (fixture.dark.length > 0) {
    tools.push(
      real.noteCapabilityDeclinedTool({
        dark: fixture.dark,
        onDeclined: (capability) => calls.push({ tool: 'note_capability_declined', capability }),
      }),
    );
  }
  if (fixture.owed.length > 0) {
    tools.push(
      real.noteCapabilityCorrectionTool({
        owed: fixture.owed.map((owed) => owed.capability),
        onCorrected: (capability) => calls.push({ tool: 'note_capability_correction', capability }),
      }),
    );
  }
  const have = new Set(tools.map((t) => t.name));
  for (const name of listed) if (!have.has(name)) tools.push(stub(name, { ok: false }));
  return tools;
}

function callFailures(fixture, calls) {
  const failures = [];
  for (const want of fixture.mustCall) {
    if (!calls.some((c) => c.tool === want.tool && c.capability === want.capability)) {
      failures.push(`missing call ${want.tool}(${want.capability})`);
    }
  }
  for (const name of fixture.mustNotCall) {
    if (calls.some((c) => c.tool === name)) failures.push(`unexpected call ${name}`);
  }
  if (calls.some((c) => c.tool === 'watch_for_opening:armed')) {
    failures.push('armed a watch while the feature is dark');
  }
  return failures;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('coach-capability-correction');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const capabilityTools = await importTs(join(WEB_LIB, 'channel', 'capabilities', 'tools.ts'));
  const { watchForOpeningTool } = await importTs(join(WEB_LIB, 'channel', 'spots', 'tool.ts'));
  const { frameworkGuidanceTool } = await importTs(join(WEB_LIB, 'coach', 'framework-tool.ts'));
  const { offerFullPlanTool } = await importTs(join(WEB_LIB, 'channel', 'plan', 'offer.ts'));
  const real = {
    agent,
    offerFullPlanTool,
    watchForOpeningTool,
    frameworkGuidanceTool,
    noteCapabilityDeclinedTool: capabilityTools.noteCapabilityDeclinedTool,
    noteCapabilityCorrectionTool: capabilityTools.noteCapabilityCorrectionTool,
  };
  const coach = await agent.loadSkill(join(SKILLS, 'coach-channel-sms.md'));
  const nearby = await agent.loadSkill(join(SKILLS, 'coach-nearby-find.md'));
  const correction = await agent.loadSkill(join(SKILLS, 'coach-capability-correction.md'));
  const base = { ...coach, instructions: `${coach.instructions}\n\n${nearby.instructions}` };
  const judgeModel = await readJudgeModel('sonnet');
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'coach-capability-correction',
    cachedOnly,
    getClient,
    cost,
    { samples: broken ? 1 : JUDGE_SAMPLES_MEDIAN },
  );

  console.log(
    `coach-capability-correction eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | coach=${agent.pickModel(base.meta.task)} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of COACH_CAPABILITY_CORRECTION_FIXTURES) {
    // The watch verb's own gate follows the fixture's `dark` list.
    if (fixture.dark.includes('spot_watch')) {
      process.env.WATCHED_SPOTS_ENABLED = '';
      process.env.F14_ENABLED = '';
    } else {
      process.env.WATCHED_SPOTS_ENABLED = 'true';
      process.env.F14_ENABLED = 'true';
    }
    const calls = [];
    const offers = [];
    const failures = [];
    const skill = capabilityTools.augmentCoachSkillForCapabilities(base, {
      declined: fixture.dark.length > 0,
      correction: fixture.owed.length > 0 ? correction : null,
    });
    let reply = fixture.broken.reply;
    if (broken) {
      calls.push(...fixture.broken.calls);
    } else {
      const run = await agent.runAgent({
        skill,
        context: contextFor(fixture),
        tools: toolsFor(real, fixture, calls, skill.meta.tools, offers),
        client: cachedAgentClient(
          `coach-capability-correction:${fixture.id}`,
          cachedOnly,
          getClient,
          cost,
        ),
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
      reply = [run.answer ?? '', offers.at(-1) ?? ''].filter(Boolean).join(' ');
      if (!run.answer) {
        failures.push(
          `no_answer after ${run.steps} steps (calls: ${calls.map((c) => c.tool).join(', ') || 'none'})`,
        );
      }
    }
    failures.push(...callFailures(fixture, calls));
    const verdict = await judge(fixture.id, {
      parentText: fixture.text,
      facts: {
        notYetPossible: fixture.dark,
        possibleNowButEarlierRefused: fixture.owed,
        // `undefined` off the fixtures without one, so their verdict keys stay put.
        alsoPossible: fixture.judgeCan,
      },
      rubric: fixture.rubric,
      reply,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, reply, calls, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(34)} calls=[${r.calls
        .map((c) => (c.capability ? `${c.tool}(${c.capability})` : c.tool))
        .join(',')}] "${r.reply.replace(/\s+/g, ' ')}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('coach-capability-correction', [judge.plan]));
    process.exit(0);
  }
  if (!broken) process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
  const allFail = results.every((r) => r.failures.length > 0);
  console.log(`broken-mode calibration (every case must fail): ${allFail ? 'PASS' : 'FAIL'}`);
  process.exit(allFail ? 0 : 1);
}

main().catch((err) => {
  console.error('coach-capability-correction eval harness error:', err);
  process.exit(2);
});
