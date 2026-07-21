// Village natural-language SEARCH intent-parse eval (hard rule #8: no LLM mocking —
// gate the parser against real, cached Claude).
//
// The subject is the REAL parse-village-search skill run through the REAL @hale/agent
// runAgent loop (imported live via the tsx loader, the way the web app runs it), with
// the skill's own model (pickModel('discover') = SONNET_MODEL, read live from
// packages/agent/src/model.ts). The skill declares no tools, so the loop is a single
// round-trip that answers with a JSON intent; we REPLICATE the web parse (extract the
// first JSON object) — the web module can't be imported here (its ~/ aliases), the
// same reason the discovery eval replicates.
//
// Gates are DETERMINISTIC and derived from the SPEC of each ask, never fitted to the
// model's output: a "Montessori in fall" ask must yield season=fall + a montessori
// keyword; "swim for my 3yo this winter" must resolve the 3-year-old from the provided
// ages + season=winter; a vague ask must NOT fabricate a season; a teen-targeted ask
// must NEVER carry a concrete age (rule #1). Structured output needs no LLM judge.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-village-search-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-village-search-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-village-search-eval.mjs --cached-only                    # CI: replay only, never calls the API
//
// Calibrated BOTH directions: the real cached model passes every fixture; the --broken
// stand-in (a fixed prompt-ignoring answer) is rejected on at least one fixture.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const REPO_ROOT = join(WORKER_ROOT, '..', '..');
const MODEL_TS_PATH = join(REPO_ROOT, 'packages', 'agent', 'src', 'model.ts');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'parse-village-search.md');
const CACHE_DIR = join(HERE, 'cache');

const PRICE = { sonnet: { input: 3.0, output: 15.0 } };

// The teen boundary (STAGE_BOUNDARIES_MONTHS[2]) — a resolved age at/above this must
// never appear (rule #1). Hard-coded here so the eval has no ~/ import.
const TEEN_MONTHS = 156;

// --- single sources of truth -----------------------------------------------

async function readSonnetModel() {
  const src = await readFile(MODEL_TS_PATH, 'utf8');
  const m = src.match(/SONNET_MODEL\s*=\s*'([^']+)'/);
  if (!m) throw new Error(`could not parse SONNET_MODEL from ${MODEL_TS_PATH}`);
  return m[1];
}

// --- content-addressed cache ------------------------------------------------

function cacheKey(tag, payload) {
  return createHash('sha256').update(`${tag}\n${payload}`).digest('hex');
}
async function cacheGet(key) {
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, 'utf8'));
}
async function cachePut(key, value) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify(value, null, 2));
}

function lazyAnthropic() {
  let client;
  return () => {
    client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
  };
}

