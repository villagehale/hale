// Names in every-eval-known-ok.txt: suites that currently fail --cached-only
// on main. The CI every-eval job treats those as known so main stays green.
// The weekly sweep does not.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KNOWN_OK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'every-eval-known-ok.txt',
);

export function parseKnownOk(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function loadKnownOk(path = KNOWN_OK_PATH) {
  return new Set(parseKnownOk(readFileSync(path, 'utf8')));
}

export function classifySuite({ name, passed, allowKnown, known }) {
  const listed = known.has(name);
  if (passed) return listed ? 'pass-stale' : 'pass';
  if (allowKnown && listed) return 'known';
  return 'fail';
}

export function jobFails(labels) {
  return labels.some((label) => label === 'fail');
}

function main(argv) {
  const [cmd] = argv;
  if (cmd === 'list') {
    for (const name of parseKnownOk(readFileSync(KNOWN_OK_PATH, 'utf8'))) {
      console.info(name);
    }
    return;
  }
  console.error('usage: every-eval-known-ok.mjs list');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
