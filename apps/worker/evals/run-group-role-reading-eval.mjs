// Group role reading · classifier eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/group-role-reading.md) on the
// replies the code cues in apps/web/lib/channel/linq/roster-reading.ts could NOT read
// (that module is pure and loaded live: each fixture first proves the cues leave it
// unclear, so the corpus is exactly what the model sees in production). The model's raw
// answer then goes through the real `acceptRosterRoleVerdict` confidence gate.
//
// WHY A PARENT READING IS A HARD ZERO. A `parent` / `mom` / `dad` reading seats the person
// as a co-parent with full scope over the family. Reading a godmother, an in-law or a
// joke as a parent hands a stranger a family; reading a parent as unclear only costs one
// re-ask. So every fixture lists the readings it accepts, and any seat outside that list
// fails the run.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-group-role-reading-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-group-role-reading-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-group-role-reading-eval.mjs --cached-only                    # CI: replay only

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { cachedToolCall, lazyAnthropic, makeCost, totalUsd } from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-role-reading.md');
const READING_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'roster-reading.ts');
const CLASSIFIER_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'linq',
  'roster-role-classifier.ts',
);

/** Same ceiling as CLASSIFIER_MAX_TOKENS in roster-role-classifier.ts. */
const MAX_TOKENS = 100;
const MIN_EXACT = 0.8;

// `accept` is every reading that is right enough; `best` is the one counted as exact.
// A reading is `unclear` or a role from ROSTER_ROLES, after the confidence gate.
const FIXTURES = [
  { id: 'bubbie', reply: "I'm the kids' Bubbie", best: 'grandparent', accept: ['grandparent'] },
  { id: 'oma', reply: 'Oma here', best: 'grandparent', accept: ['grandparent'] },
  { id: 'memere-fr', reply: "c'est mémère", best: 'grandparent', accept: ['grandparent'] },
  { id: 'die-oma-de', reply: 'ich bin die Oma', best: 'grandparent', accept: ['grandparent'] },
  {
    id: 'godmother',
    reply: "I'm their godmother",
    best: 'not_family',
    accept: ['not_family', 'unclear'],
  },
  {
    id: 'dads-girlfriend',
    reply: "their dad's girlfriend",
    best: 'unclear',
    accept: ['unclear', 'not_family'],
  },
  {
    id: 'mother-in-law',
    reply: "I'm their mother-in-law",
    best: 'unclear',
    accept: ['unclear', 'grandparent'],
  },
  { id: 'its-me', reply: "it's me lol", best: 'unclear', accept: ['unclear'] },
  { id: 'question-back', reply: 'who is this?', best: 'unclear', accept: ['unclear'] },
  {
    id: 'wednesdays-fr',
    reply: 'je garde les enfants le mercredi',
    best: 'babysitter',
    accept: ['babysitter', 'nanny', 'unclear'],
  },
  { id: 'dont-include', reply: "please don't include me", best: 'decline', accept: ['decline'] },
  {
    id: 'parenting-team',
    reply: 'the other half of this parenting team',
    best: 'parent',
    accept: ['parent', 'unclear'],
  },
  {
    id: 'had-them',
    reply: "I'm the one who had them",
    best: 'mom',
    accept: ['mom', 'parent', 'unclear'],
  },
  { id: 'busy-mom', reply: 'their mom is at work rn', best: 'unclear', accept: ['unclear'] },
];

const PARENT_READINGS = new Set(['parent', 'mom', 'dad']);

/** The reading as the eval names it: `mom` / `dad` for a parent with a role. */
function named(reading) {
  if (reading.kind === 'unclear') return 'unclear';
  if (reading.role === 'parent' && reading.parentRole === 'mother') return 'mom';
  if (reading.role === 'parent' && reading.parentRole === 'father') return 'dad';
  return reading.role;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { readRosterReply, acceptRosterRoleVerdict, ROSTER_ROLE_MODEL_ANSWERS } = await tsImport(
    READING_SRC,
    import.meta.url,
  );
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  // The tool shape the web app sends, read from its source so a drift is visible here.
  const classifierSource = await readFile(CLASSIFIER_SRC, 'utf8');
  if (!classifierSource.includes("toolName: 'role'")) {
    throw new Error('roster-role-classifier.ts no longer names its tool `role`; update this eval');
  }
  const toolSchema = {
    type: 'object',
    properties: {
      role: { type: 'string', enum: [...ROSTER_ROLE_MODEL_ANSWERS] },
      confidence: { type: 'number' },
    },
    required: ['role', 'confidence'],
  };

  console.log(
    `group-role-reading eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );

  const results = [];
  for (const fixture of FIXTURES) {
    const cued = readRosterReply(fixture.reply);
    if (cued.kind !== 'unclear') {
      throw new Error(`fixture ${fixture.id} is read by the cues; the model never sees it`);
    }
    const raw = broken
      ? { role: 'mom', confidence: 1 }
      : (
          await cachedToolCall({
            tag: `group-role-reading:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage: JSON.stringify({ reply: fixture.reply }),
            toolName: 'role',
            toolSchema,
            toolDescription:
              'Return who this person said they are in the family, and how sure you are.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    const reading = named(acceptRosterRoleVerdict(raw));
    const failures = [];
    if (!fixture.accept.includes(reading)) {
      failures.push(
        PARENT_READINGS.has(reading) ? `HARD ZERO parent reading: ${reading}` : `wrong: ${reading}`,
      );
    }
    results.push({ fixture, reading, exact: reading === fixture.best, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(18)} -> ${r.reading}${r.exact ? '' : ` (best ${r.fixture.best})`}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  const exactRate = results.filter((r) => r.exact).length / results.length;
  const hardZeros = results.filter((r) => r.failures.some((f) => f.startsWith('HARD ZERO')));
  console.log(`\nexact: ${(exactRate * 100).toFixed(0)}% (>= ${MIN_EXACT * 100}% required)`);
  console.log(`parent readings outside accept: ${hardZeros.length} (0 required)`);
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0) && exactRate >= MIN_EXACT;
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  console.log(
    `broken-mode calibration (must fail): ${!allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(!allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('group-role-reading eval harness error:', err);
  process.exit(2);
});
