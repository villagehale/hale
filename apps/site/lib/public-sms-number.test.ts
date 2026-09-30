import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HALE_PUBLIC_SMS_DISPLAY, HALE_PUBLIC_SMS_E164 } from './text-entry.js';

/**
 * The public line is the Linq number. The retired Twilio long code and a
 * founder's personal cell must not be published as Hale's number.
 */
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

const RETIRED_TWILIO = ['2892172279', '289-217-2279', '(289) 217-2279', '+12892172279'];
const PERSONAL_CELL = ['4167027089', '416-702-7089', '+14167027089', '(416) 702-7089'];

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next' || name === 'evals') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (name === 'public-sms-number.test.ts') continue;
      if (/\.(ts|tsx|mjs|md|json)$/.test(name) || name.startsWith('.env')) found.push(path);
    }
  };
  walk(root);
  return found;
}

describe('public SMS number', () => {
  it('publishes the Linq line, display and E.164', () => {
    expect(HALE_PUBLIC_SMS_E164).toBe('+16462352164');
    expect(HALE_PUBLIC_SMS_DISPLAY).toBe('(646) 235-2164');

    const posters = [
      'tools/posters/render.mjs',
      'tools/posters/plates.mjs',
      'tools/posters/README.md',
    ].map((path) => readFileSync(join(REPO, path), 'utf8'));
    expect(posters[0]).toContain(HALE_PUBLIC_SMS_DISPLAY);
    expect(posters[1]).toContain(`sms:${HALE_PUBLIC_SMS_E164}`);
    expect(posters[2]).toContain(`sms:${HALE_PUBLIC_SMS_E164}`);

    const example = readFileSync(join(REPO, '.env.example'), 'utf8');
    expect(example).toContain(`NEXT_PUBLIC_HALE_SMS_NUMBER=${HALE_PUBLIC_SMS_E164}`);
  });

  it('does not publish the retired Twilio number or a personal cell as Hale', () => {
    const paths = [
      ...filesUnder(join(REPO, 'apps/site')),
      ...filesUnder(join(REPO, 'apps/web')),
      ...filesUnder(join(REPO, 'tools/posters')),
      ...filesUnder(join(REPO, 'docs')),
      join(REPO, '.env.example'),
    ];
    const hits: string[] = [];
    for (const path of paths) {
      const text = readFileSync(path, 'utf8');
      for (const needle of [...RETIRED_TWILIO, ...PERSONAL_CELL]) {
        if (text.includes(needle)) hits.push(`${path} contains ${needle}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
