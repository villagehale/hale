// The activity follow-up's process judge, run inside the finder and deep evals' compose
// loops the way followup-note.ts runs it (VIL-571): after the mechanical gates pass, on
// the draft about to be sent. The request shape, the verbatim rule and the correction the
// composer is handed are imported from the runtime module, so the evals cannot drift.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { REPO_ROOT, cachedToolCall } from './harness.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const JUDGE_SRC = join(WEB_ROOT, 'lib', 'channel', 'coach', 'find-reasoning-judge.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'followup-process-judge.md');

/**
 * Returns `judgeProcess(draft, { tag, cachedOnly, getClient, cost })`, which resolves to
 * `null` when the draft may be sent, or to a violation `{ tag, reason }`:
 * `reports_process` (redraft with the named sentences) or `process_unjudged` (the judge
 * named only text the draft does not contain; production sends nothing).
 */
export async function loadFollowUpProcessJudge(agent) {
  register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
  const judge = await import(pathToFileURL(JUDGE_SRC).href);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const tool = judge.FOLLOWUP_PROCESS_TOOL;

  return async function judgeProcess(draft, { tag, cachedOnly, getClient, cost }) {
    const call = await cachedToolCall({
      tag,
      lane,
      system: skill.instructions,
      userMessage: judge.findReasoningUserMessage(draft),
      toolName: tool.name,
      toolDescription: tool.description,
      toolSchema: tool.schema,
      maxTokens: tool.maxTokens,
      cachedOnly,
      getClient,
      cost,
    });
    const named = call.value?.process_sentences;
    // Production's schema refuses this shape, and the draft is not sent (judge_failed).
    if (!Array.isArray(named)) return { tag: 'process_unjudged', reason: 'judge_failed' };
    const gate = judge.followUpProcessVerdict(draft, named);
    if (gate.verdict === 'clean') return null;
    if (gate.verdict === 'unjudged') return { tag: 'process_unjudged', reason: gate.reason };
    return {
      tag: 'reports_process',
      reason: judge.followUpProcessViolation(gate.sentences),
      sentences: gate.sentences,
    };
  };
}
