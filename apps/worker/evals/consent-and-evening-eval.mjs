// Consent and evening-request estimate (hard rule #8: no LLM mocking, and
// this file does not call the API).
//
// SUBJECTS, called the way the runtime calls them:
//   packages/agent/skills/evening-request.md  apps/web/lib/channel/checkin/request.ts
//   packages/agent/skills/consent-reply.md    apps/web/lib/channel/consent-reply.ts
//   packages/agent/skills/consent-ask.md      apps/web/lib/channel/consent-ask.ts
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it
// up. It is not in package.json and not in ci.yml. There is no committed cache.
//
//   node evals/consent-and-evening-eval.mjs --estimate
//
// --estimate prices the three suites over their fixtures at max_tokens and
// exits 0. It does not call the API and it does not write a cache file.
// Barton taps before any recording.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { CONSENT_ASK_FIXTURES } from './consent-ask-fixtures.mjs';
import { CONSENT_REPLY_FIXTURES } from './consent-reply-fixtures.mjs';
import { EVENING_REQUEST_FIXTURES } from './evening-request-fixtures.mjs';
import { PRICE, REPO_ROOT } from './lib/harness.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

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

function suiteUsd({ lane, skill, fixtures, userOf, tool, maxTokens }) {
  let usd = 0;
  for (const fixture of fixtures) {
    const input =
      estimateTokens(skill.instructions) + estimateTokens(userOf(fixture)) + estimateTokens(tool);
    usd += priced(lane.model, input, maxTokens);
  }
  return usd;
}

async function main() {
  if (!process.argv.includes('--estimate')) {
    console.error('consent-and-evening: pass --estimate. This runner does not call the API.');
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const evening = await importTs(
    join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'checkin', 'request.ts'),
  );
  const reply = await importTs(
    join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'consent-reply.ts'),
  );
  const ask = await importTs(join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'consent-ask.ts'));

  const eveningSkill = await agent.loadSkill(
    join(REPO_ROOT, 'packages', 'agent', 'skills', 'evening-request.md'),
  );
  const replySkill = await agent.loadSkill(
    join(REPO_ROOT, 'packages', 'agent', 'skills', 'consent-reply.md'),
  );
  const askSkill = await agent.loadSkill(
    join(REPO_ROOT, 'packages', 'agent', 'skills', 'consent-ask.md'),
  );

  const parts = [
    {
      name: 'evening-request',
      fixtures: EVENING_REQUEST_FIXTURES.length,
      lane: agent.pickLane(eveningSkill.meta.task).model,
      usd: suiteUsd({
        lane: agent.pickLane(eveningSkill.meta.task),
        skill: eveningSkill,
        fixtures: EVENING_REQUEST_FIXTURES,
        userOf: (fixture) => evening.eveningRequestUserMessage(fixture.text),
        tool: {
          name: evening.EVENING_REQUEST_TOOL,
          description: 'Decide whether this message asks Hale for something.',
          input_schema: evening.EVENING_REQUEST_TOOL_SCHEMA,
        },
        maxTokens: evening.EVENING_REQUEST_MAX_TOKENS,
      }),
    },
    {
      name: 'consent-reply',
      fixtures: CONSENT_REPLY_FIXTURES.length,
      lane: agent.pickLane(replySkill.meta.task).model,
      usd: suiteUsd({
        lane: agent.pickLane(replySkill.meta.task),
        skill: replySkill,
        fixtures: CONSENT_REPLY_FIXTURES,
        userOf: (fixture) =>
          reply.consentReplyUserMessage({ question: fixture.question, text: fixture.text }),
        tool: {
          name: reply.CONSENT_REPLY_TOOL,
          description: 'Decide whether this message agrees, refuses, or does neither.',
          input_schema: reply.CONSENT_REPLY_TOOL_SCHEMA,
        },
        maxTokens: reply.CONSENT_REPLY_MAX_TOKENS,
      }),
    },
    {
      name: 'consent-ask',
      fixtures: CONSENT_ASK_FIXTURES.length,
      lane: agent.pickLane(askSkill.meta.task).model,
      usd: suiteUsd({
        lane: agent.pickLane(askSkill.meta.task),
        skill: askSkill,
        fixtures: CONSENT_ASK_FIXTURES,
        userOf: (fixture) => ask.consentAskUserMessage(fixture.ask),
        tool: {
          name: ask.CONSENT_ASK_TOOL,
          description: 'Write the one text this person will see.',
          input_schema: ask.CONSENT_ASK_TOOL_SCHEMA,
        },
        maxTokens: ask.CONSENT_ASK_MAX_TOKENS,
      }),
    },
  ];

  const usd = parts.reduce((sum, part) => sum + part.usd, 0);
  const fixtures = parts.reduce((sum, part) => sum + part.fixtures, 0);
  for (const part of parts) {
    console.info(
      `${part.name}: ${part.fixtures} fixtures on ${part.lane}, priced at max_tokens. $${part.usd.toFixed(4)} USD`,
    );
  }
  console.info(
    `consent-and-evening: one estimate to record ${fixtures} fixtures, priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
