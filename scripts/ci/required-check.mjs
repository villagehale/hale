// Aggregator for the CI check named "Lint, typecheck, test, build".
//
// That name stays the required status check. It passes when workspace
// lint/typecheck/test/build passed AND worker evals either passed or were
// skipped because the path filter said the diff was site-only. A skip is not
// success when the filter asked for evals — that is a failed closed gate.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function requiredCheckPasses({ changes, verify, evals, workerEvals }) {
  if (changes !== 'success') {
    return { ok: false, reason: `path filter ${changes || 'missing'}` };
  }
  if (verify !== 'success') {
    return { ok: false, reason: `workspace lint, typecheck, test, build ${verify || 'missing'}` };
  }
  if (workerEvals === 'false') {
    if (evals === 'skipped' || evals === 'success') {
      return { ok: true, reason: 'site-only diff; worker evals skipped' };
    }
    return { ok: false, reason: `worker evals ${evals || 'missing'} on a site-only diff` };
  }
  if (evals !== 'success') {
    return { ok: false, reason: `worker evals ${evals || 'missing'}` };
  }
  return { ok: true, reason: 'workspace checks passed and worker evals passed' };
}

function readEnv(name) {
  return process.env[name] ?? '';
}

export function main() {
  const result = requiredCheckPasses({
    changes: readEnv('CHANGES_RESULT'),
    verify: readEnv('VERIFY_RESULT'),
    evals: readEnv('EVALS_RESULT'),
    workerEvals: readEnv('WORKER_EVALS'),
  });
  console.info(result.reason);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Lint, typecheck, test, build\n\n${result.reason}\n`,
    );
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
