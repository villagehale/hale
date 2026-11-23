// VIL-715 · registration pre-flight and approval binding (hard rule #8: no LLM mocking).
//
// SUBJECTS, each called the way the runtime calls it:
//   - the plan writer with the signup-plan-terms addendum, through the real code gate and
//     its one retry, then the signup-plan-reply judge;
//   - the plan reader with the signup-plan-read-terms addendum, through `toPlanReading`;
//   - the page read (signup-preflight-read), through `applyPreflightRead`;
//   - the birth-date read (signup-dob-read), through `acceptDobReading`;
//   - the provider notice and the mismatch read with the signup-page-words addendum, on a
//     site option that carries an instruction.
//
// No `run-` prefix until its recordings exist, so CI does not replay an empty cache.
//
//   node evals/signup-terms-eval.mjs --dry            # price, no client
//   node evals/signup-terms-eval.mjs --cached-only    # replay only
//   node evals/signup-terms-eval.mjs --max-usd <cap>  # live, then caches

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  REPO_ROOT,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';
import {
  SIGNUP_TERMS_DOB_FIXTURES,
  SIGNUP_TERMS_MISMATCH_FIXTURES,
  SIGNUP_TERMS_NOTICE_FIXTURES,
  SIGNUP_TERMS_PREFLIGHT_FIXTURES,
  SIGNUP_TERMS_READ_FIXTURES,
  SIGNUP_TERMS_WRITER_FIXTURES,
} from './signup-terms-fixtures.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const web = (...parts) => join(WEB_ROOT, 'lib', 'signup', ...parts);
const ATTEMPTS = 2;
const NOW = new Date('2026-02-01T12:00:00.000Z');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts'));
  const writer = await importTs(web('plan', 'writer.ts'));
  const reader = await importTs(web('plan', 'reader.ts'));
  const page = await importTs(web('terms', 'read-page.ts'));
  const dob = await importTs(web('terms', 'dob-reader.ts'));
  const notice = await importTs(web('plan', 'notice-writer.ts'));
  const mismatch = await importTs(web('plan', 'mismatch-reader.ts'));
  const pageWords = await importTs(web('terms', 'page-words.ts'));
  const skill = async (name) => agent.loadSkill(join(SKILLS, `${name}.md`));
  const replySkill = await skill(writer.SIGNUP_PLAN_REPLY_SKILL);
  const termsSkill = await skill(writer.SIGNUP_PLAN_TERMS_SKILL);
  const readSkill = await skill(reader.SIGNUP_PLAN_READ_SKILL);
  const readTermsSkill = await skill(reader.SIGNUP_PLAN_READ_TERMS_SKILL);
  const preflightSkill = await skill(page.SIGNUP_PREFLIGHT_READ_SKILL);
  const dobSkill = await skill(dob.SIGNUP_DOB_READ_SKILL);
  const noticeSkill = await skill(notice.SIGNUP_PROVIDER_NOTICE_SKILL);
  const mismatchSkill = await skill(mismatch.SIGNUP_MISMATCH_READ_SKILL);
  const pageWordsSkill = await skill(pageWords.SIGNUP_PAGE_WORDS_SKILL);
  const judgeModel = await readJudgeModel();

  installEvalSpendCap();
  const getClient = lazyAnthropic('signup-terms');
  const cost = makeCost();
  const judge = makeJudge(
    judgeModel,
    judgePrompt('signup-plan-reply'),
    'signup-terms',
    cachedOnly,
    getClient,
    cost,
  );
  const noticeJudge = makeJudge(
    judgeModel,
    judgePrompt('signup-provider-notice'),
    'signup-terms-notice',
    cachedOnly,
    getClient,
    cost,
  );
  const common = { cachedOnly, getClient, cost };
  const results = [];
  const record = (id, failures, shown) => results.push({ id, failures, shown });

  for (const fixture of SIGNUP_TERMS_WRITER_FIXTURES) {
    let violation = null;
    let text = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const call = await cachedToolCall({
        ...common,
        tag: `signup-terms:write:${fixture.id}${violation ? ':retry' : ''}`,
        lane: agent.pickLane(replySkill.meta.task),
        system: `${replySkill.instructions}\n\n${termsSkill.instructions}`,
        userMessage: writer.planReplyUserMessage(fixture.facts, violation),
        toolName: writer.SIGNUP_PLAN_REPLY_TOOL,
        toolDescription: writer.SIGNUP_PLAN_REPLY_TOOL_DESCRIPTION,
        toolSchema: writer.SIGNUP_PLAN_REPLY_TOOL_SCHEMA,
        maxTokens: writer.SIGNUP_PLAN_REPLY_MAX_TOKENS,
      });
      const draft = writer.signupPlanReplySchema.safeParse(call.value);
      const sent = writer.planReplyText(draft.success ? draft.data.text : '');
      const violations = writer.planReplyViolations(sent, fixture.facts);
      if (violations.length === 0) {
        text = sent;
        break;
      }
      violation = violations.join('; ');
    }
    const failures = [];
    if (text === null) failures.push(`unsendable after retry: ${violation}`);
    else {
      const seen = JSON.parse(writer.planReplyUserMessage(fixture.facts, null)).facts;
      const verdict = await judge(fixture.id, { facts: seen, text, watchFor: fixture.watchFor });
      if (!dry && verdict.score < JUDGE_MIN) {
        failures.push(`judge:${verdict.score} (${verdict.reason})`);
      }
    }
    record(fixture.id, failures, text);
  }

  for (const fixture of SIGNUP_TERMS_READ_FIXTURES) {
    const call = await cachedToolCall({
      ...common,
      tag: `signup-terms:read:${fixture.id}`,
      lane: agent.pickLane(readSkill.meta.task),
      system: `${readSkill.instructions}\n\n${readTermsSkill.instructions}`,
      userMessage: reader.signupPlanReadUserMessage({ text: fixture.text, offer: fixture.offer }),
      toolName: reader.SIGNUP_PLAN_READ_TOOL,
      toolDescription: reader.SIGNUP_PLAN_READ_TOOL_DESCRIPTION,
      toolSchema: reader.SIGNUP_PLAN_READ_TOOL_SCHEMA,
      maxTokens: reader.SIGNUP_PLAN_READ_MAX_TOKENS,
    });
    if (dry) continue;
    const parsed = reader.signupPlanReadSchema.safeParse(call.value);
    const reading = parsed.success
      ? reader.toPlanReading(parsed.data, fixture.offer, fixture.text)
      : null;
    const failures = Object.entries(fixture.expect).flatMap(([key, want]) =>
      reading?.[key] === want ? [] : [`${key}: wanted ${want}, got ${reading?.[key]}`],
    );
    record(fixture.id, failures, JSON.stringify(reading));
  }

  for (const fixture of SIGNUP_TERMS_PREFLIGHT_FIXTURES) {
    const call = await cachedToolCall({
      ...common,
      tag: `signup-terms:preflight:${fixture.id}`,
      lane: agent.pickLane(preflightSkill.meta.task),
      system: preflightSkill.instructions,
      userMessage: JSON.stringify({ page_text: fixture.page }),
      toolName: page.SIGNUP_PREFLIGHT_READ_TOOL,
      toolDescription: page.SIGNUP_PREFLIGHT_READ_TOOL_DESCRIPTION,
      toolSchema: page.SIGNUP_PREFLIGHT_READ_JSON_SCHEMA,
      maxTokens: page.SIGNUP_PREFLIGHT_READ_MAX_TOKENS,
    });
    if (dry) continue;
    const parsed = page.signupPreflightReadSchema.safeParse(call.value);
    const base = {
      read: 'unread',
      program: { courseIds: [], name: null },
      age: { fit: 'unknown', band: null, rule: null },
      prerequisite: { required: 'unknown', quote: null },
      refund: null,
      currency: null,
      rates: [],
      tax: 'unknown',
      pageOpensAt: null,
    };
    const terms = parsed.success ? page.applyPreflightRead(base, parsed.data, fixture.page) : base;
    const got = {
      refund: terms.refund?.quote ?? null,
      prerequisite: terms.prerequisite.required,
      rates: terms.rates,
      tax: terms.tax,
    };
    const failures =
      JSON.stringify(got) === JSON.stringify(fixture.expect)
        ? []
        : [`wanted ${JSON.stringify(fixture.expect)}, got ${JSON.stringify(got)}`];
    record(fixture.id, failures, JSON.stringify(got));
  }

  for (const fixture of SIGNUP_TERMS_DOB_FIXTURES) {
    const call = await cachedToolCall({
      ...common,
      tag: `signup-terms:dob:${fixture.id}`,
      lane: agent.pickLane(dobSkill.meta.task),
      system: dobSkill.instructions,
      userMessage: dob.signupDobReadUserMessage({ text: fixture.text, childFirstName: 'Ada' }),
      toolName: dob.SIGNUP_DOB_READ_TOOL,
      toolDescription: dob.SIGNUP_DOB_READ_TOOL_DESCRIPTION,
      toolSchema: dob.SIGNUP_DOB_READ_TOOL_SCHEMA,
      maxTokens: dob.SIGNUP_DOB_READ_MAX_TOKENS,
    });
    if (dry) continue;
    const parsed = dob.signupDobReadSchema.safeParse(call.value);
    const date = parsed.success ? dob.acceptDobReading(parsed.data, fixture.text, NOW) : null;
    record(
      fixture.id,
      date === fixture.expect ? [] : [`wanted ${fixture.expect}, got ${date}`],
      String(date),
    );
  }

  for (const fixture of SIGNUP_TERMS_NOTICE_FIXTURES) {
    let violation = null;
    let bubbles = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const call = await cachedToolCall({
        ...common,
        tag: `signup-terms:notice:${fixture.id}${violation ? ':retry' : ''}`,
        lane: agent.pickLane(noticeSkill.meta.task),
        system: `${noticeSkill.instructions}\n\n${pageWordsSkill.instructions}`,
        userMessage: notice.providerNoticeUserMessage(fixture.facts, violation),
        toolName: notice.SIGNUP_PROVIDER_NOTICE_TOOL,
        toolDescription: notice.SIGNUP_PROVIDER_NOTICE_TOOL_DESCRIPTION,
        toolSchema: notice.SIGNUP_PROVIDER_NOTICE_TOOL_SCHEMA,
        maxTokens: notice.SIGNUP_PROVIDER_NOTICE_MAX_TOKENS,
      });
      const draft = notice.signupProviderNoticeSchema.safeParse(call.value);
      const sent = (draft.success ? (draft.data.bubbles ?? []) : []).map(writer.planReplyText);
      const violations = sent.flatMap((text) => writer.planReplyViolations(text));
      if (sent.length > 0 && violations.length === 0) {
        bubbles = sent;
        break;
      }
      violation = violations.join('; ') || 'no bubbles';
    }
    const failures = [];
    if (bubbles === null) failures.push(`unsendable after retry: ${violation}`);
    else {
      const seen = JSON.parse(notice.providerNoticeUserMessage(fixture.facts, null)).facts;
      const verdict = await noticeJudge(fixture.id, {
        facts: seen,
        bubbles,
        card: null,
        watchFor: fixture.watchFor,
      });
      if (!dry && verdict.score < JUDGE_MIN) {
        failures.push(`judge:${verdict.score} (${verdict.reason})`);
      }
    }
    record(fixture.id, failures, JSON.stringify(bubbles));
  }

  for (const fixture of SIGNUP_TERMS_MISMATCH_FIXTURES) {
    const input = {
      text: fixture.text,
      askedStart: fixture.askedStart,
      choices: fixture.choices,
      labelsFromPage: true,
    };
    const call = await cachedToolCall({
      ...common,
      tag: `signup-terms:mismatch:${fixture.id}`,
      lane: agent.pickLane(mismatchSkill.meta.task),
      system: `${mismatchSkill.instructions}\n\n${pageWordsSkill.instructions}`,
      userMessage: mismatch.signupMismatchReadUserMessage(input),
      toolName: mismatch.SIGNUP_MISMATCH_READ_TOOL,
      toolDescription: 'Decide which site option the parent picked, if any.',
      toolSchema: mismatch.SIGNUP_MISMATCH_READ_TOOL_SCHEMA,
      maxTokens: mismatch.SIGNUP_MISMATCH_READ_MAX_TOKENS,
    });
    if (dry) continue;
    const parsed = mismatch.signupMismatchReadSchema.safeParse(call.value);
    const reading = parsed.success ? mismatch.mismatchReadingFrom(parsed.data, input) : null;
    const failures = Object.entries(fixture.expect).flatMap(([key, want]) =>
      reading?.[key] === want ? [] : [`${key}: wanted ${want}, got ${reading?.[key]}`],
    );
    record(fixture.id, failures, JSON.stringify(reading));
  }

  if (dry) {
    console.info(dryReportLine('signup-terms', [judge.plan, noticeJudge.plan]));
    return;
  }
  for (const row of results) {
    console.info(
      `${row.failures.length === 0 ? 'PASS' : 'FAIL'}  ${row.id.padEnd(30)} ${row.shown}`,
    );
    for (const failure of row.failures) console.info(`        · ${failure}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((row) => row.failures.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error('signup-terms eval harness error:', err instanceof Error ? err.message : err);
  process.exit(2);
});
