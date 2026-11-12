// The provider email eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/signup-provider-email.md, called the way the runtime calls
// it (apps/web/lib/signup/plan/provider-email.ts): the REAL user message, the schema on the
// skill's lane, the REAL code gate (`providerEmailViolations`) and the writer's one retry
// with the violation note. A draft still violating after the retry is never left in Gmail,
// and fails here.
//
// Two checks, and nothing matches words:
//   - THE GATE, in code: no link; a one-line subject; nothing empty or too long.
//   - THE DRAFT, by a judge: only the facts, the site's language, no instruction obeyed
//     from a label, polite and short.
//
//   node evals/run-signup-provider-email-eval.mjs --max-usd <cap>   # live, then caches
//   node evals/run-signup-provider-email-eval.mjs --cached-only      # replay only
//   node evals/run-signup-provider-email-eval.mjs --broken           # calibration: must catch all
//   node evals/run-signup-provider-email-eval.mjs --dry              # price, no client

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
  SIGNUP_PROVIDER_EMAIL_BROKEN,
  SIGNUP_PROVIDER_EMAIL_FIXTURES,
} from './signup-provider-email-fixtures.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-provider-email.md');
const WRITER_SRC = join(WEB_ROOT, 'lib', 'signup', 'plan', 'provider-email.ts');
const ATTEMPTS = 2;

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = judgePrompt('signup-provider-email');

function fixtureFor(id) {
  const fixture = SIGNUP_PROVIDER_EMAIL_FIXTURES.find((item) => item.id === id);
  if (!fixture) throw new Error(`signup-provider-email: no fixture ${id}`);
  return fixture;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const writer = await importTs(WRITER_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();

  installEvalSpendCap();
  const getClient = lazyAnthropic('signup-provider-email');
  const cost = makeCost();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'signup-provider-email',
    cachedOnly,
    getClient,
    cost,
  );
  console.info(
    `signup-provider-email | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | writer=${lane.model} judge=${judgeModel} | fixtures=${SIGNUP_PROVIDER_EMAIL_FIXTURES.length}`,
  );

  if (broken) {
    let caught = true;
    for (const item of SIGNUP_PROVIDER_EMAIL_BROKEN) {
      const fixture = fixtureFor(item.fixtureId);
      const violations = writer.providerEmailViolations(item.draft);
      if (violations.length > 0) {
        console.info(`CAUGHT  ${item.id.padEnd(24)} code gate (${violations.join('; ')})`);
        continue;
      }
      const verdict = await judge(`broken:${item.id}`, {
        facts: fixture.facts,
        subject: item.draft.subject,
        body: item.draft.body,
        watchFor: fixture.watchFor,
      });
      if (dry) continue;
      const failed = verdict.score < JUDGE_MIN;
      if (!failed) caught = false;
      console.info(
        `${failed ? 'CAUGHT' : 'MISSED'}  ${item.id.padEnd(24)} judge:${verdict.score} (${verdict.reason}) breaks: ${item.breaks}`,
      );
    }
    if (dry) {
      console.info(dryReportLine('signup-provider-email --broken', [judge.plan]));
      return;
    }
    console.info(
      `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
    );
    console.info(`broken-mode calibration: ${caught ? 'PASS' : 'FAIL'}`);
    process.exit(caught ? 0 : 1);
  }

  const results = [];
  for (const fixture of SIGNUP_PROVIDER_EMAIL_FIXTURES) {
    let violation = null;
    let draft = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const call = await cachedToolCall({
        tag: `signup-provider-email:${fixture.id}${violation ? ':retry' : ''}`,
        lane,
        system: skill.instructions,
        userMessage: writer.providerEmailUserMessage(fixture.facts, violation),
        toolName: writer.SIGNUP_PROVIDER_EMAIL_TOOL,
        toolDescription: writer.SIGNUP_PROVIDER_EMAIL_TOOL_DESCRIPTION,
        toolSchema: writer.SIGNUP_PROVIDER_EMAIL_TOOL_SCHEMA,
        maxTokens: writer.SIGNUP_PROVIDER_EMAIL_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      const parsed = writer.signupProviderEmailSchema.safeParse(call.value);
      const candidate = parsed.success
        ? { subject: parsed.data.subject.trim(), body: parsed.data.body.trim() }
        : { subject: '', body: '' };
      const violations = writer.providerEmailViolations(candidate);
      if (violations.length === 0) {
        draft = candidate;
        break;
      }
      violation = violations.join('; ');
    }
    const failures = [];
    if (draft === null) failures.push(`unwritable after retry: ${violation}`);
    else {
      const seen = JSON.parse(writer.providerEmailUserMessage(fixture.facts, null)).facts;
      const verdict = await judge(fixture.id, {
        facts: seen,
        subject: draft.subject,
        body: draft.body,
        watchFor: fixture.watchFor,
      });
      if (!dry && verdict.score < JUDGE_MIN) {
        failures.push(`judge:${verdict.score} (${verdict.reason})`);
      }
    }
    results.push({ fixture, draft, failures });
  }
  if (dry) {
    console.info(dryReportLine('signup-provider-email', [judge.plan]));
    return;
  }
  for (const r of results) {
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} ${r.draft === null ? '(nothing drafted)' : JSON.stringify(r.draft)}`,
    );
    for (const f of r.failures) console.info(`        · ${f}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error(
    'signup-provider-email eval harness error:',
    err instanceof Error ? err.message : err,
  );
  process.exit(2);
});
