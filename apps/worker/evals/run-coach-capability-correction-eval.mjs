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
// `signup` cases run as runtime.ts runs a turn with the registration plan lane lit: the
// REAL `augmentCoachSkillForSignupOffer` with the coach-signup-offer addendum, and the REAL
// `offer_signup` over a fresh pglite family (the real DDL), whose plan offer the REAL
// signup-plan-reply writer composes, and whose earlier-ask question the REAL
// signup-offer-supersede reader answers, both through this runner's cached client.
//
//   node evals/run-coach-capability-correction-eval.mjs --max-usd 1.5   # live, then caches
//   node evals/run-coach-capability-correction-eval.mjs --broken        # calibration: must FAIL,
//                                                                      # and calibrationPasses pass
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
import { judgePrompt } from './lib/judge-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const WEB_LIB = join(WEB_ROOT, 'lib');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const PGLITE_SRC = join(WEB_LIB, 'testing', 'pglite.ts');
const DB_SRC = join(REPO_ROOT, 'packages', 'db', 'src', 'index.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Mirrors MAX_STEPS / CHANNEL_COACH_MAX_TOKENS in apps/web/lib/channel/coach/runtime.ts. */
const MAX_STEPS = 6;
const MAX_TOKENS = 2000;

const JUDGE_SYSTEM = judgePrompt('coach-capability-correction');

function contextFor(fixture) {
  const child = fixture.signup
    ? { ...TODDLER_CONTEXT, name: fixture.signup.child }
    : TODDLER_CONTEXT;
  const earlier = fixture.signup?.earlier;
  return {
    parentName: null,
    location: fixture.location,
    planTier: 'free',
    children: [child],
    focusedChild: null,
    stages: [TODDLER_CONTEXT.stage],
    memoryFacts: [],
    recentEpisodes: [],
    transcript: [
      ...(earlier ? [{ role: 'assistant', content: earlier.said }] : []),
      { role: 'user', content: fixture.text },
    ],
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

function toolsFor(real, fixture, calls, listed, offers, extra = []) {
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
  // Built for the fixture family's own country, as the runtime does (D6).
  const framework = real.frameworkGuidanceTool(fixture.location.country);
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
  tools.push(...extra);
  const have = new Set(tools.map((t) => t.name));
  for (const name of listed) if (!have.has(name)) tools.push(stub(name, { ok: false }));
  return tools;
}

/** The family the plan lane would hold the turn for: the eval's clock, zone and language. */
const SIGNUP_NOW = new Date('2026-11-09T15:00:00.000Z');
const SIGNUP_OPENS = new Date('2026-12-01T12:00:00.000Z');

/**
 * Pins the offer ids this database mints. `offer_signup` hands its offer id back to the
 * model, and the agent cache keys on the whole request, so a random uuid made every step
 * after the call a miss. A fresh pglite per case restarts the sequence.
 */
async function pinOfferIds(testDb) {
  await testDb.exec(`
    create sequence eval_offer_uuid_seq;
    create function eval_offer_uuid() returns uuid language sql as $$
      select ('00000000-0000-4000-8000-' || lpad(to_hex(nextval('eval_offer_uuid_seq')), 12, '0'))::uuid
    $$;
    alter table authorized_signup_offers alter column id set default eval_offer_uuid();
  `);
}

/** A family with the fixture's child, zone and language, and any ask pending before it. */
async function seedSignupFamily(real, testDb, fixture) {
  const database = testDb.database;
  const seeded = await real.pglite.seedFamily(database);
  const childId = await real.pglite.seedChild(
    database,
    seeded.familyId,
    fixture.signup.child,
    TODDLER_CONTEXT.ageMonths,
    undefined,
    SIGNUP_NOW,
  );
  await database
    .update(real.db.schema.users)
    .set({ timezone: 'America/Toronto', proactiveLanguage: fixture.signup.language })
    .where(real.eq(real.db.schema.users.id, seeded.parentUserId));
  let earlierId = null;
  const earlier = fixture.signup.earlier;
  if (earlier) {
    const recorded = await real.store.recordSignupOffer(database, {
      familyId: seeded.familyId,
      childId,
      parentUserId: seeded.parentUserId,
      activityKey: 'earlier-ask',
      activityLabel: earlier.activity,
      registrationUrl: earlier.url,
      sessions: [
        {
          ...earlier.session,
          startsAt: '2027-01-09T15:15:00.000Z',
          endsAt: '2027-01-09T16:00:00.000Z',
          full: false,
          priceCents: null,
        },
      ],
      approvedPriceCents: null,
      planOpensAt: SIGNUP_OPENS,
      now: new Date(SIGNUP_NOW.getTime() - 24 * 60 * 60_000),
    });
    if (!recorded.ok) throw new Error(`seed earlier ask: ${recorded.reason}`);
    earlierId = recorded.id;
  }
  return { ...seeded, childId, earlierId };
}

async function offerStatus(real, database, id) {
  const offers = real.db.schema.authorizedSignupOffers;
  const [row] = await database
    .select({ status: offers.status })
    .from(offers)
    .where(real.eq(offers.id, id));
  return row?.status ?? null;
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
  if (fixture.mustRecord && !calls.some((c) => c.tool === 'offer_signup' && c.recorded)) {
    const tried = calls.filter((c) => c.tool === 'offer_signup').map((c) => c.reason);
    failures.push(`no recorded offer_signup (tried: ${tried.join(', ') || 'none'})`);
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
  const signupTool = await importTs(join(WEB_LIB, 'signup', 'offer-tool.ts'));
  const { createPlanReplyWriter } = await importTs(join(WEB_LIB, 'signup', 'plan', 'writer.ts'));
  const { createSignupSupersedeReader } = await importTs(
    join(WEB_LIB, 'signup', 'supersede-reader.ts'),
  );
  const { eq } = await import('drizzle-orm');
  const real = {
    agent,
    offerFullPlanTool,
    watchForOpeningTool,
    frameworkGuidanceTool,
    noteCapabilityDeclinedTool: capabilityTools.noteCapabilityDeclinedTool,
    noteCapabilityCorrectionTool: capabilityTools.noteCapabilityCorrectionTool,
    pglite: await importTs(PGLITE_SRC),
    db: await importTs(DB_SRC),
    store: await importTs(join(WEB_LIB, 'signup', 'store.ts')),
    eq,
  };
  const coach = await agent.loadSkill(join(SKILLS, 'coach-channel-sms.md'));
  const nearby = await agent.loadSkill(join(SKILLS, 'coach-nearby-find.md'));
  const correction = await agent.loadSkill(join(SKILLS, 'coach-capability-correction.md'));
  const signupAddendum = await agent.loadSkill(join(SKILLS, 'coach-signup-offer.md'));
  const base = { ...coach, instructions: `${coach.instructions}\n\n${nearby.instructions}` };
  // runtime.ts order with the plan lane lit: the verb and its addendum ride on the disk
  // coach skill, before the turn's own addenda.
  const lit = signupTool.augmentCoachSkillForSignupOffer(coach, true, signupAddendum);
  const signupBase = { ...lit, instructions: `${lit.instructions}\n\n${nearby.instructions}` };
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
    const turnBase = fixture.signup ? signupBase : base;
    const composed = capabilityTools.augmentCoachSkillForCapabilities(turnBase, {
      declined: fixture.dark.length > 0,
      correction: fixture.owed.length > 0 ? correction : null,
    });
    const extraText = composed.instructions.startsWith(`${turnBase.instructions}\n\n`)
      ? composed.instructions.slice(turnBase.instructions.length + 2)
      : '';
    const skill = extraText ? { ...composed, instructions: turnBase.instructions } : composed;
    let reply = fixture.broken.reply;
    /** What `offer_signup` returned this turn: the judge grades the reply against it. */
    const signupResults = [];
    let signupDb = null;
    let signupFamily = null;
    const extraTools = [];
    if (fixture.signup && !broken) {
      process.env.AUTHORIZED_SIGNUP_ENABLED = 'on';
      process.env.REGISTRATION_PLAN_RUN_ENABLED = 'true';
      signupDb = await real.pglite.createTestDb();
      await pinOfferIds(signupDb);
      signupFamily = await seedSignupFamily(real, signupDb, fixture);
      const offerTool = signupTool.offerSignupTool({
        database: signupDb.database,
        familyId: signupFamily.familyId,
        parentUserId: signupFamily.parentUserId,
        now: SIGNUP_NOW,
        parentWords: fixture.text,
        linksThisTurn: () => [],
        planWriter: createPlanReplyWriter(() =>
          cachedAgentClient(
            `coach-capability-correction:${fixture.id}:plan-offer`,
            cachedOnly,
            getClient,
            cost,
          ),
        ),
        supersedeReader: createSignupSupersedeReader(() =>
          cachedAgentClient(
            `coach-capability-correction:${fixture.id}:supersede`,
            cachedOnly,
            getClient,
            cost,
          ),
        ),
      });
      extraTools.push({
        ...offerTool,
        handler: async (input, ctx) => {
          const result = await offerTool.handler(input, ctx);
          calls.push({ tool: offerTool.name, recorded: result.recorded, reason: result.reason });
          signupResults.push(result);
          return result;
        },
      });
    }
    if (broken) {
      calls.push(...fixture.broken.calls);
    } else {
      const run = await agent.runAgent({
        skill,
        ...(extraText ? { systemExtras: [extraText] } : {}),
        context: contextFor(fixture),
        tools: toolsFor(real, fixture, calls, skill.meta.tools, offers, extraTools),
        client: cachedAgentClient(
          `coach-capability-correction:${fixture.id}`,
          cachedOnly,
          getClient,
          cost,
        ),
        maxSteps: MAX_STEPS,
        maxTokens: MAX_TOKENS,
        toolContext: signupFamily
          ? { familyId: signupFamily.familyId, actor: signupFamily.parentUserId }
          : { familyId: 'fixture-family', actor: 'fixture-parent' },
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
    if (signupDb) {
      if (fixture.signup.earlierAfter && signupFamily.earlierId) {
        const status = await offerStatus(real, signupDb.database, signupFamily.earlierId);
        if (status !== fixture.signup.earlierAfter) {
          failures.push(`earlier ask ${status}, wanted ${fixture.signup.earlierAfter}`);
        }
      }
      await signupDb.close();
    }
    const verdict = await judge(fixture.id, {
      parentText: fixture.text,
      facts: {
        notYetPossible: fixture.dark,
        possibleNowButEarlierRefused: fixture.owed,
        // `undefined` off the fixtures without one, so their verdict keys stay put.
        alsoPossible: fixture.judgeCan,
        earlierAsk: fixture.signup?.earlier?.said,
        offerSignupReturned: fixture.signup ? signupResults : undefined,
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
  let passesHeld = true;
  for (const fixture of COACH_CAPABILITY_CORRECTION_FIXTURES) {
    for (const [index, reply] of (fixture.calibrationPasses ?? []).entries()) {
      const verdict = await judge(`calibration:${fixture.id}:${index}`, {
        parentText: fixture.text,
        facts: {
          notYetPossible: fixture.dark,
          possibleNowButEarlierRefused: fixture.owed,
          alsoPossible: fixture.judgeCan,
        },
        rubric: fixture.rubric,
        reply,
      });
      const ok = verdict.score >= JUDGE_MIN;
      if (!ok) passesHeld = false;
      console.log(
        `${ok ? 'OK  ' : 'OFF '}  calibration pass ${fixture.id} score=${verdict.score} "${reply}" (${verdict.reason})`,
      );
    }
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const calibrated = allFail && passesHeld;
  console.log(
    `broken-mode calibration (every case must fail, calibrationPasses pass): ${calibrated ? 'PASS' : 'FAIL'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('coach-capability-correction eval harness error:', err);
  process.exit(2);
});
