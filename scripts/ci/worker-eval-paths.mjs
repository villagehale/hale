// Decide whether a CI diff must run the worker eval suites.
//
// Skip evals only when every changed path is site-only:
//   - apps/site/**
//   - pnpm-lock.yaml, when the lockfile change is confined to the apps/site
//     importer and to package entries no other importer selects
//
// @hale/types is the site's only workspace dependency, and it is shared with
// web, worker, and tools-contracts. packages/types, packages/agent, packages/db,
// packages/tools-contracts, apps/web, and apps/worker all keep the evals.
// Anything else (root toolchain, workflows, docs) keeps them too: an unknown
// path is not site-only. An empty diff or a failed git read also keeps them.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LOCKFILE = 'pnpm-lock.yaml';

export function isSiteTreePath(file) {
  const path = String(file).replaceAll('\\', '/').replace(/^\.\//, '');
  return path === 'apps/site' || path.startsWith('apps/site/');
}

// git diff --name-status lines. Renames and copies count both paths, so a
// worker file renamed into apps/site still runs evals.
export function pathsFromNameStatus(lines) {
  const files = [];
  for (const line of lines) {
    if (!line) continue;
    const [status, ...rest] = line.split('\t');
    if (!status || rest.length === 0) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push(rest[0], rest[1]);
    } else {
      files.push(rest.join('\t'));
    }
  }
  return files.filter((file) => file && file.length > 0);
}

export function workerEvalsRequired(files, lockBefore = '', lockAfter = '') {
  if (!Array.isArray(files) || files.length === 0) return true;
  const rest = files.filter((file) => !isSiteTreePath(file));
  if (rest.length === 0) return false;
  if (!rest.every((file) => file === LOCKFILE)) return true;
  return lockfileAffectsWorkerEvals(lockBefore, lockAfter);
}

export function lockfileAffectsWorkerEvals(before, after) {
  if (!before && !after) return true;
  const prior = parseLockfile(before ?? '');
  const next = parseLockfile(after ?? '');
  if (prior.preamble !== next.preamble) return true;

  const topKeys = new Set([...Object.keys(prior.top), ...Object.keys(next.top)]);
  for (const key of topKeys) {
    if (key === 'importers' || key === 'packages' || key === 'snapshots') continue;
    if ((prior.top[key] ?? '') !== (next.top[key] ?? '')) return true;
  }

  const importerNames = new Set([...Object.keys(prior.importers), ...Object.keys(next.importers)]);
  for (const name of importerNames) {
    if (name === 'apps/site') continue;
    if ((prior.importers[name] ?? '') !== (next.importers[name] ?? '')) return true;
  }

  const nonSiteImporters = [...importerNames].filter((name) => name !== 'apps/site');
  const nonSiteText = nonSiteImporters
    .map((name) => next.importers[name] ?? prior.importers[name] ?? '')
    .join('\n');
  // Prefer the post-change snapshot graph so a newly added shared package is visible.
  const closure = snapshotClosure(next.importers, next.snapshots, nonSiteImporters);
  const changedKeys = changedBlockKeys(prior.packages, next.packages).concat(
    changedBlockKeys(prior.snapshots, next.snapshots),
  );
  for (const key of changedKeys) {
    if (closure.has(key) || packageKeyReferenced(key, nonSiteText)) return true;
  }
  return false;
}

function changedBlockKeys(prior, next) {
  const names = new Set([...Object.keys(prior), ...Object.keys(next)]);
  const changed = [];
  for (const name of names) {
    if ((prior[name] ?? '') !== (next[name] ?? '')) changed.push(name);
  }
  return changed;
}

// Package keys installed by every importer except apps/site, plus their snapshot
// dependencies. A site-only package added to the catalog is outside this set.
function snapshotClosure(importers, snapshots, importerNames) {
  const depsOf = new Map();
  for (const [key, block] of Object.entries(snapshots)) {
    depsOf.set(key, snapshotDependencyKeys(block));
  }
  const seen = new Set();
  const stack = [];
  for (const name of importerNames) {
    stack.push(...importerRootKeys(importers[name] ?? ''));
  }
  while (stack.length > 0) {
    const key = stack.pop();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const deps = depsOf.get(key);
    if (!deps) continue;
    for (const dep of deps) stack.push(dep);
  }
  return seen;
}

export function importerRootKeys(importerText) {
  const roots = [];
  const lines = importerText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const name = indentedKeyAt(lines[i], 6);
    if (!name) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (indentedKeyAt(lines[j], 6) || indentedKeyAt(lines[j], 4)) break;
      const version = /^ {8}version: (.+)$/.exec(lines[j]);
      if (version) {
        roots.push(`${name}@${version[1].trim()}`);
        break;
      }
    }
  }
  return roots;
}

function snapshotDependencyKeys(block) {
  const deps = [];
  let inDeps = false;
  for (const line of block.split('\n')) {
    if (/^ {4}(?:dependencies|optionalDependencies):$/.test(line)) {
      inDeps = true;
      continue;
    }
    if (!inDeps) continue;
    const entry = /^ {6}(?:'([^']*)'|"([^"]*)"|([^:'"][^:]*)): (.+)$/.exec(line);
    if (!entry) {
      inDeps = false;
      continue;
    }
    const name = entry[1] ?? entry[2] ?? entry[3];
    deps.push(`${name}@${entry[4].trim()}`);
  }
  return deps;
}

