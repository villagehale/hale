// VIL-640. A public-repo fixture must not call a value a real person's or family's
// (phase B P2-52). The needles are assembled at runtime so this file is not itself a hit.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function realFsaNeedle() {
  return ['real', 'FSA'].join(' ');
}

export function incidentFamilyNeedle() {
  return ['incident', 'family'].join(' ');
}

export function matchingLines(text, needle) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle.toLowerCase())) hits.push(`${i + 1}:${lines[i]}`);
  }
  return hits;
}

/**
 * Every tracked file that still names a household as the source of a postal area.
 * `git grep` exit 1 means a clean tree. Any other failure is a broken scanner.
 */
export function fixtureFamilyFsaHits(root = REPO_ROOT) {
  const needles = [realFsaNeedle(), incidentFamilyNeedle()];
  const hits = [];
  for (const needle of needles) {
    try {
      const out = execFileSync('git', ['grep', '-a', '-n', '-i', '-F', '--', needle], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      for (const line of out.split('\n').filter((row) => row.length > 0)) hits.push(line);
    } catch (error) {
      if (error && error.status === 1) continue;
      throw error;
    }
  }
  return hits;
}
