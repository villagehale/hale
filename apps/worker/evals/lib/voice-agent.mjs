// One cached `runAgent` round-trip for a NO-TOOLS voice skill.
//
// The voice stages (reminder, week-summary, welcome) do not use the forced-tool-JSON
// shape the structured agents use — they run the real `runAgent` loop with an empty tool
// list and parse a JSON object out of the answer text, because that is what
// apps/web/lib/loop/voice/compose.ts does. Driving that from an eval needs three things
// every time: a client whose `messages.create` is content-addressed, guard deps that
// satisfy the signature without ever firing (no tools means no tool calls to guard), and
// a loud failure on a cache miss in --cached-only so CI can never silently spend.
//
// run-agent-eval.mjs grew its own copy of this first. This module exists so the reminder
// suite is not a second one — and it charges usage against the ACTUAL model rather than
// assuming Sonnet, which that copy does.

import { cacheGet, cacheKey, cachePut, noteUsage } from './harness.mjs';

/** Guard deps that satisfy the signature and never fire: a no-tools skill dispatches no
 * tool, so there is nothing to audit and no child content to check. Anything that DID
 * reach them would be a bug worth seeing, so the audit hook records rather than ignores. */
function inertGuardDeps(auditLog) {
  return {
    async writeAudit(entry) {
      auditLog.push(entry);
    },
    async checkChildContentAccess() {
      return { ok: true, reason: 'ok' };
    },
  };
}

/**
 * Run one voice composition and return the model's answer text (or null when the loop
 * produced none). Replays byte-for-byte from cache on a hit; makes zero API calls.
 *
 * @returns {Promise<string|null>} the raw answer text, for the caller's own parse.
 */
export async function cachedAgentAnswer({
  tag,
  agent,
  skill,
  context,
  maxTokens,
  cachedOnly,
  getClient,
  cost,
  familyId = 'fixture-family',
}) {
  const auditLog = [];
  const client = {
    messages: {
      async create(params) {
        const canonical = JSON.stringify({
          model: params.model,
          system: params.system,
          messages: params.messages,
          max_tokens: params.max_tokens,
        });
        const key = cacheKey(`${tag}:voice`, canonical);

        const cached = await cacheGet(key);
        if (cached) return cached.response;

        if (cachedOnly) {
          console.error(
            `voice cache miss in --cached-only mode (${tag}, key ${key}). Re-run live (with --env-file) to populate, then commit the cache.`,
          );
          process.exit(1);
        }

        const response = await getClient().messages.create(params);
        noteUsage(cost, params.model, response.usage);
        // The raw SDK message shape runAgent consumes, as a plain object so JSON
        // round-trips losslessly.
        const stored = {
          id: response.id,
          type: response.type,
          role: response.role,
          model: response.model,
          stop_reason: response.stop_reason,
          stop_sequence: response.stop_sequence,
          content: response.content,
          usage: response.usage,
        };
        await cachePut(key, { response: stored });
        return stored;
      },
    },
  };

  const run = await agent.runAgent({
    skill,
    context,
    tools: [],
    client,
    maxSteps: 1,
    maxTokens,
    toolContext: { familyId, actor: 'system' },
    guardDeps: inertGuardDeps(auditLog),
  });
  return run.answer;
}
