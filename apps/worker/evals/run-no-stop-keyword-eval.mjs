// VIL-744 · the way out with NO_STOP_KEYWORD_COPY_ENABLED on (hard rule #8: no LLM mocking).
//
// SUBJECTS, as the lit path builds them, through the real skill loader and real runAgent:
//   group lines  group-onboarding-voice + group-onboarding-no-keyword (system extra) over the
//                real groupOnboardingLineInput, graded by the real lineUsable.
//   coach doubt  the real opt-out-read request first, because any reading but `none` is
//                answered before the coach runs. Then coach-channel-sms + nearby-find +
//                home-place + coach-no-stop-keyword, in the order channel/coach/runtime.ts
//                builds them. Listed tools are empty stubs.
//
// A case fails when production would refuse the draft, when it names a keyword, when a line
// that carries the way out does not say the person can stop, when the coach does not say it
// is an AI, or when the reader would route a doubt fixture away from the coach. Nothing here
// reads a flag: each request is built as the lit path builds it.
//
// RECORDING PENDING. The addenda are new bytes, so nothing is recorded yet. While
// RECORDING_PENDING is true, --cached-only runs the --dry projection and exits 0 unless a
// recorded case fails. After the one paid record run, set it to false and commit the cache.
//
//   node evals/run-no-stop-keyword-eval.mjs --dry
//   HALE_SPEND_LEDGER=... node evals/run-no-stop-keyword-eval.mjs --live --max-usd 1
//   node evals/run-no-stop-keyword-eval.mjs --cached-only

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { z } from 'zod';
import { coachHelpLines } from './lib/coach-help-lines.mjs';
import {
  DRY_SUBJECT_PLAN,
  REPO_ROOT,
  assertRunFlags,
  cacheGet,
  cacheKey,
  cachePut,
  cachedToolCall,
  dryReportLine,
  dryRequestPlanEntry,
  dryStandInText,
  evalRunTag,
  evalSubjectRequest,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  noteUsage,
  totalUsd,
  withoutMessageCacheMarkers,
} from './lib/harness.mjs';
import {
  COACH_DOUBT_FIXTURES,
  GROUP_WAY_OUT_FIXTURES,
  saysAi,
  saysStop,
} from './no-stop-keyword-fixtures.mjs';

const RECORDING_PENDING = true;

const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const WEB = join(REPO_ROOT, 'apps', 'web', 'lib');

/** productionComposer's full-prompt ceiling; MAX_STEPS and the coach ceiling in runtime.ts. */
const GROUP_MAX_TOKENS = 400;
const COACH_MAX_STEPS = 6;
const COACH_MAX_TOKENS = 2000;

const LOCATION = { city: 'Toronto', province: 'ON', country: 'Canada' };
const GUARDS = {
  async writeAudit() {},
  async checkChildContentAccess() {
    return { ok: true, reason: 'ok' };
  },
};
const TOOL_CONTEXT = { familyId: 'fixture-family', actor: 'fixture-parent' };

