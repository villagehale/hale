#!/usr/bin/env node
// Self-healing CI orchestrator (deterministic v1 — no LLM calls anywhere).
// Invoked by .github/workflows/ci-heal.yml after a failed CI run:
//
//   node scripts/ci/heal.mjs run                # full flow, driven by env vars
//   node scripts/ci/heal.mjs fix-skills <dir>   # local/simulation leg: reseed +
//                                               # containment check + commit, no push
//
// Founder-approved actions (2026-08-31), and nothing broader:
//   (a) push a single-file skills-lockfile reseed commit to a failing
//       same-repo PR branch, (b) trigger exactly one CI rerun for a known
//       flake signature, (c) comment on PRs. Everything else escalates.
//
// Every guard is a named early-exit logged in the job, and every leg ends in
// a named `ci-heal outcome:` line (hard rule #11 — absence of an effect is a
// first-class outcome, never a silent no-op).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classify, resolveEvalCommand } from './classify.mjs';

const MARKER = '[ci-heal]';
const LOCKFILE_PATH = 'packages/agent/skills/.skills-lock.json';
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const GIT_USER = 'github-actions[bot]';
const GIT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const MAX_LOG_BYTES = 64 * 1024 * 1024;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: MAX_LOG_BYTES,
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  });
}

function guardExit(name, detail = '') {
  console.log(`ci-heal guard: ${name}${detail ? ` — ${detail}` : ''}`);
  process.exit(0);
}

