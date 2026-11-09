#!/usr/bin/env node
// Village eval harness (discovery floor).
//
// DISCOVERY (Fake floor) is pure, deterministic, network-free logic, so it needs
// no model at all: we run the REAL FakeDiscoveryProvider as the subject and do a
// reference-recall check (did the curated items a stage/interest query should
// surface actually surface? are confidence + source honest?). Zero spend, always.
//
// Copying the provider's SEED table into the harness would be a second source of
// truth, so we IMPORT the live src/agents/discovery-providers/fake.ts via the tsx
// loader, never the stale dist.
//
// The routine leg this file used to score replicated runRoutine, which #575 deleted
// with the routine agent (founder: "the leg goes"). It gated an agent that no longer
// ships, so it is gone too.
//
// Run from the worker package dir (apps/worker), like the other eval scripts:
//   node evals/run-village-eval.mjs --cached-only   # what the weekly sweep runs; never calls the API

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const FAKE_PROVIDER_PATH = join(WORKER_ROOT, 'src', 'agents', 'discovery-providers', 'fake.ts');
const FIXTURE_DIR = join(HERE, 'fixtures', 'village');

async function loadFixtures(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) {
    out.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
  }
  return out;
}

// --- discovery reference-recall checks (Fake provider, no API) --------------

function checkDiscovery(fixture, candidates) {
  const failures = [];
  const e = fixture.expect;
  const titles = candidates.map((c) => c.title);
  const titleSet = new Set(titles);

  for (const want of e.expectedTitles ?? []) {
    if (!titleSet.has(want)) failures.push(`expected title not surfaced: '${want}'`);
  }
  for (const banned of e.forbiddenTitles ?? []) {
    if (titleSet.has(banned)) failures.push(`forbidden title surfaced: '${banned}'`);
  }

  // Honesty of the floor's provenance/confidence fields (rule #1 + the
  // provider contract): a curated guess is never asserted with certainty and
  // always carries a coverage note and an echoed coarse area; it never emits a
  // finer (child-pinpointing) location via sourceUrl.
  for (const c of candidates) {
    if (c.source !== 'curated_seed') {
      failures.push(`candidate '${c.title}' source '${c.source}' != 'curated_seed'`);
    }
    if (!(c.confidence > 0 && c.confidence < 1)) {
      failures.push(`candidate '${c.title}' confidence ${c.confidence} not honest (0<c<1)`);
    }
    if (typeof c.coverageNote !== 'string' || c.coverageNote.length === 0) {
      failures.push(`candidate '${c.title}' has empty coverageNote`);
    }
    if (c.areaCoarse !== fixture.input.areaCoarse) {
      failures.push(
        `candidate '${c.title}' areaCoarse '${c.areaCoarse}' != query '${fixture.input.areaCoarse}'`,
      );
    }
    if (c.sourceUrl !== undefined) {
      failures.push(
        `candidate '${c.title}' leaked a sourceUrl '${c.sourceUrl}' (rule #1: no finer location)`,
      );
    }
    if (typeof e.allStageFit === 'string' && c.stage !== e.allStageFit) {
      failures.push(`candidate '${c.title}' stage '${c.stage}' != expected '${e.allStageFit}'`);
    }
  }

  // Ranking: each [a, b] pair requires a to appear strictly before b — the
  // floor must rank an interest hit ahead of a stage-typical survivor.
  for (const [a, b] of e.rankedBefore ?? []) {
    const ia = titles.indexOf(a);
    const ib = titles.indexOf(b);
    if (ia < 0 || ib < 0) {
      failures.push(`ranking check needs both '${a}' and '${b}' present`);
    } else if (!(ia < ib)) {
      failures.push(`'${a}' (idx ${ia}) should rank before '${b}' (idx ${ib})`);
    }
  }

  return failures;
}

// --- main -------------------------------------------------------------------

async function main() {
  const fixtures = await loadFixtures(FIXTURE_DIR);

  // The discovery subject is the REAL Fake provider, imported live from source.
  const fakeMod = await tsImport(FAKE_PROVIDER_PATH, import.meta.url);
  const fakeProvider = new fakeMod.FakeDiscoveryProvider();

  console.log(`village-eval | discovery-provider=${fakeProvider.name} | fixtures: ${fixtures.length}`);
  console.log('');

  const failed = [];
  for (const fixture of fixtures) {
    const candidates = await fakeProvider.discover({
      areaCoarse: fixture.input.areaCoarse,
      stage: fixture.input.stage,
      interests: fixture.input.interests,
      limit: fixture.input.limit,
    });
    const failures = checkDiscovery(fixture, candidates);
    if (failures.length) {
      failed.push({ id: fixture.id, failures });
      console.log(`  FAIL ${fixture.id}`);
      for (const f of failures) console.log(`       - ${f}`);
    } else {
      console.log(`  pass ${fixture.id} (${candidates.length} candidates)`);
    }
  }

  console.log('');
  console.log(`fixtures failing checks: ${failed.length}/${fixtures.length}`);
  console.log(`overall: ${failed.length === 0 ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('village eval harness error:', err);
  process.exit(2);
});
