// Group RSVP reader · classifier eval (VIL-102, hard rule #8: no LLM mocking).
//
// Judges the intent label, never a word in the message.
//
//   node evals/run-group-rsvp-read-eval.mjs --max-usd 0.20
//   node evals/run-group-rsvp-read-eval.mjs --broken
//   node evals/run-group-rsvp-read-eval.mjs --cached-only
//
// Dry worst-case for one live run (7 fixtures, one retry, Haiku screen): ~$0.01.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { GROUP_RSVP_READ_FIXTURES } from './group-rsvp-read-fixtures.mjs';
import {
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-rsvp-read.md');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-rsvp-read.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('group-rsvp-read');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { RSVP_INTENTS, groupRsvpUserMessage } = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const toolSchema = {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: [...RSVP_INTENTS] },
      confidence: { type: 'number' },
      event: {
        type: 'object',
        properties: {
          title: { type: ['string', 'null'] },
          whenText: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
        },
      },
      householdName: { type: ['string', 'null'] },
    },
    required: ['intent', 'confidence'],
  };

  console.log(
    `group-rsvp-read eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );
  const results = [];
  for (const fixture of GROUP_RSVP_READ_FIXTURES) {
    const intent = broken
      ? 'track'
      : (
          await cachedToolCall({
            tag: `group-rsvp-read:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: groupRsvpUserMessage(fixture.input),
            toolName: 'group_rsvp',
            toolSchema,
            toolDescription: 'Return what this group message means for the RSVP tally.',
            maxTokens: 250,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.intent;
    results.push({ fixture, intent, pass: fixture.accept.includes(intent) });
  }
  for (const r of results) {
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(22)} intent=${r.intent} accept=${r.fixture.accept.join('|')}`,
    );
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.pass);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('group-rsvp-read eval harness error:', err);
  process.exit(2);
});