function finish(outcome, detail = '') {
  console.log(`ci-heal outcome: ${outcome}${detail ? ` — ${detail}` : ''}`);
  process.exit(0);
}

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    console.error(`ci-heal misconfigured: missing env ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Skills-lock fix leg (shared by CI heal and local simulation).
// Returns a named result; never pushes — the caller owns the push decision.
// ---------------------------------------------------------------------------
export function fixSkills(dir) {
  sh('node', [join(dir, 'packages/agent/scripts/check-skills.mjs'), 'seed']);
  const porcelain = sh('git', ['-C', dir, 'status', '--porcelain']).trimEnd();
  const lines = porcelain === '' ? [] : porcelain.split('\n');
  if (lines.length === 0) {
    return { outcome: 'no_diff_after_seed' };
  }
  const paths = lines.map((l) => l.slice(3));
  if (lines.length !== 1 || paths[0] !== LOCKFILE_PATH) {
    return { outcome: 'unexpected_diff_after_seed', detail: porcelain };
  }
  sh('git', ['-C', dir, 'add', LOCKFILE_PATH]);
  sh('git', [
    '-C',
    dir,
    '-c',
    `user.name=${GIT_USER}`,
    '-c',
    `user.email=${GIT_EMAIL}`,
    'commit',
    '-m',
    `heal(ci): reseed skills-lock ${MARKER}`,
    '-m',
    'Automated single-file heal for skills-lock drift.\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
  ]);
  const sha = sh('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
  return { outcome: 'committed', sha };
}

// ---------------------------------------------------------------------------
// CI flow
// ---------------------------------------------------------------------------
function run() {
  requireEnv([
    'REPO',
    'RUN_ID',
    'RUN_ATTEMPT',
    'CONCLUSION',
    'RUN_EVENT',
    'WORKFLOW_PATH',
    'HEAD_BRANCH',
    'HEAD_SHA',
    'HEAD_REPO',
  ]);
  const {
    REPO: repo,
    RUN_ID: runId,
    RUN_ATTEMPT: runAttempt,
    HEAD_BRANCH: headBranch,
    HEAD_SHA: headSha,
  } = process.env;
  const headCommitMessage = process.env.HEAD_COMMIT_MESSAGE ?? '';

  // Named guards, in order. workflow_run filters and the job-level `if:`
  // should already enforce most of these; each is re-checked here so a
  // misconfigured trigger fails loudly by name instead of healing.
  if (process.env.WORKFLOW_PATH !== CI_WORKFLOW_PATH) {
    guardExit('not_ci_workflow', `triggering workflow is ${process.env.WORKFLOW_PATH}`);
  }
  if (process.env.CONCLUSION !== 'failure') {
    guardExit('not_a_failure', `conclusion is ${process.env.CONCLUSION}`);
  }
  if (process.env.RUN_EVENT !== 'pull_request') {
    guardExit('not_pull_request_event', `run event is ${process.env.RUN_EVENT}`);
  }
  if (process.env.HEAD_REPO !== repo) {
    guardExit('fork_pr', `head repository is ${process.env.HEAD_REPO}`);
  }
  if (headBranch === 'main' || headBranch === 'production') {
    guardExit('protected_branch', headBranch);
  }
  if (headCommitMessage.includes(MARKER)) {
    guardExit('head_is_heal_commit', `head commit already carries ${MARKER}`);
  }

  // Failed step name comes from the jobs JSON — the --log-failed dump labels
  // steps "UNKNOWN STEP" and must not be parsed for names.
  const { jobs } = JSON.parse(sh('gh', ['run', 'view', runId, '-R', repo, '--json', 'jobs']));
  const failedJob = jobs.find((j) => j.conclusion === 'failure');
  const failedStep = failedJob?.steps?.find((s) => s.conclusion === 'failure')?.name ?? null;

  let log = '';
  try {
    log = sh('gh', ['run', 'view', runId, '-R', repo, '--log-failed']);
  } catch (err) {
    console.log(`ci-heal note: log_fetch_failed — ${err.message}; classifying on step name alone`);
  }

  const result = classify(failedStep, log);
  console.log(`ci-heal class: ${result.class} (failed step: ${failedStep ?? 'none found'})`);

  // PR number: payload first, `gh pr list --head` fallback (the payload array
  // is occasionally empty even for same-repo PRs).
  let prNumber = process.env.PR_NUMBER || null;
  if (!prNumber) {
    try {
      const prs = JSON.parse(
        sh('gh', ['pr', 'list', '-R', repo, '--head', headBranch, '--state', 'open', '--json', 'number']),
      );
      prNumber = prs[0]?.number ?? null;
    } catch (err) {
      console.log(`ci-heal note: pr_lookup_failed — ${err.message}`);
    }
  }
  if (!prNumber) console.log('ci-heal note: no_pr_resolved — comments will be skipped by name');

  let commentBodies = '';
  if (prNumber) {
    commentBodies = sh('gh', [
      'api',
      `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
      '--paginate',
      '--jq',
      '.[].body',
    ]);
  }

  function postComment(body) {
    if (!prNumber) {
      console.log('ci-heal note: comment_skipped_no_pr');
      return false;
    }
    sh('gh', ['api', `repos/${repo}/issues/${prNumber}/comments`, '-f', `body=${body}`]);
    return true;
  }

  function escalate(outcome, text) {
    const dedupeMarker = `<!-- ci-heal:escalated:${headSha} -->`;
    if (commentBodies.includes(dedupeMarker)) {
      finish('escalation_deduped', `already escalated for ${headSha}`);
    }
    postComment(`${text}\n\n${dedupeMarker}`);
    finish(outcome);
  }

  if (result.class === 'skills-lock-drift') {
    const attemptMarker = `<!-- ci-heal:attempt:${headSha} -->`;
    if (commentBodies.includes(attemptMarker)) {
      guardExit('already_attempted_this_sha', headSha);
    }
    sh('git', ['fetch', 'origin', headBranch]);
    const fetchedSha = sh('git', ['rev-parse', 'FETCH_HEAD']).trim();
    if (fetchedSha !== headSha) {
      guardExit('stale_head', `branch ${headBranch} is at ${fetchedSha}, failed run head is ${headSha}`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'ci-heal-'));
    sh('git', ['worktree', 'add', '--detach', dir, headSha]);

    const fix = fixSkills(dir);
    if (fix.outcome === 'no_diff_after_seed') {
      escalate(
        'escalated_no_diff_after_seed',
        `CI heal: \`Skill lockfile check\` failed on ${headSha} but reseeding produced no diff — needs a human look.`,
      );
    }
    if (fix.outcome === 'unexpected_diff_after_seed') {
      escalate(
        'escalated_unexpected_diff',
        `CI heal: refused to push — reseeding touched more than \`${LOCKFILE_PATH}\`:\n\`\`\`\n${fix.detail}\n\`\`\``,
      );
    }

    try {
      sh('git', ['-C', dir, 'push', 'origin', `HEAD:refs/heads/${headBranch}`]);
    } catch (err) {
      finish('push_rejected', `branch moved during heal (${err.message}); the newer push has its own CI run`);
    }

    // GITHUB_TOKEN pushes don't trigger pull_request workflows (GitHub's
    // recursion guard), so dispatch a fresh CI run on the branch explicitly.
    let dispatchNote = 'Dispatched a fresh CI run on the branch.';
    let dispatched = true;
    try {
      sh('gh', ['workflow', 'run', 'ci.yml', '-R', repo, '--ref', headBranch]);
    } catch (err) {
      dispatched = false;
      dispatchNote = `CI dispatch failed (${err.message.split('\n')[0]}) — re-run CI on the branch manually; the healed push cannot retrigger it by itself.`;
    }
    postComment(
      `CI heal: skills-lock drift on \`${headSha.slice(0, 12)}\` — reseeded \`${LOCKFILE_PATH}\` and pushed \`${fix.sha.slice(0, 12)}\`. ${dispatchNote}\n\n${attemptMarker}`,
    );
    finish(dispatched ? 'healed_pushed_and_dispatched' : 'healed_pushed_dispatch_failed', fix.sha);
  }

  if (result.class === 'eval-cache-miss') {
    const workerPkg = JSON.parse(readFileSync('apps/worker/package.json', 'utf8'));
    const liveCommand = result.evalName ? resolveEvalCommand(result.evalName, workerPkg) : null;
    const recordBlock = liveCommand
      ? `Re-record locally (live Anthropic spend — never run in CI), then commit the cache:\n\`\`\`sh\ncd apps/worker && ${liveCommand}\ngit add evals/cache\ngit commit -m "chore(evals): re-record ${result.evalName} cache"\n\`\`\``
      : 'Could not resolve the eval runner from the log; find the failing `eval:*` script in `apps/worker/package.json` and re-run it without `--cached-only` (with `--env-file=.env`), then commit `evals/cache`.';
    escalate(
      'escalated_eval_cache_miss',
      `CI heal: eval cache miss, not auto-healable.\n\n- Failed step: \`${failedStep}\`\n- Missing: \`${result.missKey ?? 'key not found in log'}\`\n\n${recordBlock}`,
    );
  }

  if (result.class === 'pglite-flake') {
    if (runAttempt !== '1') {
      escalate(
        'escalated_flake_persisted',
        `CI heal: pglite timeout signature on rerun attempt ${runAttempt} — the one allowed rerun already happened and CI still failed; needs a human.`,
      );
    }
    const rerunMarker = `<!-- ci-heal:rerun:${headSha} -->`;
    if (commentBodies.includes(rerunMarker)) {
      guardExit('rerun_already_attempted', headSha);
    }
    // Marker comment goes first so a crash after the rerun call can never
    // lead to a second rerun for the same head SHA.
    postComment(
      `CI heal: pglite timeout flake (${result.failFiles.join(', ')}) — triggering one rerun of failed jobs.\n\n${rerunMarker}`,
    );
    sh('gh', ['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`]);
    finish('rerun_triggered', `run ${runId}`);
  }

  const errorBlock =
    result.firstErrorLines.length > 0 ? `\n\`\`\`\n${result.firstErrorLines.join('\n')}\n\`\`\`` : '';
  escalate(
    'escalated_unknown',
    `CI failed, no known remediation: step \`${result.failedStep ?? 'unknown'}\`.${errorBlock}`,
  );
}

const command = process.argv[2];
if (command === 'run') {
  run();
} else if (command === 'fix-skills') {
  const dir = resolve(process.argv[3] ?? '.');
  const fix = fixSkills(dir);
  if (fix.outcome === 'committed') {
    finish('committed', fix.sha);
  }
  console.error(`ci-heal outcome: ${fix.outcome}${fix.detail ? `\n${fix.detail}` : ''}`);
  process.exit(1);
} else {
  console.error('Usage: node scripts/ci/heal.mjs <run|fix-skills [dir]>');
  process.exit(1);
}
