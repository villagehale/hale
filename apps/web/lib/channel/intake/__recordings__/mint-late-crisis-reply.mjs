// Mint `late-crisis-reply.json` from the crisis-reply eval cache — NO new model call.
//
// The late-read crisis journey (opt-out-recovery.pglite.test.ts) replays the said-line
// writer's crisis reply for a French mental-health crisis with no known place. That is
// the SAME turn the crisis-reply eval runs live as `fr-mental-no-region`: same skill,
// same lane, byte-identical user message (crisisLineInput('mental', null, 'fr', ...)).
// So this script re-keys the eval's cache entry into the journey recorder's address
// (lib/testing/recorded-model.ts) and writes the raw-message envelope around it.
//
// Edit the skill, the lane or the crisis facts and BOTH keys move: the eval goes red on
// --cached-only, and the journey goes red with "no recording for key".
//
//   cd apps/worker && node ../web/lib/channel/intake/__recordings__/mint-late-crisis-reply.mjs

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');
const WEB = join(REPO, 'apps', 'web');
const EVAL_CACHE = join(REPO, 'apps', 'worker', 'evals', 'cache');
const OUT = join(HERE, 'late-crisis-reply.json');
const FIXTURE_ID = 'fr-mental-no-region';

register({ tsconfig: join(WEB, 'tsconfig.json') });
const importTs = (path) => import(pathToFileURL(path).href);

const sha = (value) => createHash('sha256').update(value).digest('hex');
const evalKey = (tag, canonical) => sha(`${tag}\n${canonical}`);
const journeyKey = (model, system, userMessage, thinking) =>
  sha(`${model}\n${thinking ? `thinking:${thinking}\n` : ''}${system}\n${userMessage}`);

const agent = await importTs(join(REPO, 'packages', 'agent', 'src', 'index.ts'));
const { SAID_LINE_TOOL_SCHEMA, crisisLineInput, saidLineUserMessage } = await importTs(
  join(WEB, 'lib', 'channel', 'voice', 'said-line.ts'),
);
const skill = await agent.loadSkill(join(REPO, 'packages', 'agent', 'skills', 'said-line.md'));
const lane = agent.pickLane(skill.meta.task);

// The eval's first write for this fixture: mental, no region, French. Situation and who
// do not enter a mental-health request.
const userMessage = saidLineUserMessage(crisisLineInput('mental', null, 'fr', null, null));
const canonical = JSON.stringify({
  model: lane.model,
  system: skill.instructions,
  userMessage,
  toolName: 'said_line',
  toolSchema: SAID_LINE_TOOL_SCHEMA,
  lane,
});
const tag = `crisis-line:${FIXTURE_ID}:1`;
const path = join(EVAL_CACHE, `${evalKey(tag, canonical)}.json`);
if (!existsSync(path)) {
  throw new Error(
    `no crisis-reply eval cache entry for ${tag}. Re-run the crisis-reply eval live, then this script.`,
  );
}
const { value } = JSON.parse(readFileSync(path, 'utf8'));

const key = journeyKey(
  lane.model,
  skill.instructions,
  userMessage,
  agent.laneRequestFields(lane).thinking?.type,
);
const response = agent.strictToolSchema(SAID_LINE_TOOL_SCHEMA)
  ? {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  : {
      content: [{ type: 'tool_use', id: 'transcoded-said_line', name: 'said_line', input: value }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
const recordings = {
  [key]: {
    key,
    recordedAt: new Date().toISOString(),
    request: { model: lane.model, userMessage },
    response,
  },
};
writeFileSync(OUT, `${JSON.stringify(recordings, null, 2)}\n`, 'utf8');
console.info(`${tag}  ->  ${key}\nwrote ${OUT}`);
