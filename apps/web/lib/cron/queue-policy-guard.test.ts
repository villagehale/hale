import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE QUEUE-POLICY INVARIANT (SMS reliability audit P0-3): every pg-boss queue is
 * created through `createQueueWithPolicy` (@hale/tools-contracts), which requires an
 * explicit retry policy and a dead-letter queue — because a queue created bare rides
 * pg-boss's defaults (two retries, zero delay, no dead letter), and that is exactly how
 * a transient Twilio blip during a weekly-brief burst permanently killed a composed
 * message with no ledger row and no trace. The inbound turn queue was cured of this
 * class once already (channel/config.ts CHANNEL_MESSAGE_RECEIVED_RETRY); this guard is
 * what keeps the cure from being site-by-site vigilance.
 *
 * Structural, like admin/no-mutation.test.ts: a `.createQueue(` INVOCATION anywhere in
 * production source outside the one blessed helper module is a failure. Interface
 * declarations (`createQueue(name: string …): Promise<void>`) carry no leading dot and
 * are exempt by construction.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const SCAN_ROOTS = ['apps/web/app', 'apps/web/lib', 'apps/worker/src', 'packages'].map((p) =>
  join(REPO_ROOT, p),
);

/** The ONE module allowed to invoke pg-boss's createQueue/updateQueue. */
const HELPER = join(REPO_ROOT, 'packages/tools-contracts/src/queue-policy.ts');

const BARE_CREATE = /\.\s*createQueue\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('every queue is created through createQueueWithPolicy', () => {
  const files = SCAN_ROOTS.flatMap(sourceFiles);

  it('finds the source trees at all (positive control)', () => {
    for (const root of SCAN_ROOTS) {
      expect(
        files.some((f) => f.startsWith(root)),
        `no sources found under ${root}`,
      ).toBe(true);
    }
  });

  it('invokes createQueue nowhere outside the helper', () => {
    const offenders = files
      .filter((f) => f !== HELPER)
      .filter((f) => BARE_CREATE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f));
    expect(
      offenders,
      `bare createQueue — route it through createQueueWithPolicy (@hale/tools-contracts): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  /** The scanner would actually catch one: the helper itself must contain the exact
   * call shape the regex hunts, so a regex drift or a moved helper fails LOUD rather
   * than the guard passing on an empty net (a refusal is not evidence). */
  it('the regex catches the real call shape inside the helper (positive control)', () => {
    expect(BARE_CREATE.test('await boss.createQueue(name, options)')).toBe(true);
    expect(BARE_CREATE.test(readFileSync(HELPER, 'utf8')), 'helper moved or renamed').toBe(true);
  });
});
