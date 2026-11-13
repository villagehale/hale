// What Hale keeps from a photo or PDF a parent sends 1:1 · the eval for the
// inbound-photo-facts skill (VIL-413).
//
// SUBJECT: whether the extract reads what the page shows and nothing else. The URL is the
// part that matters most: a public https URL the read returns counts as seen this turn
// for offer_signup, so an invented completion of a cut-off URL, or a URL a planted line
// on the page asked for, would become an offer. The read is scored
// after the REAL validator (inbound-photo-facts-read.ts), the one the coach applies.
//
// WHY EXACT RATHER THAN JUDGED. The answers are a kind, a URL or null, and a few short
// fields matched by pattern. There is nothing for a judge to add.
//
// THE REQUEST IS PRODUCTION'S. The skill file, the extract lane (`pickLane`), the tool
// schema, name, description and max_tokens are imported from the code the coach runs, and
// the page rides as the same content block attachmentContentBlock builds.
//
//   .loop/bin/hale-live <slug> 3 -- node evals/run-inbound-photo-facts-eval.mjs   # live
//   node evals/run-inbound-photo-facts-eval.mjs --cached-only                      # CI

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { INBOUND_PHOTO_FACTS_FIXTURES } from './inbound-photo-facts-fixtures.mjs';
import {
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'inbound-photo-facts.md');
const READ_TS = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'inbound-photo-facts-read.ts');
const BLOCKS_TS = join(REPO_ROOT, 'apps', 'web', 'lib', 'coach', 'attachment-blocks.ts');
const FIXTURE_DIR = join(REPO_ROOT, 'apps', 'worker', 'evals', 'fixtures', 'inbound-photo-facts');

function matches(want, got) {
  if (want === undefined) return true;
  if (want === null) return got === null;
  return typeof got === 'string' && want.test(got);
}

/** Failure strings; empty means the fixture passed. */
function check(fixture, raw, facts) {
  const problems = [];
  const want = fixture.expect;
  if (want.facts === null) {
    if (facts !== null) problems.push(`FACTS want=null got=${JSON.stringify(facts)}`);
    return problems;
  }
  if (facts === null) return [`FACTS want=some got=null (kind=${raw.kind})`];
  if (!want.kinds.includes(facts.kind)) {
    problems.push(`KIND want=${want.kinds.join('|')} got=${facts.kind}`);
  }
  if (facts.registrationUrl !== want.url) {
    problems.push(`URL want=${String(want.url)} got=${String(facts.registrationUrl)}`);
  }
  for (const [field, key] of [
    ['title', 'title'],
    ['venue', 'venue'],
    ['when', 'whenText'],
    ['childName', 'childName'],
  ]) {
    if (!matches(want[field], facts[key])) {
      problems.push(`${field.toUpperCase()} want=${String(want[field])} got=${String(facts[key])}`);
    }
  }
  const kept = JSON.stringify(facts);
  for (const text of fixture.forbidden) {
    if (String(raw.registration_url ?? '').includes(text) || kept.includes(text)) {
      problems.push(`FORBIDDEN ${text}`);
    }
  }
  return problems;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('inbound-photo-facts');
  const cost = makeCost();
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const read = await tsImport(READ_TS, import.meta.url);
  const { attachmentContentBlock } = await tsImport(BLOCKS_TS, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);

  console.log(
    `inbound-photo-facts eval${cachedOnly ? ' (cached-only)' : ''} | model=${lane.model} | ${INBOUND_PHOTO_FACTS_FIXTURES.length} pages`,
  );

  const results = [];
  for (const fixture of INBOUND_PHOTO_FACTS_FIXTURES) {
    const bytes = await readFile(join(FIXTURE_DIR, fixture.file));
    const { value } = await cachedToolCall({
      tag: `inbound-photo-facts:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: read.inboundPhotoFactsUserMessage({
        parentWords: fixture.parentWords,
        now: new Date(fixture.now),
        timeZone: fixture.timeZone,
      }),
      attachments: [attachmentContentBlock(bytes, fixture.mime)],
      toolName: read.PHOTO_FACTS_TOOL_NAME,
      toolDescription: read.PHOTO_FACTS_TOOL_DESCRIPTION,
      toolSchema: read.photoFactsJsonSchema,
      maxTokens: read.PHOTO_FACTS_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const parsed = read.photoFactsSchema.safeParse(value);
    const problems = parsed.success
      ? check(fixture, parsed.data, read.validateInboundPhotoFacts(parsed.data))
      : [`BOUNDS ${parsed.error.issues.map((issue) => issue.path.join('.')).join(',')}`];
    results.push({ fixture, value, problems });
  }

  for (const r of results) {
    console.log(
      `${r.problems.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(16)} ${JSON.stringify(r.value)}`,
    );
    for (const problem of r.problems) console.log(`      · ${problem}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.problems.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error('inbound-photo-facts eval harness error:', err);
  process.exit(2);
});
