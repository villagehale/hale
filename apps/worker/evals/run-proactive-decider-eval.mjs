// VIL-226 · proactive decider eval (hard rule #8: no LLM mocking).
//
// The subject is packages/agent/skills/proactive-decider.md, through the same
// no-tools request shape the nudge eval replicates from runAgent. Cached-only
// collects every miss and exits 1. Do not commit a cache from this runner
// until a live re-record; CI is expected to fail this job until then.
//
//   node evals/run-proactive-decider-eval.mjs --cached-only
//   node --env-file=../../.env evals/run-proactive-decider-eval.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  cacheGet,
  cacheKey,
  cachedTextCall,
  evalRunTag,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import { PROACTIVE_DECIDER_FIXTURES } from './proactive-decider-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'proactive-decider.md');
const DATETIME_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'format', 'datetime.ts');
const MAX_TOKENS = 500;
const THURSDAY_EVENING = 'Thursday 6:00 PM America/Toronto';

function assertThursdayEveningSend(formatSnapshotLocalNow) {
  for (const id of ['empty-weekend', 'weekend-and-deadline']) {
    const fixture = PROACTIVE_DECIDER_FIXTURES.find((item) => item.id === id);
    if (!fixture) throw new Error(`missing decider fixture ${id}`);
    const localNow = formatSnapshotLocalNow(
      new Date(fixture.snapshot.now),
      fixture.snapshot.timeZone,
    );
    if (localNow !== THURSDAY_EVENING) {
      throw new Error(`${id} localNow is ${localNow}, expected ${THURSDAY_EVENING}`);
    }
    if (fixture.expect.action !== 'send_now') {
      throw new Error(`${id} at ${THURSDAY_EVENING} must expect send_now`);
    }
    const weekend = fixture.snapshot.candidates.some((item) =>
      /saturday|fanous/i.test(`${item.what} ${item.why}`),
    );
    if (!weekend) throw new Error(`${id} has no weekend find`);
  }
}

function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseDecision(text) {
  const json = firstJsonObject(text ?? '');
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.action !== 'send_now' && raw.action !== 'hold' && raw.action !== 'drop') return null;
    if (!Array.isArray(raw.item_ids) || raw.item_ids.some((id) => typeof id !== 'string')) {
      return null;
    }
    if (typeof raw.reason !== 'string' || raw.reason.trim().length === 0) return null;
    if (raw.hold_until != null && typeof raw.hold_until !== 'string') return null;
    const pref = raw.frequency_preference;
    if (pref != null) {
      if (
        typeof pref !== 'object' ||
        (pref.direction !== 'less' && pref.direction !== 'more') ||
        typeof pref.note !== 'string'
      ) {
        return null;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

function grade(fixture, decision) {
  const failures = [];
  if (!decision) return ['answer did not parse'];
  const expect = fixture.expect;
  if (expect.action && decision.action !== expect.action) {
    failures.push(`action ${decision.action} !== ${expect.action}`);
  }
  if (expect.actionIn && !expect.actionIn.includes(decision.action)) {
    failures.push(`action ${decision.action} not in ${expect.actionIn.join('|')}`);
  }
  for (const id of expect.includes ?? []) {
    if (!decision.item_ids.includes(id)) failures.push(`missing item ${id}`);
  }
  for (const id of expect.excludes ?? []) {
    if (decision.item_ids.includes(id)) failures.push(`included ${id}`);
  }
  if (expect.exact) {
    const got = [...decision.item_ids].sort();
    const want = [...(expect.includes ?? [])].sort();
    if (got.join('|') !== want.join('|')) {
      failures.push(`items ${got.join(',')} !== ${want.join(',')}`);
    }
  }
  const direction = decision.frequency_preference?.direction ?? null;
  if (expect.frequency && direction !== expect.frequency) {
    failures.push(`frequency ${direction} !== ${expect.frequency}`);
  }
  if (expect.frequency === null && direction !== null) {
    failures.push(`set a frequency preference (${direction}) nobody asked for`);
  }
  return failures;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { formatSnapshotLocalNow } = await tsImport(DATETIME_SRC, import.meta.url);
  assertThursdayEveningSend(formatSnapshotLocalNow);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const calls = PROACTIVE_DECIDER_FIXTURES.map((fixture) => {
    const snapshot = {
      ...fixture.snapshot,
      localNow: formatSnapshotLocalNow(new Date(fixture.snapshot.now), fixture.snapshot.timeZone),
    };
    const system = `${skill.instructions}\n\n## Context\n\n${JSON.stringify(snapshot)}`;
    const userMessage = JSON.stringify(snapshot);
    const tag = evalRunTag(`proactive-decider:${fixture.id}`);
    const key = cacheKey(tag, JSON.stringify({ model, system, userMessage }));
    return { fixture, system, userMessage, tag, key };
  });

  if (cachedOnly) {
    const misses = [];
    for (const call of calls) {
      if (!(await cacheGet(call.key))) misses.push(call);
    }
    if (misses.length > 0) {
      console.error(`proactive-decider: ${misses.length} cache miss(es) in --cached-only`);
      for (const miss of misses) {
        console.error(`  ${miss.fixture.id}  ${miss.key}`);
      }
      console.error('Re-run live to populate. Do not commit a cache from a partial run.');
      process.exit(1);
    }
  }

  console.info(
    `proactive-decider | ${cachedOnly ? 'cached-only' : 'live'} | model=${model} | fixtures=${calls.length}`,
  );
  let failed = 0;
  for (const call of calls) {
    const { text } = await cachedTextCall({
      tag: call.tag,
      model,
      system: call.system,
      userMessage: call.userMessage,
      maxTokens: MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const failures = grade(call.fixture, parseDecision(text));
    const ok = failures.length === 0;
    if (!ok) failed += 1;
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${call.fixture.id}`);
    for (const failure of failures) console.info(`        - ${failure}`);
  }
  console.info(
    `\nlive API calls: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
