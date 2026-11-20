// The voice-memo choice · coach eval (VIL-495, hard rule #8: no LLM mocking).
//
// The subject is the REAL agent loop (`runAgent`) over the REAL coach skill, composed the
// way runtime.ts composes a lit 1:1 turn: coach-channel-sms + coach-nearby-find, then the
// coach-voice-memo addendum through the REAL `augmentCoachSkillForVoiceMemos`, with the
// REAL `reply_as_voice_memo` verb. The metric is objective: whether the model called the
// verb, against the case's Design-lock expectation. Nothing here matches words.
//
//   node evals/run-coach-voice-memo-eval.mjs --max-usd 1   # live, then caches
//   node evals/run-coach-voice-memo-eval.mjs --cached-only # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { z } from 'zod';
import { COACH_VOICE_MEMO_CHILD, COACH_VOICE_MEMO_FIXTURES } from './coach-voice-memo-fixtures.mjs';
import { coachHelpLines } from './lib/coach-help-lines.mjs';
import {
  cacheGet,
  cacheKey,
  cachePut,
  evalRunTag,
  evalSubjectRequest,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  noteUsage,
  totalUsd,
  withoutMessageCacheMarkers,
} from './lib/harness.mjs';

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
const NOW = '2026-11-12T17:00:00.000Z';

const LOCATION = { city: 'Columbus', province: 'OH', country: 'US' };

function contextFor(fixture, helpLines) {
  return {
    parentName: null,
    location: LOCATION,
    planTier: 'free',
    children: [COACH_VOICE_MEMO_CHILD],
    focusedChild: null,
    stages: [COACH_VOICE_MEMO_CHILD.stage],
    memoryFacts: [],
    recentEpisodes: [],
    transcript: fixture.text ? [{ role: 'user', content: fixture.text }] : [],
    question: fixture.text,
    intent: null,
    sourceNote: null,
    channel: 'sms',
    nowIso: NOW,
    standingQuestions: [],
    registrationWindows: [],
    helpLines,
    ...(fixture.arrivedMedia ? { arrivedMedia: fixture.arrivedMedia } : {}),
  };
}

function toolsFor(agent, replyAsVoiceMemoTool, fixture, calls, listed, onVoice) {
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
        return { timeZone: 'America/New_York', events: fixture.events };
      },
    }),
    replyAsVoiceMemoTool({
      onChoose: () => {
        calls.push('reply_as_voice_memo');
        onVoice();
      },
    }),
  ];
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

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('coach-voice-memo');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { augmentCoachSkillForVoiceMemos, replyAsVoiceMemoTool } = await importTs(
    join(COACH, 'voice-memo-tool.ts'),
  );
  const coach = await agent.loadSkill(join(SKILLS, 'coach-channel-sms.md'));
  const nearby = await agent.loadSkill(join(SKILLS, 'coach-nearby-find.md'));
  const voice = await agent.loadSkill(join(SKILLS, 'coach-voice-memo.md'));
  const skill = augmentCoachSkillForVoiceMemos(
    { ...coach, instructions: `${coach.instructions}\n\n${nearby.instructions}` },
    voice,
  );

  console.log(
    `coach-voice-memo eval${cachedOnly ? ' (cached-only)' : ''} | coach=${agent.pickModel(skill.meta.task)}`,
  );
  const results = [];
  for (const fixture of COACH_VOICE_MEMO_FIXTURES) {
    const calls = [];
    const failures = [];
    let chose = false;
    const run = await agent.runAgent({
      skill,
      context: contextFor(fixture, await coachHelpLines(LOCATION)),
      tools: toolsFor(agent, replyAsVoiceMemoTool, fixture, calls, skill.meta.tools, () => {
        chose = true;
      }),
      client: cachedAgentClient(`coach-voice-memo:${fixture.id}`, cachedOnly, getClient, cost),
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
    const reply = run.answer ?? '';
    if (!run.answer) failures.push(`no_answer after ${run.steps} steps`);
    if (chose !== fixture.expectVoice) {
      failures.push(`voice: expected ${fixture.expectVoice}, model chose ${chose}`);
    }
    results.push({ fixture, reply, calls, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(18)} calls=[${r.calls.join(',')}] "${r.reply.replace(/\s+/g, ' ')}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error('coach-voice-memo eval harness error:', err);
  process.exit(2);
});
