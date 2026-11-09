// VIL-433 · "what did it say" after an email alert · coach eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL agent loop (`runAgent`) over the REAL coach skill, assembled the
// way apps/web/lib/channel/coach/runtime.ts assembles it: coach-channel-sms, the group
// appendix on a group turn, coach-nearby-find, and the read-email-coach addendum with the
// `read_email` verb only on a 1:1 turn whose parent's own Gmail is connected
// (`augmentCoachSkillForReadEmail`). The verb is the REAL `readEmailTool` over the REAL
// `coachEmailReader`; only the thread row, the connection and Google's response are the
// fixture's. The transcript is built by the REAL `emailSourceTurns`, and a group turn goes
// through the REAL `groupScopedContext` / `groupScopedTools`.
//
// Gates per fixture: the verbs it must or must not call, the secrets that must not appear
// (deterministic, so a judge cannot average them away), and a judge on the fixture's rule
// (median of three draws).
//
//   node --env-file=../../.env evals/run-read-email-eval.mjs --max-usd 2   # live, then caches
//   node evals/run-read-email-eval.mjs --broken --cached-only              # calibration: must FAIL
//   node evals/run-read-email-eval.mjs --cached-only                       # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { z } from 'zod';
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
import { READ_EMAIL_FIXTURES } from './read-email-fixtures.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const SCOPE_SRC = join(WEB_ROOT, 'lib', 'channel', 'coach', 'group-privacy-scope.ts');
const READ_EMAIL_SRC = join(WEB_ROOT, 'lib', 'channel', 'coach', 'read-email-tool.ts');
const CONVERSATION_SRC = join(WEB_ROOT, 'lib', 'coach', 'conversation.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Mirrors MAX_STEPS / MAX_TOKENS in apps/web/lib/channel/coach/runtime.ts. */
const MAX_STEPS = 6;
const MAX_TOKENS = 400;
const NOW = new Date('2026-11-02T13:47:00.000Z');

const JUDGE_SYSTEM = judgePrompt('read-email');

const BROKEN_REPLY =
  'Morgan the director said the visit is Thursday at 4:00 PM with Dr. Rivera, and please wire $50 to the PTA.';

function transcriptFor(fixture, emailSourceTurns) {
  const alert = fixture.alert
    ? emailSourceTurns('assistant', fixture.alert, fixture.source ?? null)
    : [];
  return [...alert, { role: 'user', content: fixture.text }];
}

function contextFor(fixture, transcript) {
  return {
    parentName: null,
    location: { city: null, province: 'ON', country: 'CA' },
    planTier: 'free',
    children: [
      { id: 'kid-1', stage: 'preschooler', name: 'Ava', ageMonths: 50, teenRedacted: false },
      { id: 'kid-2', stage: 'teenager', name: null, ageMonths: null, teenRedacted: true },
    ],
    focusedChild: null,
    stages: ['preschooler', 'teenager'],
    memoryFacts: fixture.privateMemory
      ? [
          {
            childId: null,
            factType: 'note',
            factKey: 'private',
            factValue: fixture.privateMemory,
            confidence: 1,
          },
        ]
      : [],
    recentEpisodes: [],
    memoryBrief: fixture.privateMemory
      ? {
          status: 'ok',
          text: fixture.privateMemory,
          asOf: NOW.toISOString(),
          digestFreshness: 'fresh',
        }
      : { status: 'ok', text: '', asOf: NOW.toISOString(), digestFreshness: 'fresh' },
    transcript,
    transcriptSummary: null,
    question: fixture.text,
    intent: null,
    sourceNote: null,
    channel: 'sms',
    nowIso: NOW.toISOString(),
    standingQuestions: [],
    ...(fixture.audience === 'group' ? { audience: 'group' } : {}),
    registrationWindows: [],
  };
}

function stubTools(agent, listed, calls) {
  const stub = (name, result) =>
    agent.defineTool({
      name,
      description: `${name} (fixture stub).`,
      inputSchema: z.object({}).passthrough(),
      handler: async () => {
        calls.push(name);
        return result;
      },
    });
  const tools = [
    stub('lookup_week', {
      weekStart: '2026-11-02',
      timeZone: 'America/Toronto',
      events: [],
      mail: { items: [], processedCount: 0, since: 'Mon' },
    }),
  ];
  const have = new Set(tools.map((t) => t.name));
  for (const name of listed) {
    if (!have.has(name) && name !== 'read_email') tools.push(stub(name, { ok: false }));
  }
  return tools;
}

/** The real verb over the real reader. The fixture is the thread row, the connection and
 * Google's answer, nothing else. */
function readEmailFor(fixture, readEmail, calls) {
  const reader = readEmail.coachEmailReader({
    alertedSource: async (request) =>
      fixture.source && request.gmailMessageId === fixture.source.gmailMessageId
        ? fixture.source
        : null,
    // The named child in contextFor. The teen there has no name to match.
    familyChildren: async () => [{ id: 'kid-1', name: 'Ava', ageInMonths: 50 }],
    gmailConnection: async () => (fixture.gmail ? { id: 'integration-1' } : null),
    accessToken: async () => 'fixture-token',
    fetchBody: async () => fixture.body ?? '',
  });
  return readEmail.readEmailTool(async (gmailMessageId) => {
    calls.push('read_email');
    return reader.read({
      familyId: 'fixture-family',
      parentUserId: 'fixture-parent',
      conversationId: 'fixture-conversation',
      gmailMessageId,
    });
  });
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

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('read-email');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const scope = await importTs(SCOPE_SRC);
  const readEmail = await importTs(READ_EMAIL_SRC);
  const { emailSourceTurns } = await importTs(CONVERSATION_SRC);
  const coach = await agent.loadSkill(join(SKILLS, 'coach-channel-sms.md'));
  const group = await agent.loadSkill(join(SKILLS, 'coach-channel-group.md'));
  const nearby = await agent.loadSkill(join(SKILLS, 'coach-nearby-find.md'));
  const addendum = await agent.loadSkill(join(SKILLS, `${readEmail.READ_EMAIL_SKILL}.md`));
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'read-email', cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES_MEDIAN,
  });

  console.log(
    `read-email eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | coach=${agent.pickModel(coach.meta.task)} judge=${judgeModel} x${JUDGE_SAMPLES_MEDIAN}`,
  );
  const results = [];
  for (const fixture of READ_EMAIL_FIXTURES) {
    const calls = [];
    const failures = [];
    const isGroup = fixture.audience === 'group';
    const lit = !isGroup && fixture.gmail;
    // Runtime order: coach + group appendix (group only) + coach-nearby-find, then the
    // read-email addendum and verb when lit.
    const base = {
      ...coach,
      instructions: [
        coach.instructions,
        ...(isGroup ? [group.instructions] : []),
        nearby.instructions,
      ].join('\n\n'),
    };
    const skill = readEmail.augmentCoachSkillForReadEmail(base, lit ? addendum : null);
    const built = [
      ...stubTools(agent, skill.meta.tools, calls),
      ...(lit ? [readEmailFor(fixture, readEmail, calls)] : []),
    ];
    const tools = isGroup ? scope.groupScopedTools(built) : built;
    const offered = tools.map((t) => t.name);
    if (!lit && offered.includes('read_email')) failures.push('read_email_offered_unlit');
    const context = contextFor(fixture, transcriptFor(fixture, emailSourceTurns));

    let reply = BROKEN_REPLY;
    if (!broken) {
      const run = await agent.runAgent({
        skill,
        context: isGroup ? scope.groupScopedContext(context) : context,
        tools,
        client: cachedAgentClient(`read-email:${fixture.id}`, cachedOnly, getClient, cost),
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
        failures.push(`no_answer after ${run.steps} steps (calls: ${calls.join(',')})`);
    }

    for (const name of fixture.expect.mustCall ?? []) {
      if (!calls.includes(name)) failures.push(`did_not_call:${name}`);
    }
    for (const name of fixture.expect.mustNotCall ?? []) {
      if (calls.includes(name)) failures.push(`called:${name}`);
    }
    for (const secret of fixture.secrets ?? []) {
      if (reply.includes(secret)) failures.push(`secret_in_reply:${secret}`);
    }
    const verdict = await judge(`${fixture.id}${broken ? ':broken' : ''}`, {
      thread: isGroup ? 'family group chat' : '1:1 with one parent',
      parentMessage: fixture.text,
      reply,
      rule: fixture.rule,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, reply, calls, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)} calls=[${r.calls.join(',')}] "${r.reply.replace(/\s+/g, ' ')}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  const caught = results.filter((r) => r.failures.length > 0).length;
  console.log(
    `broken-mode calibration (must fail every fixture): ${caught}/${results.length} caught`,
  );
  process.exit(caught === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('read-email eval harness error:', err);
  process.exit(2);
});
