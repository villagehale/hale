#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { z } from 'zod';
import {
  cacheGet,
  cacheKey,
  cachePut,
  evalAnthropicRequest,
  evalRunTag,
  lazyAnthropic,
  makeCost,
  noteLatency,
  noteUsage,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(ROOT, 'packages', 'agent', 'skills');
const MODEL =
  process.argv.find((arg) => arg.startsWith('--anthropic-model='))?.split('=')[1] ??
  'claude-sonnet-5-5';
const cachedOnly = process.argv.includes('--cached-only');

const candidates = [
  { id: 'swim', kind: 'class', title: 'Toddler swim', summary: 'Ages 1-3', teenAttributed: false },
  {
    id: 'story',
    kind: 'drop_in',
    title: 'Library story time',
    summary: 'All young children',
    teenAttributed: false,
  },
  { id: 'teen', kind: 'class', title: null, summary: null, teenAttributed: true },
];
const outputs = {
  list_village_candidates: { candidates },
  get_family_fit_context: { childStages: ['toddler'], intents: ['swimming'], areaCoarse: 'M5V' },
  get_family_tastes: {
    tastes: [
      { factType: 'preference', factKey: 'activity', factValue: 'swimming', confidence: 0.9 },
    ],
  },
  get_endorsement_signals: {
    endorsements: [
      { candidateId: 'swim', endorsementCount: 3 },
      { candidateId: 'story', endorsementCount: 6 },
      { candidateId: 'teen', endorsementCount: 10 },
    ],
  },
};

function cachedClient(tag, getClient, cost) {
  return {
    messages: {
      async create(params) {
        const request = evalAnthropicRequest(params, MODEL);
        const key = cacheKey(evalRunTag(tag), JSON.stringify(request));
        const cached = await cacheGet(key);
        if (cached) return cached.response;
        if (cachedOnly) throw new Error(`cache miss: ${tag} (${key})`);
        const started = Date.now();
        const response = await getClient().messages.create(request);
        noteLatency(MODEL, Date.now() - started);
        noteUsage(cost, MODEL, response.usage);
        await cachePut(key, { response });
        return response;
      },
    },
  };
}

function parseIds(answer) {
  const match = answer?.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]).filter((value) => typeof value === 'string');
  } catch {
    return [];
  }
}

async function runOne(agent, name, getClient, cost) {
  const calls = [];
  const tools = Object.entries(outputs).map(([toolName, output]) =>
    agent.defineTool({
      name: toolName,
      description: `Return fixture ${toolName.replaceAll('_', ' ')}.`,
      inputSchema:
        toolName === 'get_endorsement_signals'
          ? z.object({ candidateIds: z.array(z.string()) })
          : z.object({}),
      monetary: false,
      touchesChildContent: false,
      async handler() {
        calls.push(toolName);
        return output;
      },
    }),
  );
  const skill = await agent.loadSkill(join(SKILLS, `${name}.md`));
  const result = await agent.runAgent({
    skill,
    context: { candidateIds: candidates.map((candidate) => candidate.id) },
    tools,
    client: cachedClient(`village-${name}`, getClient, cost),
    maxSteps: 6,
    maxTokens: 1024,
    toolContext: { familyId: 'fixture-family', actor: 'eval' },
    guardDeps: {
      async writeAudit() {},
      async checkChildContentAccess() {
        return { ok: true, reason: 'ok' };
      },
    },
  });
  const ids = parseIds(result.answer);
  const known = new Set(candidates.map((candidate) => candidate.id));
  const allSignalsRead = Object.keys(outputs).every((toolName) => calls.includes(toolName));
  const valid =
    ids.length > 0 && ids.every((id) => known.has(id)) && new Set(ids).size === ids.length;
  const pass =
    name === 'rank-recommendations'
      ? allSignalsRead && valid && ids.length === candidates.length && ids[0] === 'swim'
      : allSignalsRead && valid && ids[0] === 'swim' && !ids.includes('teen');
  console.info(
    `${pass ? 'PASS' : 'FAIL'} ${name} calls=${calls.join(',')} ids=${JSON.stringify(ids)}`,
  );
  return pass;
}

async function main() {
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const getClient = lazyAnthropic();
  const cost = makeCost();
  const results = [];
  for (const name of ['rank-recommendations', 'curate-shortlist']) {
    results.push(await runOne(agent, name, getClient, cost));
  }
  console.info(`calls=${cost.liveCalls} cost=$${totalUsd(cost).toFixed(4)}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((error) => {
  console.error('village rank smoke error:', error);
  process.exit(2);
});