register({ tsconfig: join(REPO_ROOT, 'apps', 'web', 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

function cachedAgentClient(tag, cachedOnly, getClient, cost, unrecorded) {
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
            unrecorded.add(tag);
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

/** The spoken line out of the model's JSON, in the shape `questions` asks for. */
function spokenLine(answer, questions) {
  if (!answer) return null;
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let value;
  try {
    value = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }
  if (questions === 1) {
    return [value.before, value.question].filter(Boolean).join(' ').trim() || null;
  }
  return typeof value.line === 'string' && value.line.trim() ? value.line.trim() : null;
}

function coachContext(fixture, helpLines) {
  return {
    parentName: null,
    location: LOCATION,
    planTier: 'free',
    children: [{ id: 'child-1', stage: 'toddler', name: null, ageMonths: 28, teenRedacted: false }],
    focusedChild: null,
    stages: ['toddler'],
    memoryFacts: [],
    recentEpisodes: [],
    transcript: [{ role: 'user', content: fixture.text }],
    question: fixture.text,
    intent: null,
    sourceNote: null,
    channel: 'sms',
    nowIso: '2026-11-21T15:00:00.000Z',
    standingQuestions: [],
    registrationWindows: [],
    helpLines,
  };
}

async function run(mode) {
  if (mode === 'live') installEvalSpendCap();
  if (mode === 'dry') process.env.HALE_EVAL_DRY = '1';
  const cachedOnly = mode === 'cached-only';
  const getClient = lazyAnthropic('no-stop-keyword');
  const cost = makeCost();
  const unrecorded = new Set();
  const agent = await importTs(AGENT_SRC);
  const { groupOnboardingLineInput } = await importTs(
    join(WEB, 'channel', 'linq', 'group-onboarding-line-input.ts'),
  );
  const { lineUsable } = await importTs(join(WEB, 'channel', 'linq', 'group-onboarding-voice.ts'));
  const { namesKeyword } = await importTs(join(WEB, 'channel', 'no-stop-keyword.ts'));
  const { OPT_OUT_READ_MAX_TOKENS, OPT_OUT_READ_TOOL_SCHEMA, optOutUserMessage } = await importTs(
    join(WEB, 'channel', 'intake', 'opt-out-reader.ts'),
  );
  const skill = (name) => agent.loadSkill(join(SKILLS, `${name}.md`));
  const [group, groupAddendum, coach, nearby, home, coachAddendum, turnReader] = await Promise.all(
    [
      'group-onboarding-voice',
      'group-onboarding-no-keyword',
      'coach-channel-sms',
      'coach-nearby-find',
      'coach-home-place',
      'coach-no-stop-keyword',
      'opt-out-read',
    ].map(skill),
  );
  const helpLines = await coachHelpLines(LOCATION);
  const stubs = coach.meta.tools.map((name) =>
    agent.defineTool({
      name,
      description: `${name} (fixture stub).`,
      inputSchema: z.object({}).passthrough(),
      handler: async () => ({ ok: false }),
    }),
  );

  const results = [];
  for (const fixture of GROUP_WAY_OUT_FIXTURES) {
    const tag = `no-stop-keyword:${fixture.id}`;
    const input = groupOnboardingLineInput(fixture.request, fixture.language, {
      parentWords: fixture.parentWords ?? null,
      noKeyword: true,
    });
    const answer = await agent.runAgent({
      skill: group,
      systemExtras: [groupAddendum.instructions],
      context: { ...input, retry: false },
      tools: [],
      client: cachedAgentClient(tag, cachedOnly, getClient, cost, unrecorded),
      maxSteps: 1,
      maxTokens: GROUP_MAX_TOKENS,
      toolContext: TOOL_CONTEXT,
      guardDeps: GUARDS,
    });
    const body = spokenLine(answer.answer, input.questions);
    const failures = [];
    if (!unrecorded.has(tag)) {
      if (!body || !lineUsable(body, input, true)) failures.push('refused');
      if (body && fixture.saysWayOut && !saysStop(body, fixture.language)) {
        failures.push('no way out');
      }
    }
    results.push({ id: fixture.id, body, unrecorded: unrecorded.has(tag), failures });
  }
  for (const fixture of COACH_DOUBT_FIXTURES) {
    const tag = `no-stop-keyword:${fixture.id}`;
    // As router/route.ts reads the turn before its identity gate.
    const reading = await cachedToolCall({
      tag: `${tag}:reader`,
      lane: agent.pickLane(turnReader.meta.task),
      system: turnReader.instructions,
      userMessage: optOutUserMessage({ text: fixture.text, language: null }),
      toolName: 'opt_out',
      toolDescription: 'Return whether the sender asked Hale to stop or start texting.',
      toolSchema: OPT_OUT_READ_TOOL_SCHEMA,
      maxTokens: OPT_OUT_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (reading.dry) unrecorded.add(tag);
    else if (reading.value.intent !== 'none' || reading.value.verbatim !== fixture.text) {
      results.push({
        id: fixture.id,
        body: null,
        unrecorded: false,
        failures: [`reader routes it away from the coach (${reading.value.intent})`],
      });
      continue;
    }
    const answer = await agent.runAgent({
      skill: coach,
      systemExtras: [
        [nearby.instructions, home.instructions, coachAddendum.instructions].join('\n\n'),
      ],
      context: coachContext(fixture, helpLines),
      tools: stubs,
      client: cachedAgentClient(tag, cachedOnly, getClient, cost, unrecorded),
      maxSteps: COACH_MAX_STEPS,
      maxTokens: COACH_MAX_TOKENS,
      toolContext: TOOL_CONTEXT,
      guardDeps: GUARDS,
    });
    const body = answer.answer;
    const failures = [];
    if (!unrecorded.has(tag)) {
      if (!body) failures.push('no answer');
      else {
        const keyword = namesKeyword(body);
        if (keyword) failures.push(`names ${keyword}`);
        if (!saysAi(body, fixture.language)) failures.push('does not say it is an AI');
        if (!saysStop(body, fixture.language)) failures.push('no way out');
      }
    }
    results.push({ id: fixture.id, body, unrecorded: unrecorded.has(tag), failures });
  }

  for (const r of results) {
    const state = r.unrecorded ? 'UNRECORDED' : r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.info(`${state.padEnd(10)} ${r.id.padEnd(22)} ${r.unrecorded ? '' : `"${r.body}"`}`);
    for (const failure of r.failures) console.info(`           · ${failure}`);
  }
  const missing = results.filter((r) => r.unrecorded).length;
  const failed = results.filter((r) => r.failures.length > 0).length;
  if (mode === 'dry') console.info(dryReportLine('no-stop-keyword'));
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD | unrecorded ${missing} | failed ${failed}`,
  );
  const ok = failed === 0 && (mode !== 'cached-only' || missing === 0);
  console.info(`overall: ${ok ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(ok ? 0 : 1);
}

async function main() {
  const raw = process.argv.slice(2);
  assertRunFlags(['--max-usd'], raw);
  if (raw.includes('--live')) return run('live');
  if (raw.includes('--dry') || (raw.includes('--cached-only') && RECORDING_PENDING)) {
    return run('dry');
  }
  return run('cached-only');
}

main().catch((err) => {
  console.error('no-stop-keyword eval harness error:', err);
  process.exit(2);
});
