// Consent-reply eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/consent-reply.md) through the
// REAL request shape apps/web/lib/channel/consent-reply.ts builds. Grade is exact
// match on verdict + target. Do not add this to CI until a recording exists.
//
// Usage (from apps/worker):
//   node evals/consent-reply-eval.mjs --dry
//   node evals/consent-reply-eval.mjs --cached-only
//   node --env-file=../../.env evals/consent-reply-eval.mjs
//
// Not named run-*.mjs, so CI's eval sweep does not pick it up until a recording exists.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { CONSENT_REPLY_FIXTURES } from './consent-reply-fixtures.mjs';
import {
  REPO_ROOT,
  cachedToolCall,
  dryReportLine,
  isDryRun,
  lazyAnthropic,
  makeCost,
  readModelIds,
} from './lib/harness.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'consent-reply.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'consent-reply.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

function laneModel(task, ids) {
  if (['screen', 'answer', 'speak', 'triage', 'acknowledge'].includes(task)) return ids.haiku;
  throw new Error(`consent-reply lane ${task} is not a Haiku lane; update the estimate first`);
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await importTs(AGENT_SRC);
  const { CONSENT_REPLY_MAX_TOKENS, CONSENT_REPLY_TOOL, CONSENT_REPLY_TOOL_SCHEMA, consentReplyUserMessage } =
    await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL);
  const ids = await readModelIds();
  const model = laneModel(skill.meta.task, ids);
  const lane = agent.pickLane(skill.meta.task);
  const getClient = lazyAnthropic();
  const cost = makeCost();
  let failed = 0;
  for (const f of CONSENT_REPLY_FIXTURES) {
    const out = (
      await cachedToolCall({
        tag: `consent-reply:${f.id}`,
        model,
        lane,
        system: skill.instructions,
        userMessage: consentReplyUserMessage({
          question: f.question,
          text: f.text,
          lastHaleMessage: f.lastHaleMessage,
        }),
        toolName: CONSENT_REPLY_TOOL,
        toolDescription: 'Decide whether this message agrees, refuses, or does neither.',
        toolSchema: CONSENT_REPLY_TOOL_SCHEMA,
        maxTokens: CONSENT_REPLY_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      })
    )?.value;
    const verdict = out?.verdict ?? null;
    const target = out?.target ?? null;
    const ok = verdict === f.expect.verdict && target === f.expect.target;
    if (!ok) failed += 1;
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${f.id}  verdict=${verdict} target=${target} expected=${f.expect.verdict}/${f.expect.target}`,
    );
  }
  if (isDryRun()) {
    console.info(dryReportLine('consent-reply', []));
    return;
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