// A cache around client.messages.create so a deterministic, fixture-driven loop
// replays exactly; a miss in --cached-only mode fails loudly rather than call live.
function makeCachedAgentClient(tag, cachedOnly, getClient, cost) {
  return {
    messages: {
      async create(params) {
        const canonical = JSON.stringify({
          model: params.model,
          system: params.system,
          tools: params.tools,
          messages: params.messages,
          max_tokens: params.max_tokens,
        });
        const key = cacheKey(`${tag}:agent`, canonical);
        const cached = await cacheGet(key);
        if (cached) return cached.response;
        if (cachedOnly) {
          console.error(
            `agent cache miss in --cached-only mode (${tag}, key ${key}). Re-run live to populate, then commit the cache.`,
          );
          process.exit(1);
        }
        const response = await getClient().messages.create(params);
        cost.liveCalls += 1;
        cost.sonnetIn += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
        cost.sonnetOut += response.usage.output_tokens;
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
}

// tools:[] → invokeTool never runs, so these are inert but satisfy the signature.
const INERT_GUARD_DEPS = {
  async writeAudit() {},
  async checkChildContentAccess() {
    return { ok: true, reason: 'ok' };
  },
};

// --- REPLICATED parse (the web module can't be imported here) ---------------

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

function parseAnswer(answer) {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return {
      categories: Array.isArray(v.categories) ? v.categories : [],
      keywords: (Array.isArray(v.keywords) ? v.keywords : []).map((k) => String(k).toLowerCase()),
      season: v.season ?? null,
      childAgeMonths: typeof v.childAgeMonths === 'number' ? v.childAgeMonths : null,
      familyScoped: v.familyScoped === true,
    };
  } catch {
    return null;
  }
}

// --- fixtures (spec-derived expectations, calibrated both directions) -------

const FIXTURES = [
  {
    id: 'montessori-fall',
    prompt: 'I want to find a good Montessori start in fall',
    context: { children: [{ ageMonths: 40 }], hasTeen: false, area: 'M4K' },
    check: (p) => {
      const f = [];
      if (p.season !== 'fall') f.push(`season should be fall, got ${p.season}`);
      if (!p.keywords.some((k) => k.includes('montessori'))) f.push('missing montessori keyword');
      return f;
    },
  },
  {
    id: 'french-immersion',
    prompt: 'french immersion preschool for my little one',
    context: { children: [{ ageMonths: 44 }], hasTeen: false, area: 'H2X' },
    check: (p) => {
      const f = [];
      if (!p.keywords.some((k) => k.includes('french') || k.includes('immersion')))
        f.push('missing french/immersion keyword');
      if (p.season !== null) f.push(`no season was asked, got ${p.season}`);
      return f;
    },
  },
  {
    id: 'swim-3yo-winter',
    prompt: 'swim for my 3yo this winter',
    context: { children: [{ ageMonths: 40 }, { ageMonths: 8 }], hasTeen: false, area: 'M5V' },
    check: (p) => {
      const f = [];
      if (p.season !== 'winter') f.push(`season should be winter, got ${p.season}`);
      if (!p.keywords.some((k) => k.includes('swim'))) f.push('missing swim keyword');
      // the 3-year-old must be resolved from the provided ages (a young child, not the infant/teen)
      if (p.childAgeMonths === null || p.childAgeMonths < 24 || p.childAgeMonths >= TEEN_MONTHS)
        f.push(`childAgeMonths should resolve the 3yo, got ${p.childAgeMonths}`);
      return f;
    },
  },
  {
    id: 'vague-something-fun',
    prompt: 'something fun to do this weekend',
    context: { children: [{ ageMonths: 30 }], hasTeen: false, area: 'M4K' },
    check: (p) => {
      const f = [];
      // must NOT fabricate a season it wasn't given ("weekend" is not a season)
      if (p.season !== null) f.push(`vague ask must not fabricate a season, got ${p.season}`);
      return f;
    },
  },
  {
    id: 'chatter-not-search',
    prompt: 'how do I get my baby to sleep through the night?',
    context: { children: [{ ageMonths: 6 }], hasTeen: false, area: 'M4K' },
    check: (p) => {
      const f = [];
      // off-topic chatter still parses (never a refusal) and must not fabricate a season
      if (p === null) f.push('must still return a parseable intent, not refuse');
      else if (p.season !== null) f.push(`chatter must not fabricate a season, got ${p.season}`);
      return f;
    },
  },
  {
    id: 'teen-privacy',
    prompt: 'a coding club for my teenager',
    context: { children: [], hasTeen: true, area: 'M4K' },
    check: (p) => {
      const f = [];
      // rule #1: no teen age is ever provided, so none may surface; the ask is family-scoped
      if (p.childAgeMonths !== null) f.push(`teen age must never surface, got ${p.childAgeMonths}`);
      if (p.familyScoped !== true) f.push('a teen-targeted ask must be familyScoped');
      return f;
    },
  },
];

// The --broken stand-in: a fixed answer that ignores the prompt. It must fail at least
// one fixture's spec check (Montessori season, the teen-age guard, …) — proving teeth.
const BROKEN_ANSWER = JSON.stringify({
  categories: ['playgrounds'],
  keywords: ['generic'],
  season: 'summer',
  childAgeMonths: 200,
  familyScoped: false,
});

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const model = await readSonnetModel();
  const getClient = lazyAnthropic();
  const cost = { liveCalls: 0, sonnetIn: 0, sonnetOut: 0 };

  const skill = await agent.loadSkill(SKILL_PATH);

  console.log(
    `village-search-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );
  console.log('');

  const failing = [];
  for (const fixture of FIXTURES) {
    let answer;
    if (broken) {
      answer = BROKEN_ANSWER;
    } else {
      const client = makeCachedAgentClient(`village-search:${fixture.id}`, cachedOnly, getClient, cost);
      const run = await agent.runAgent({
        skill,
        context: {
          prompt: fixture.prompt,
          area: fixture.context.area,
          children: fixture.context.children,
          hasTeen: fixture.context.hasTeen,
        },
        tools: [],
        client,
        maxSteps: 1,
        maxTokens: 512,
        toolContext: { familyId: 'eval-family', actor: 'system' },
        guardDeps: INERT_GUARD_DEPS,
      });
      answer = run.answer;
    }

    const parsed = parseAnswer(answer);
    const failures = parsed === null ? ['answer had no usable JSON object'] : fixture.check(parsed);
    const ok = failures.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${fixture.id}`);
    if (!ok) {
      for (const f of failures) console.log(`        - ${f}`);
      failing.push(fixture.id);
    }
  }

  const estUsd = (cost.sonnetIn / 1e6) * PRICE.sonnet.input + (cost.sonnetOut / 1e6) * PRICE.sonnet.output;
  console.log('');
  console.log(`live API calls this run: ${cost.liveCalls} | estimated cost: $${estUsd.toFixed(4)} USD`);
  console.log('');
  console.log('--- gate ---');
  console.log(`fixtures failing checks: ${failing.length}/${FIXTURES.length}`);

  const allPass = failing.length === 0;
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const calibrated = !allPass;
  console.log(`broken-mode calibration (must fail at least one): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('village-search eval harness error:', err);
  process.exit(2);
});
