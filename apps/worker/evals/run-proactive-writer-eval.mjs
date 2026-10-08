// VIL-226 · proactive writer eval (hard rule #8: no LLM mocking).
//
// Cached-only collects every miss and exits 1. Do not commit a cache.
//
//   node evals/run-proactive-writer-eval.mjs --cached-only

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
import { PROACTIVE_WRITER_FIXTURES } from './proactive-writer-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'proactive-writer.md');
const MAX_TOKENS = 400;

const TEMPLATES = ['reply yes', 'just checking in', 'hope this helps'];

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

function parseMessage(text) {
  const json = firstJsonObject(text ?? '');
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw.message !== 'string' || raw.message.trim().length === 0) return null;
    return raw.message.trim();
  } catch {
    return null;
  }
}

/** Mirrors `withActivityLinks` in apps/web/lib/channel/proactive/compose.ts. */
function withActivityLinks(message, items) {
  let next = message;
  for (const item of items) {
    if (!item.sourceUrl || next.includes(item.sourceUrl)) continue;
    const words = item.what
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4);
    if (words.length === 0) continue;
    const body = next.toLowerCase();
    if (!words.every((word) => body.includes(word))) continue;
    next = `${next} ${item.sourceUrl}`;
  }
  return next;
}

function grade(fixture, message) {
  const failures = [];
  if (!message) return ['answer did not parse'];
  const body = message.toLowerCase();
  if (body.includes('\n')) failures.push('more than one message');
  for (const name of fixture.expect.names) {
    if (!body.includes(name)) failures.push(`never names ${name}`);
  }
  for (const url of fixture.expect.urls) {
    if (!message.includes(url)) failures.push(`missing ${url}`);
  }
  for (const phrase of TEMPLATES) {
    if (body.includes(phrase)) failures.push(`template "${phrase}"`);
  }
  return failures;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const calls = PROACTIVE_WRITER_FIXTURES.map((fixture) => {
    const context = {
      items: fixture.items,
      ...(fixture.note ? { note: fixture.note } : {}),
    };
    const system = `${skill.instructions}\n\n## Context\n\n${JSON.stringify(context)}`;
    const userMessage = JSON.stringify(context);
    const tag = evalRunTag(`proactive-writer:${fixture.id}`);
    const key = cacheKey(tag, JSON.stringify({ model, system, userMessage }));
    return { fixture, system, userMessage, tag, key };
  });

  if (cachedOnly) {
    const misses = [];
    for (const call of calls) {
      if (!(await cacheGet(call.key))) misses.push(call);
    }
    if (misses.length > 0) {
      console.error(`proactive-writer: ${misses.length} cache miss(es) in --cached-only`);
      for (const miss of misses) {
        console.error(`  ${miss.fixture.id}  ${miss.key}`);
      }
      console.error('Re-run live to populate. Do not commit a cache from a partial run.');
      process.exit(1);
    }
  }

  console.info(
    `proactive-writer | ${cachedOnly ? 'cached-only' : 'live'} | model=${model} | fixtures=${calls.length}`,
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
    const message = withActivityLinks(parseMessage(text) ?? '', call.fixture.items);
    const failures = grade(call.fixture, message || null);
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
