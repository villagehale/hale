// The registration notice eval (VIL-682 K2, hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/signup-provider-notice.md, called the way the runtime calls
// it (apps/web/lib/signup/plan/notice-writer.ts): the REAL user message
// (`providerNoticeUserMessage`), the tool schema on the skill's lane, then the REAL code
// gates — no link in a bubble (`planReplyViolations`) and the card's own gate (`keptCard`:
// no child, no price, no clock outside the card facts, no link but the provider host) — and
// the writer's one retry with the violation note. A draft still violating after the retry
// is what the runtime does not send, and fails here.
//
// Two checks, and nothing matches words:
//   - THE GATES, in code: bubbles that could not go, or a card the facts asked for that the
//     gate refused (the preview would fall back to the bare host), fail here.
//   - THE WORDS, by a judge: only the facts, the card in the parent's language, no child.
//
//   node evals/run-signup-provider-notice-eval.mjs --max-usd <cap>   # live, then caches
//   node evals/run-signup-provider-notice-eval.mjs --cached-only      # replay only
//   node evals/run-signup-provider-notice-eval.mjs --broken           # calibration: must catch all
//   node evals/run-signup-provider-notice-eval.mjs --dry              # price, no client

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
  SIGNUP_PROVIDER_NOTICE_BROKEN,
  SIGNUP_PROVIDER_NOTICE_FIXTURES,
} from './signup-provider-notice-fixtures.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-provider-notice.md');
const NOTICE_WRITER_SRC = join(WEB_ROOT, 'lib', 'signup', 'plan', 'notice-writer.ts');
const PLAN_WRITER_SRC = join(WEB_ROOT, 'lib', 'signup', 'plan', 'writer.ts');
const BUBBLES_SRC = join(WEB_ROOT, 'lib', 'signup', 'plan', 'bubbles.ts');
const ATTEMPTS = 2;

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = judgePrompt('signup-provider-notice');

function fixtureFor(id) {
  const fixture = SIGNUP_PROVIDER_NOTICE_FIXTURES.find((item) => item.id === id);
  if (!fixture) throw new Error(`signup-provider-notice: no fixture ${id}`);
  return fixture;
}

/** `keptCard` names a refusal on console.info; the eval reports it instead of printing it. */
function keptCardWithReason(writer, raw, facts) {
  const info = console.info;
  const logged = [];
  console.info = (...args) => logged.push(JSON.stringify(args));
  try {
    return { card: writer.keptCard(raw, facts), reason: logged.join(' ') };
  } finally {
    console.info = info;
  }
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const writer = await importTs(NOTICE_WRITER_SRC);
  const planWriter = await importTs(PLAN_WRITER_SRC);
  const bubblesLib = await importTs(BUBBLES_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();

  installEvalSpendCap();
  const getClient = lazyAnthropic('signup-provider-notice');
  const cost = makeCost();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'signup-provider-notice',
    cachedOnly,
    getClient,
    cost,
  );
  console.info(
    `signup-provider-notice | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | writer=${lane.model} judge=${judgeModel} | fixtures=${SIGNUP_PROVIDER_NOTICE_FIXTURES.length}`,
  );

  if (broken) {
    let caught = true;
    for (const item of SIGNUP_PROVIDER_NOTICE_BROKEN) {
      const fixture = fixtureFor(item.fixtureId);
      const kept = keptCardWithReason(writer, item.card, fixture.facts).card;
      if (item.gate) {
        const refused = kept === null;
        if (!refused) caught = false;
        console.info(
          `${refused ? 'CAUGHT' : 'MISSED'}  ${item.id.padEnd(28)} code gate · breaks: ${item.breaks}`,
        );
        continue;
      }
      if (kept === null)
        throw new Error(`${item.id}: the gate refused it; it must reach the judge`);
      const verdict = await judge(`broken:${item.id}`, {
        facts: fixture.facts,
        bubbles: item.bubbles,
        card: kept,
        watchFor: fixture.watchFor,
      });
      if (dry) continue;
      const failed = verdict.score < JUDGE_MIN;
      if (!failed) caught = false;
      console.info(
        `${failed ? 'CAUGHT' : 'MISSED'}  ${item.id.padEnd(28)} judge:${verdict.score} (${verdict.reason}) breaks: ${item.breaks}`,
      );
    }
    if (dry) {
      console.info(dryReportLine('signup-provider-notice --broken', [judge.plan]));
      return;
    }
    console.info(
      `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
    );
    console.info(`broken-mode calibration: ${caught ? 'PASS' : 'FAIL'}`);
    process.exit(caught ? 0 : 1);
  }

  const results = [];
  for (const fixture of SIGNUP_PROVIDER_NOTICE_FIXTURES) {
    let violation = null;
    let draft = null;
    let bubbles = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const call = await cachedToolCall({
        tag: `signup-provider-notice:${fixture.id}${violation ? ':retry' : ''}`,
        lane,
        system: skill.instructions,
        userMessage: writer.providerNoticeUserMessage(fixture.facts, violation),
        toolName: writer.SIGNUP_PROVIDER_NOTICE_TOOL,
        toolDescription: writer.SIGNUP_PROVIDER_NOTICE_TOOL_DESCRIPTION,
        toolSchema: writer.SIGNUP_PROVIDER_NOTICE_TOOL_SCHEMA,
        maxTokens: writer.SIGNUP_PROVIDER_NOTICE_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      draft = writer.signupProviderNoticeSchema.safeParse(call.value);
      const raw = draft.success
        ? bubblesLib.asBubbles(draft.data.bubbles ?? draft.data.text ?? null)
        : null;
      if (!raw) break;
      const sent = raw.map(planWriter.planReplyText);
      const violations = sent.flatMap((text) => planWriter.planReplyViolations(text));
      if (violations.length === 0) {
        bubbles = sent;
        break;
      }
      violation = violations.join('; ');
    }
    const failures = [];
    let card = null;
    if (!bubbles) {
      failures.push(`nothing sent: ${draft?.success ? (violation ?? 'no bubbles') : 'schema'}`);
    } else {
      const kept = keptCardWithReason(writer, draft.data.card, fixture.facts);
      card = kept.card;
      if (fixture.facts.loginCard && card === null) {
        failures.push(`card not kept, the preview would be the bare host: ${kept.reason}`);
      }
      const verdict = await judge(fixture.id, {
        facts: fixture.facts,
        bubbles,
        card,
        watchFor: fixture.watchFor,
      });
      if (!dry && verdict.score < JUDGE_MIN) {
        failures.push(`judge:${verdict.score} (${verdict.reason})`);
      }
    }
    results.push({ fixture, bubbles, card, failures });
  }
  if (dry) {
    console.info(dryReportLine('signup-provider-notice', [judge.plan]));
    return;
  }
  for (const r of results) {
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(24)} ${JSON.stringify({ bubbles: r.bubbles, card: r.card })}`,
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
    'signup-provider-notice eval harness error:',
    err instanceof Error ? err.message : err,
  );
  process.exit(2);
});