export function splitPackageKey(key) {
  const head = key.split('(')[0];
  const at = head.lastIndexOf('@');
  if (at <= 0) return null;
  const name = head.slice(0, at);
  const version = head.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

export function packageKeyReferenced(key, importerText) {
  const parsed = splitPackageKey(key);
  if (!parsed) return true;
  const { name, version } = parsed;
  const quoted = escapeRegExp(name);
  const directName = new RegExp(`^\\s+['"]?${quoted}['"]?:$`, 'm');
  const selected = new RegExp(`^\\s+version:\\s+${escapeRegExp(version)}(?:\\(|$)`, 'm');
  if (directName.test(importerText) && selected.test(importerText)) return true;
  return importerText.includes(`${name}@${version}`);
}

export function parseLockfile(text) {
  const lines = String(text).replaceAll('\r\n', '\n').split('\n');
  const preamble = [];
  const top = {};
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) top[current] = buf.join('\n');
  };
  for (const line of lines) {
    if (/^[A-Za-z][^:]*:$/.test(line)) {
      flush();
      current = line.slice(0, -1);
      buf = [line];
    } else if (!current) {
      preamble.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return {
    preamble: preamble.join('\n'),
    top,
    importers: splitIndentedBlocks(top.importers),
    packages: splitIndentedBlocks(top.packages),
    snapshots: splitIndentedBlocks(top.snapshots),
  };
}

function splitIndentedBlocks(section) {
  const blocks = {};
  if (!section) return blocks;
  const lines = section.split('\n').slice(1);
  let name = null;
  let buf = [];
  const flush = () => {
    if (name) blocks[name] = buf.join('\n');
  };
  for (const line of lines) {
    const key = indentedKey(line);
    if (key) {
      flush();
      name = key;
      buf = [line];
    } else if (name) {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}

function indentedKey(line) {
  return indentedKeyAt(line, 2);
}

// pnpm writes one-line snapshot entries as `  name@version: {}`.
function indentedKeyAt(line, spaces) {
  const match = new RegExp(
    `^ {${spaces}}(?:'([^']*)'|"([^"]*)"|([^:\\s][^:]*)):(?: \\{\\})?$`,
  ).exec(line);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function git(args, options = {}) {
  if (options.inherit) {
    execFileSync('git', args, { stdio: 'inherit' });
    return '';
  }
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commitExists(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureCommit(sha) {
  if (!sha || /^0+$/.test(sha)) return false;
  if (commitExists(sha)) return true;
  // A branch ref is advertised; a raw SHA fetch is the fallback when the tip
  // moved or the event is a push (before-SHA). Either failure runs evals.
  const ref = process.env.BASE_REF || '';
  if (ref) {
    try {
      git(['fetch', '--no-tags', '--depth=1', 'origin', ref], { inherit: true });
    } catch (err) {
      console.error(`could not fetch ${ref}: ${err.message}`);
    }
    if (commitExists(sha)) return true;
  }
  try {
    git(['fetch', '--no-tags', '--depth=1', 'origin', sha], { inherit: true });
  } catch (err) {
    console.error(`could not fetch ${sha}: ${err.message}`);
    return false;
  }
  return commitExists(sha);
}

function readGitFile(sha, path) {
  try {
    return git(['show', `${sha}:${path}`]);
  } catch {
    return '';
  }
}

function listChangedFiles(base) {
  const status = git(['diff', '--name-status', '--find-renames', base, 'HEAD']);
  const lines = status.trim() ? status.trim().split('\n') : [];
  return pathsFromNameStatus(lines);
}

function writeOutput(required) {
  const line = `worker_evals=${required ? 'true' : 'false'}`;
  console.info(line);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  }
}

function writeSummary(files, required) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const decision = required ? 'run' : 'skip (site-only diff)';
  const listed = files.length > 0 ? files.slice(0, 40).join('\n') : '(no file list — evals run)';
  const more = files.length > 40 ? `\n… ${files.length - 40} more` : '';
  appendFileSync(
    summary,
    `### Worker eval path filter\n\nDecision: **${decision}**\n\n\`\`\`\n${listed}${more}\n\`\`\`\n`,
  );
}

export function main() {
  const event = process.env.GITHUB_EVENT_NAME || '';
  let required = true;
  let files = [];
  try {
    if (event !== 'pull_request' && event !== 'push') {
      console.info(`event ${event || '(none)'} has no diff; worker evals run`);
    } else {
      const base = process.env.BASE_SHA || '';
      if (!ensureCommit(base)) {
        console.info('diff base unavailable; worker evals run');
      } else {
        files = listChangedFiles(base);
        let before = '';
        let after = '';
        if (files.includes(LOCKFILE)) {
          before = readGitFile(base, LOCKFILE);
          after = readGitFile('HEAD', LOCKFILE);
        }
        required = workerEvalsRequired(files, before, after);
      }
    }
  } catch (err) {
    console.error(`worker-eval path filter failed closed (evals will run): ${err.message}`);
    required = true;
  }
  writeOutput(required);
  writeSummary(files, required);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
