// The add-them-yourself reply · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/group-onboarding-voice.md, kind
// `add_them_yourself`) run through the REAL request the web composer builds: the user
// message and the refusal gates are imported live from
// apps/web/lib/channel/caregiver/add-them-yourself.ts, and `plainText` from the coach
// reply module, through one tsx registration scoped to the web tsconfig (the precedent is
// run-memory-writeback-eval.mjs). The retry is the composer's own: a refused first draft
// is composed once more with the refusal handed back. A change to the facts, a gate or the
// skill re-keys the cache and shows up here as a miss rather than as silence.
//
// What is NOT tested here: the inbound routing, the ledger, and the named `unsent`
// outcome (caregiver/route.test.ts, add-them-yourself.test.ts, with a fake voice). This
// eval is only the words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-add-them-yourself-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-add-them-yourself-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-add-them-yourself-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS: a fixture whose reply the composer's gates refuse on both attempts (the
// parent hears nothing), and any final reply the judge scores under JUDGE_MIN.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { ADD_THEM_YOURSELF_FIXTURES } from './add-them-yourself-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-onboarding-voice.md');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** MAX_COMPOSE_ATTEMPTS and MAX_TOKENS in add-them-yourself.ts. */
const MAX_COMPOSE_ATTEMPTS = 2;
const MAX_TOKENS = 200;

/** replyJsonSchema in add-them-yourself.ts. */
const REPLY_TOOL_SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string' } },
  required: ['reply'],
};

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale sends a parent who asked Hale to',
  'add someone (a co-parent, grandparent, nanny or babysitter) by their phone number. Hale',
  'never texts a number first, so the message must say, in a few words, that Hale will not',
  'add or text them, and how the person gets in: on iMessage the parent adds them to the',
  'family group chat with Hale in it (or starts one with them and Hale), or the person texts',
  'Hale themselves; on SMS the person texts Hale themselves.',
  'You are given the request (kind, language, address, facts, and any refused drafts), the',
  'message, and watchFor - fixture-specific notes on what right and wrong look like. Score 1-5.',
  'A 5 reads like a friend who is good at this: short, plain, warm, first person, names',
  'facts.name when given, at most one question. In French a 5 uses tu and real accents.',
  'A LOW score is any of: saying or implying Hale texted, invited, messaged or added them, or',
  'will; on SMS, any mention of a group or group chat; the person told to write to the PARENT',
  'rather than to Hale (in French "te texter" / "t\'écrire" where it must be "m\'écrire");',
  'claiming Hale lacks a number the parent just gave;',
  'a phone number, link, or a phrase for the parent to send; a name or role not in the',
  'facts; explaining what a role can see; telling the parent to reply YES or a keyword;',
  'exclamation marks, emoji, hype, "we" for Hale; a corporate or bot register; padding;',
  'anything watchFor says must not happen.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: a contact claim, a number, a link and no group word. The
// composer's own gates refuse it on several lines at once.
const BROKEN_REPLY = "I'll text them at 647-555-0199 now, see www.example.com";

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await importTs(AGENT_SRC);
  const { addThemYourselfRefusals, addThemYourselfUserMessage } = await importTs(
    join(WEB_ROOT, 'lib', 'channel', 'caregiver', 'add-them-yourself.ts'),
  );
  const { plainText } = await importTs(join(WEB_ROOT, 'lib', 'channel', 'coach', 'reply.ts'));
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'add-them-yourself',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `add-them-yourself eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${ADD_THEM_YOURSELF_FIXTURES.length} replies\n`);

  const results = [];
  for (const fixture of ADD_THEM_YOURSELF_FIXTURES) {
    const rejected = [];
    let body = '';
    let problems = [];
    let attempts = 0;
    for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt += 1) {
      attempts = attempt + 1;
      const userMessage = addThemYourselfUserMessage(fixture.request, rejected);
      const raw = broken
        ? BROKEN_REPLY
        : (
            await cachedToolCall({
              tag: `add-them-yourself:${fixture.id}:${attempt}`,
              model,
              system: skill.instructions,
              userMessage,
              toolName: 'reply',
              toolSchema: REPLY_TOOL_SCHEMA,
              toolDescription: 'Return the one reply to the parent.',
              maxTokens: MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            })
          ).value.reply;
      body = plainText(String(raw ?? ''));
      problems = addThemYourselfRefusals(body, fixture.request);
      if (problems.length === 0) break;
      rejected.push({ draft: body, problems });
    }

    const failures = [];
    if (problems.length > 0) failures.push(`unsendable:${problems.join('+')}`);
    const verdict = await judge(fixture.id, {
      request: addThemYourselfUserMessage(fixture.request),
      message: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, attempts, failures });
  }

  console.log('--- replies ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.fixture.id.padEnd(32)} attempts=${r.attempts} "${r.body}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const unsendable = results.filter((r) => r.failures.some((f) => f.startsWith('unsendable:')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  const firstAttempt = results.filter((r) => r.attempts === 1 && r.failures.length === 0);
  console.log('\n--- corpus metrics ---');
  console.log(`UNSENDABLE REPLIES: ${unsendable.length}  (0 required)`);
  console.log(`judge below ${JUDGE_MIN}:      ${judgeFails.length}  (0 required)`);
  console.log(`passed on the first attempt: ${firstAttempt.length}/${results.length}`);
  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0);
  console.log('\n--- gate ---');
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const calibrated = !allPass;
  console.log(
    `broken-mode calibration (must fail at least one gate): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('add-them-yourself eval harness error:', err);
  process.exit(2);
});
