// The email alert · writer eval (VIL-433; hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/email-alert.md) over the REAL facts
// and gates: `emailAlertFacts` from apps/web/lib/integrations/email-alert.ts and
// `emailAlertUserMessage` / `emailAlertRefusals` from email-alert-compose.ts. The model
// writes the WHOLE text; a judge scores facts, safety, privacy and tone, in any language.
// Nothing matches words.
//
//   node evals/run-email-alert-eval.mjs --estimate                   # free: price the record run
//   node evals/run-email-alert-eval.mjs --max-usd 1.00               # live, then caches
//   node evals/run-email-alert-eval.mjs --broken                     # calibration: must FAIL
//   node evals/run-email-alert-eval.mjs --cached-only                # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { EMAIL_ALERT_FIXTURES } from './email-alert-fixtures.mjs';
import {
  JUDGE_MIN,
  PRICE,
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
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'email-alert.md');
const FACTS_SRC = join(WEB_ROOT, 'lib', 'integrations', 'email-alert.ts');
const COMPOSE_SRC = join(WEB_ROOT, 'lib', 'integrations', 'email-alert-compose.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};
const MAX_TOKENS = 300;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text Hale sends a parent about an email that just',
  'came in about their kids. The model wrote the whole text; nothing is added around it. You',
  'are given the facts (kind, from, what, when, where, categoryOnly, fromCalendar, going, ask,',
  'passport, language), the text and watchFor notes. Score 1-5 on FACTS, SAFETY, PRIVACY and',
  'TONE, judging the whole text as a native speaker of its language would, never by wording.',
  'A 5: every fact given is there and right (dates, a.m./p.m. or the natural equivalent) and',
  'nothing is invented; entirely in the requested language and natural as written, something',
  'a native speaker would actually send; short, calm, warm, like a friend; a question only if',
  'ask is set and then exactly one; when passport is set it is said once, inside the text, as',
  'something Hale is noting on the child record that they can correct by replying.',
  'A LOW score (1-2) is any of: a wrong time, date, sender or place; an invented reason,',
  'detail, attendee or outcome; claiming Hale booked, registered or confirmed anything; for',
  'categoryOnly, anything beyond the category (sender, time, place, a guess at what it is);',
  'saying Hale read their inbox or Gmail when fromCalendar is true; a link or email address;',
  'the wrong or mixed language, or clumsy grammar a native speaker would not send; a question',
  'when ask is null, or two questions; a code-built prefix or label like "Email alert:"; a',
  'separate template-like line stuck on; hype, exclamation marks, emoji, advice or a wish',
  'nobody asked for. A 3 is factual but stiff or awkward. Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: a code-built prefix, an invented detail, a link, a
// stuck-on passport line, a leaked teen sender, and a question with nothing behind it.
const BROKEN =
  'Email alert: Northside Counselling booked Mia in for 2:00!! Bring snacks. https://hale.example/p Added to passport. Reply YES?';

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) <= 0x024f) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

function priced(model, input, output) {
  const price = PRICE[model];
  if (!price) throw new Error(`no list price for ${model}`);
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const estimateOnly = process.argv.includes('--estimate');
  const agent = await importTs(AGENT_SRC);
  const factsMod = await importTs(FACTS_SRC);
  const compose = await importTs(COMPOSE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();

  const cases = EMAIL_ALERT_FIXTURES.map((fixture) => {
    const facts = factsMod.emailAlertFacts({ ...fixture.args, now: new Date(fixture.args.now) });
    return { fixture, facts, userMessage: compose.emailAlertUserMessage(facts) };
  });

  if (estimateOnly) {
    // Priced at max_tokens out, one writer call and one judge call per fixture. No API.
    let usd = 0;
    for (const c of cases) {
      const writerIn =
        estimateTokens(skill.instructions) +
        estimateTokens(c.userMessage) +
        estimateTokens(TOOL_SCHEMA);
      usd += priced(model, writerIn, MAX_TOKENS);
      const judgeIn =
        estimateTokens(JUDGE_SYSTEM) + estimateTokens(c.userMessage) + MAX_TOKENS + 200;
      usd += priced(judgeModel, judgeIn, 400);
    }
    console.log(
      `email-alert: estimate to record ${cases.length} fixtures (writer ${model} + judge ${judgeModel}), priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`,
    );
    process.exit(0);
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('email-alert');
  const cost = makeCost();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'email-alert', cachedOnly, getClient, cost);
  console.log(
    `email-alert eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const { fixture, facts, userMessage } of cases) {
    const body = broken
      ? BROKEN
      : String(
          (
            await cachedToolCall({
              tag: `email-alert:${fixture.id}`,
              model,
              lane,
              system: skill.instructions,
              userMessage,
              toolName: 'email_alert_text',
              toolSchema: TOOL_SCHEMA,
              toolDescription: 'The one text Hale sends the parent about this email.',
              maxTokens: MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            })
          ).value.text ?? '',
        ).trim();
    const failures = compose.emailAlertRefusals(body, facts).map((r) => `unsendable:${r}`);
    const verdict = await judge(fixture.id, {
      input: userMessage,
      text: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures });
  }
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(32)} "${r.body}"`,
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
  console.error('email-alert eval harness error:', err);
  process.exit(2);
});
