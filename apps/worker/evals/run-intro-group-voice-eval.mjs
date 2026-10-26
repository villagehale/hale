// The group introduction · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/intro-group-voice.md) run through the REAL
// forced-tool-JSON request shape apps/web/lib/village/intros/group-voice.ts builds — REPLICATED here because that module
// sits behind the web app's `~/` alias. `userMessage` and `refusals` below are the
// replicas, and group-voice.test.ts pins the originals. The skill body and model routing are
// imported live, so a skill edit re-keys the cache and shows up as a miss.
//
// NOT YET RECORDED. This suite has no cached responses and no CI step until a live run
// records them (a paid call — the founder runs it):
//   node --env-file=../../.env evals/run-intro-group-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-intro-group-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-intro-group-voice-eval.mjs --cached-only                    # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { INTRO_GROUP_VOICE_FIXTURES } from './intro-group-voice-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'intro-group-voice.md');

const TOOL_SCHEMA = {
  type: 'object',
  properties: { intro: { type: 'string' } },
  required: ['intro'],
};

const LINK_SHAPE = /https?:\/\/|www\./i;

const MAX_TOKENS = 320;
const MAX_CHARS = 480;

/** Mirrors `introGroupUserMessage` in group-voice.ts. */
function userMessage(request, rejected = []) {
  const base = {
    parentAFirstName: request.parentAFirstName,
    parentBFirstName: request.parentBFirstName,
    stageWord: request.stageWord,
    anchorTitle: request.anchorTitle,
    anchorDay: request.anchorDay,
  };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

/** Mirrors `introGroupRefusals` in group-voice.ts. */
function refusals(body, request) {
  if (body === '') return ['empty'];
  const found = [];
  if (body.length > MAX_CHARS) found.push('over_char_cap');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (!/^\p{Lu}/u.test(body)) found.push('not_a_sentence');
  const lower = body.toLowerCase();
  if (
    !lower.includes(request.parentAFirstName.toLowerCase()) ||
    !lower.includes(request.parentBFirstName.toLowerCase())
  ) {
    found.push('parent_name_missing');
  }
  if (request.anchorTitle !== null && !lower.includes(request.anchorTitle.toLowerCase()))
    found.push('anchor_missing');
  if (body.includes('@')) found.push('carries_address');
  const handed = new Set(
    `${request.anchorTitle ?? ''} ${request.anchorDay ?? ''}`.match(/\d+/g) ?? [],
  );
  if ((body.match(/\d+/g) ?? []).some((n) => !handed.has(n))) found.push('invented_number');
  return found;
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE message Hale sends as the first text in a new group',
  'chat with two parents who have each said yes, twice, to being introduced. Hale was handed',
  'two first names, a shared stage word and maybe an activity, and nothing else.',
  'You are given the request, the message, and watchFor notes. Score 1-5.',
  'A 5 introduces both parents by first name, says their kids share the stage and that both',
  'said yes, offers the activity (if given) as an easy first hello, and says plainly that',
  'Hale is stepping out. Warm, brief, first person singular.',
  'A LOW score is any of: a missing name; anything invented about a child or a place; a',
  'number not handed; "we"/"us"; hype, emoji, exclamation stacks; instructions to reply;',
  'lingering ("let me know how it goes!"); more than about three short sentences.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN = 'hey!! we found u a match 🎉 her daughter is 2 - meet at 4pm, see www.example.com';

function flatten(text) {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('intro-group-voice');
  const cost = makeCost();
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'intro-group-voice',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `intro-group-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of INTRO_GROUP_VOICE_FIXTURES) {
    const message = userMessage(fixture.request, fixture.rejected ?? []);
    const raw = broken
      ? BROKEN
      : (
          await cachedToolCall({
            tag: `intro-group-voice:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: message,
            toolName: 'intro',
            toolSchema: TOOL_SCHEMA,
            toolDescription: 'Return the one message that introduces these two parents.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.intro;
    const body = flatten(raw);
    const failures = refusals(body, fixture.request);
    for (const pattern of fixture.forbiddenPatterns ?? []) {
      if (pattern.test(body)) failures.push(`forbidden:${pattern.source}`);
    }
    const verdict = await judge(fixture.id, {
      request: message,
      message: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} "${r.body.slice(0, 100)}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('intro-group-voice eval harness error:', err);
  process.exit(2);
});
