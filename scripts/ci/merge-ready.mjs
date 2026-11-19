// Local pre-merge check. Uses gh. Exits non-zero when the PR is behind or
// conflicting with main, when main's latest CI run is red, or when the PR is
// part of a GitHub-native stack. Prints each reason.
//
//   node scripts/ci/merge-ready.mjs <pr-number>

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      baseRefName
      headRefOid
      mergeable
      mergeStateStatus
      stack { number }
    }
  }
}`;

/**
 * @param {{
 *   baseRefName?: string,
 *   mergeable?: string,
 *   mergeStateStatus?: string,
 *   behindBy?: number,
 *   stacked?: boolean,
 *   stackNumber?: number | null,
 *   mainCi?: { status?: string, conclusion?: string | null, url?: string, headSha?: string } | null,
 * }} input
 * @returns {string[]}
 */
export function mergeReadyReasons(input) {
  /** @type {string[]} */
  const reasons = [];
  if (input.stacked) {
    reasons.push(
      input.stackNumber
        ? `PR is part of native stack #${input.stackNumber}`
        : 'PR is part of a native stack',
    );
  }

  const baseIsMain = input.baseRefName === 'main';
  const behindBy = Number(input.behindBy) || 0;
  const status = String(input.mergeStateStatus ?? '').toUpperCase();
  const mergeable = String(input.mergeable ?? '').toUpperCase();

  if (behindBy > 0 || (baseIsMain && status === 'BEHIND')) {
    const count = behindBy > 0 ? ` by ${behindBy} ${behindBy === 1 ? 'commit' : 'commits'}` : '';
    reasons.push(`PR is behind main${count}`);
  }

  if (baseIsMain && (mergeable === 'CONFLICTING' || status === 'DIRTY')) {
    reasons.push('PR conflicts with main');
  } else if (baseIsMain && (mergeable === 'UNKNOWN' || mergeable === '')) {
    reasons.push('PR mergeability with main is unknown');
  }

  const ci = input.mainCi;
  if (!ci) {
    reasons.push("main's latest CI run is missing");
  } else if (ciIsRed(ci)) {
    const bits = [`main's latest CI is red (${ci.conclusion})`];
    if (ci.headSha) bits.push(`sha ${ci.headSha}`);
    if (ci.url) bits.push(ci.url);
    reasons.push(bits.join(' '));
  }

  return reasons;
}

/**
 * @param {{ status?: string, conclusion?: string | null }} ci
 */
function ciIsRed(ci) {
  if (ci.status && ci.status !== 'completed') return false;
  return RED_CONCLUSIONS.has(String(ci.conclusion ?? ''));
}

/**
 * @param {string[]} args
 * @returns {{ ok: true, stdout: string } | { ok: false, error: string, status: number }}
 */
function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    const message = code === 'ENOENT' ? 'gh is not installed' : result.error.message;
    return { ok: false, error: message, status: 1 };
  }
  if (result.status !== 0) {
    const error = (result.stderr || result.stdout || `gh exited ${result.status}`).trim();
    return { ok: false, error, status: result.status || 1 };
  }
  return { ok: true, stdout: result.stdout };
}

/**
 * @param {string[]} args
 */
function ghJson(args) {
  const result = gh(args);
  if (!result.ok) return result;
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, status: 1 };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repoSlug() {
  const result = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!result.ok) return result;
  const slug = result.stdout.trim();
  const slash = slug.indexOf('/');
  if (slash <= 0 || slash === slug.length - 1) {
    return { ok: false, error: `unexpected repo slug: ${slug || '(empty)'}`, status: 1 };
  }
  return { ok: true, owner: slug.slice(0, slash), name: slug.slice(slash + 1) };
}

function readPullRequest(owner, name, number) {
  const result = ghJson([
    'api',
    'graphql',
    '-f',
    `query=${PR_QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${number}`,
  ]);
  if (!result.ok) return result;
  const errors = result.value.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return {
      ok: false,
      error: errors.map((error) => error.message ?? String(error)).join('\n'),
      status: 1,
    };
  }
  const pullRequest = result.value.data?.repository?.pullRequest;
  if (!pullRequest) return { ok: false, error: `PR #${number} not found`, status: 1 };
  return { ok: true, pullRequest };
}

function readBehind(owner, name, sha) {
  const compare = `repos/${owner}/${name}/compare/main...${sha}`;
  const result = ghJson(['api', '--jq', '{behind_by,status}', compare]);
  if (!result.ok) return result;
  if (typeof result.value.behind_by !== 'number') {
    return { ok: false, error: 'compare response did not include behind_by', status: 1 };
  }
  return { ok: true, behindBy: result.value.behind_by };
}

function readMainCi(owner, name) {
  const result = ghJson([
    'run',
    'list',
    '--repo',
    `${owner}/${name}`,
    '--branch',
    'main',
    '--workflow',
    'ci.yml',
    '--limit',
    '1',
    '--json',
    'conclusion,status,url,headSha',
  ]);
  if (!result.ok) return result;
  if (!Array.isArray(result.value)) {
    return { ok: false, error: 'ci run list was not an array', status: 1 };
  }
  const run = result.value[0];
  if (!run) return { ok: true, mainCi: null };
  return {
    ok: true,
    mainCi: {
      status: run.status ?? '',
      conclusion: run.conclusion ?? '',
      url: run.url ?? '',
      headSha: run.headSha ?? '',
    },
  };
}

async function collect(prNumber) {
  const repo = repoSlug();
  if (!repo.ok) return repo;
  let pull = readPullRequest(repo.owner, repo.name, prNumber);
  if (!pull.ok) return pull;
  for (let attempt = 0; attempt < 4; attempt++) {
    const mergeable = String(pull.pullRequest.mergeable ?? '').toUpperCase();
    if (mergeable !== 'UNKNOWN' && mergeable !== '') break;
    await sleep(2000);
    pull = readPullRequest(repo.owner, repo.name, prNumber);
    if (!pull.ok) return pull;
  }
  const sha = pull.pullRequest.headRefOid;
  if (typeof sha !== 'string' || sha.length === 0) {
    return { ok: false, error: `PR #${prNumber} has no head sha`, status: 1 };
  }
  const behind = readBehind(repo.owner, repo.name, sha);
  if (!behind.ok) return behind;
  const ci = readMainCi(repo.owner, repo.name);
  if (!ci.ok) return ci;
  const stack = pull.pullRequest.stack;
  return {
    ok: true,
    reasons: mergeReadyReasons({
      baseRefName: pull.pullRequest.baseRefName,
      mergeable: pull.pullRequest.mergeable,
      mergeStateStatus: pull.pullRequest.mergeStateStatus,
      behindBy: behind.behindBy,
      stacked: stack != null,
      stackNumber: typeof stack?.number === 'number' ? stack.number : null,
      mainCi: ci.mainCi,
    }),
  };
}

export async function main() {
  const arg = process.argv[2];
  if (!arg || !/^[1-9]\d*$/.test(arg) || process.argv.length > 3) {
    console.error('usage: node scripts/ci/merge-ready.mjs <pr-number>');
    process.exit(2);
  }
  const result = await collect(arg);
  if (!result.ok) {
    console.error(result.error);
    process.exit(result.status || 1);
  }
  if (result.reasons.length > 0) {
    for (const reason of result.reasons) console.info(reason);
    process.exit(1);
  }
  console.info('ready');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
