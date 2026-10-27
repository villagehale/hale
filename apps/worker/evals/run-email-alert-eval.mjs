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
import { readCapUsd, readLedger } from '../../web/lib/testing/spend-cap.mjs';
import {
  EMAIL_ALERT_BROKEN_CASES,
  EMAIL_ALERT_FIXTURES,
  EMAIL_ALERT_REFERENCE_TEXTS,
} from './email-alert-fixtures.mjs';
import {
  GENERAL_REFERENCE_TEXTS,
  JUDGE_MIN,
  PRICE,
  cachedToolCall,
  estimateInputTokensOffline,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  priceRates,
  summarizeJudgePlan,
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
/** The judge's verdict cap (shared judge: 512, thinking off). */
const JUDGE_MAX_OUTPUT_TOKENS = 512;

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
  'separate template-like line stuck on; a code-built frame such as "X has Y on <date>", "X',
  'sent something about Y" or a bare "Title on <date>"; a text about an adult event that is',
  'not about the kids; relaying mail the parent sent themselves; repeating an event their',
  'mirrored calendar already reminds them of; a change written as an old/new log instead of',
  'what it is now; more than one ask or offer in one text (a passport note asked about AND a',
  'calendar offer is two); admin talk about how to correct Hale; a register that shifts',
  'inside the text (familiar and formal you, or their possessives, mixed);',
  'hype, exclamation marks, emoji, advice or a wish',
  'nobody asked for. A 3 is factual but stiff or awkward. Reply with ONLY the score tool.',
].join(' ');

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
  // THE SHARED JUDGE (Noah's makeJudge, decided 2026-10-27): Sonnet, thinking off via the
  // verdict cap, lowest of 3 draws, general + this PR's scored references.
  const judgeModel = agent.SONNET_MODEL;

  const toCase = (fixture) => {
    const facts = factsMod.emailAlertFacts({ ...fixture.args, now: new Date(fixture.args.now) });
    return { fixture, facts, userMessage: compose.emailAlertUserMessage(facts) };
  };
  const cases = (broken ? EMAIL_ALERT_BROKEN_CASES : EMAIL_ALERT_FIXTURES).map(toCase);
  const dryAll = isDryRun()
    ? [...EMAIL_ALERT_FIXTURES, ...EMAIL_ALERT_BROKEN_CASES].map(toCase)
    : null;

  if (estimateOnly) {
    // Priced at max_tokens out: a writer call and a judge call per normal case that speaks,
    // a judge call per broken case, nothing for a silent case. No API.
    let usd = 0;
    let calls = 0;
    const normal = EMAIL_ALERT_FIXTURES.map(toCase);
    const brokenCases = EMAIL_ALERT_BROKEN_CASES.map(toCase);
    for (const c of [...normal, ...brokenCases]) {
      if (c.fixture.expectSilent) continue;
      const judgeIn =
        estimateTokens(JUDGE_SYSTEM) + estimateTokens(c.userMessage) + MAX_TOKENS + 200;
      usd += priced(judgeModel, judgeIn, 400);
      calls += 1;
      if (c.fixture.text !== undefined) continue;
      calls += 1;
      const writerIn =
        estimateTokens(skill.instructions) +
        estimateTokens(c.userMessage) +
        estimateTokens(TOOL_SCHEMA);
      usd += priced(model, writerIn, MAX_TOKENS);
    }
    console.log(
      `email-alert: estimate to record ${normal.length} normal + ${brokenCases.length} broken cases (${calls} calls) (writer ${model} + judge ${judgeModel}), priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`,
    );
    process.exit(0);
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('email-alert');
  const cost = makeCost();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'email-alert', cachedOnly, getClient, cost, {
    samples: 3,
    aggregate: 'min',
    references: [...GENERAL_REFERENCE_TEXTS, ...EMAIL_ALERT_REFERENCE_TEXTS],
    logCost: true,
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
  });
  const dry = isDryRun();
  // --dry: an uncached writer call is priced here (the judge prices its own draws), and
  // the judge then sees a worst-length stand-in body. No network.
  const writerPlan = [];
  const writeOrPrice = async (fixture, userMessage) => {
    try {
      return await writerCall(fixture, userMessage);
    } catch (err) {
      if (!dry) throw err;
      const request = {
        system: skill.instructions,
        messages: [{ role: 'user', content: userMessage }],
        tools: [{ name: 'email_alert_text', input_schema: TOOL_SCHEMA }],
      };
      const inputTokens = estimateInputTokensOffline(request);
      const p = priceRates(model);
      const worstUsd = (inputTokens * p.input * 1.25 + MAX_TOKENS * p.output) / 1e6;
      writerPlan.push({ tag: `email-alert:${fixture.id}`, inputTokens, worstUsd });
      return 'x'.repeat(480);
    }
  };
  const writerCall = async (fixture, userMessage) =>
    String(
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
  console.log(
    `email-alert eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const { fixture, facts, userMessage } of dryAll ?? cases) {
    // SILENCE IS THE PASS: the code must stop before the writer. No model, no judge.
    if (fixture.expectSilent) {
      const silent = factsMod.alreadyOnCalendarUnchanged({
        from: fixture.args.from,
        kind: fixture.args.kind,
      });
      results.push({ fixture, body: '(nothing sent)', failures: silent ? [] : ['not_silent'] });
      continue;
    }
    const body =
      fixture.text !== undefined ? fixture.text : await writeOrPrice(fixture, userMessage);
    const failures = compose.emailAlertRefusals(body, facts).map((r) => `unsendable:${r}`);
    const verdict = await judge(fixture.id, {
      input: userMessage,
      text: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.dry) continue;
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures });
  }
  if (dry) {
    const capUsd = readCapUsd();
    if (capUsd === null) throw new Error('eval --dry: no --max-usd; nothing to project against');
    const { spentUsd } = readLedger();
    for (const w of writerPlan) {
      console.log(
        `DRY  uncached  writer ${w.tag}  ~${w.inputTokens} in + ${MAX_TOKENS} max out  worst $${w.worstUsd.toFixed(5)}`,
      );
    }
    for (const p of judge.plan) {
      console.log(
        p.cached
          ? `DRY  cached    ${p.tag}  score ${p.score}`
          : `DRY  uncached  ${p.tag}  ~${p.inputTokens} in (~${p.cacheReadTokens ?? 0} at cache-read) + ${p.maxTokens} max out  worst $${p.worstUsd.toFixed(5)}`,
      );
    }
    for (const r of results.filter((x) => x.fixture.expectSilent)) {
      console.log(
        `DRY  silent    ${r.fixture.id}  ${r.failures.length === 0 ? 'nothing sent (pass), 0 calls' : 'NOT SILENT'}`,
      );
    }
    const s = summarizeJudgePlan(judge.plan, { spentUsd, capUsd });
    const writerUsd = writerPlan.reduce((sum, w) => sum + w.worstUsd, 0);
    const total = s.worstTotalUsd + writerUsd;
    const projected = spentUsd + total;
    const fits = projected <= capUsd;
    console.log(
      `DRY summary | judge draws ${s.draws} (cached ${s.cached}, uncached ${s.uncached}) worst $${s.worstTotalUsd.toFixed(5)} | writer calls ${writerPlan.length} worst $${writerUsd.toFixed(5)} | worst total $${total.toFixed(5)} | ledger $${spentUsd.toFixed(5)} -> projected $${projected.toFixed(5)} vs cap $${capUsd} | ${fits ? 'FITS' : 'EXCEEDS CAP'}`,
    );
    console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
    process.exit(fits ? 0 : 3);
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
  // EVERY broken case must fail, not just one of them.
  const allFail = results.every((r) => r.failures.length > 0);
  console.log(`broken-mode calibration (every case must fail): ${allFail ? 'PASS' : 'FAIL'}`);
  process.exit(allFail ? 0 : 1);
}

main().catch((err) => {
  console.error('email-alert eval harness error:', err);
  process.exit(2);
});
