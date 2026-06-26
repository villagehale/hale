#!/usr/bin/env node
// VIL-143 launch-eval CI gate.
//
// One exit-coded runner that ties the two launch evals together, calibrated in
// BOTH directions (the discipline every other eval in this dir follows):
//
//   REAL setup (must PASS, exit 0):
//     - run-memory-cost-eval  --cached-only  : bounded slice stays cheap + accurate
//     - run-model-matrix-eval --cached-only  : current model routing is defensible
//   BROKEN setup (must be REJECTED → the calibration run exits 0 only because
//   rejection is the expected outcome):
//     - run-memory-cost-eval  --broken       : a memory-blind coach is rejected
//
// CI runs this with no network: every sub-eval is --cached-only (a cache miss
// FAILS LOUDLY, so CI can never silently spend), and --broken makes no API call.
// This runner exits 0 iff the real evals PASS and the broken eval is REJECTED.
//
//   node evals/run-vil143-eval.mjs        # CI: replay cache, calibrate, one exit code
//
// Populate/refresh the cache first (the only step that spends), then commit cache/:
//   node --env-file=../../.env evals/run-memory-cost-eval.mjs
//   node --env-file=../../.env evals/run-model-matrix-eval.mjs

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Each step: a sub-eval invocation + how its exit code maps to PASS. For the real
// evals, exit 0 = PASS. For the broken calibration, the sub-eval itself returns 0
// when it correctly REJECTS the bad config (and nonzero if the bad config slipped
// through), so exit 0 = PASS there too — the sub-eval owns the "must be rejected"
// semantics, this runner just requires every step to exit 0.
const STEPS = [
  {
    name: 'cost+accuracy (real, cached)',
    script: 'run-memory-cost-eval.mjs',
    args: ['--cached-only'],
  },
  {
    name: 'cost+accuracy (broken → must be rejected)',
    script: 'run-memory-cost-eval.mjs',
    args: ['--broken'],
  },
  {
    name: 'model-matrix (real, cached)',
    script: 'run-model-matrix-eval.mjs',
    args: ['--cached-only'],
  },
  {
    name: 'model-matrix (broken → must be rejected)',
    script: 'run-model-matrix-eval.mjs',
    args: ['--broken'],
  },
];

function run(step) {
  const res = spawnSync('node', [join(HERE, step.script), ...step.args], {
    stdio: 'inherit',
    cwd: join(HERE, '..'),
  });
  return res.status === 0;
}

const results = [];
for (const step of STEPS) {
  console.log(`\n========== ${step.name} ==========`);
  results.push({ name: step.name, ok: run(step) });
}

console.log('\n========== VIL-143 launch-eval gate ==========');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
const allOk = results.every((r) => r.ok);
console.log(allOk ? '\nGATE PASS (exit 0)' : '\nGATE FAIL (exit 1)');
process.exit(allOk ? 0 : 1);
