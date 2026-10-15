// Builds suffixes.json from the Public Suffix List.
//
//   node build.mjs <public_suffix_list.dat>
//
// The download is untrusted data: this script reads it as text and evaluates none
// of it. It makes no network call. A rule that is only `*` is the list's default
// and is not written: a host is a link when an explicit rule matches it.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { domainToASCII, fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
if (!source) {
  console.error('usage: node build.mjs <public_suffix_list.dat>');
  process.exit(1);
}

/** The form answer.ts looks a label up in: encoded (`xn--`) when the name is in
 * another script, so a host matches whether it was written in that script or encoded. */
function asciiRule(rule) {
  return rule
    .split('.')
    .map((label) => {
      const ascii = domainToASCII(label);
      return ascii === '' ? label : ascii;
    })
    .join('.');
}

const exact = [];
const wild = [];
for (const line of readFileSync(source, 'utf8').split('\n')) {
  const rule = line.trim();
  if (rule === '' || rule.startsWith('//') || rule.startsWith('!') || rule === '*') continue;
  if (rule.startsWith('*.')) wild.push(asciiRule(rule.slice(2)));
  else exact.push(asciiRule(rule));
}

const json = `${JSON.stringify({ exact, wild })}\n`;
writeFileSync(join(HERE, 'suffixes.json'), json);
console.log(
  `exact ${exact.length} wild ${wild.length} sha256 ${createHash('sha256').update(json).digest('hex')}`,
);
