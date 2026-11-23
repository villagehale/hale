import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-720 · group privacy, held by the code's shape. A bring list is one parent's mail or
 * 1:1 thread, so it may reach that parent's own reminder and nothing else: never a group
 * chat, a co-parent or a caregiver (the handoff's rule #11, CLAUDE.md rule #1).
 *
 * The one reader is the 1:1 reminder run, which asks for the recipient's own rows. This
 * file pins EVERY source file that touches the table or the store, so a group surface, a
 * caregiver template or a weekly digest that starts reading it fails here and has to be
 * argued for in review. A new entry needs the reason beside it.
 */

const ALLOWED: Readonly<Record<string, string>> = {
  'apps/web/lib/loop/reminders/bring/store.ts': 'the store itself',
  'apps/web/lib/loop/reminders/bring/email.ts': "writes a list from the parent's own mail",
  'apps/web/lib/loop/reminders/bring/photo.ts': "writes a list from the parent's own flyer",
  'apps/web/lib/loop/reminders/run.ts':
    "the 1:1 reminder: reads the recipient's own rows, never for a caregiver",
  'apps/web/lib/integrations/email-alert-offer.ts':
    "the parent's own yes attaches their pending list",
};

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url)).replace(/\/$/, '');
const SCAN = ['apps/web/lib', 'apps/web/app', 'apps/worker/src', 'packages/agent/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TOUCHES =
  /familyEventBringItems|family_event_bring_items|reminders\/bring\/store|from '\.\/store'|from '\.\/bring\/store'/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

describe('who may touch a bring list (VIL-720)', () => {
  it('exactly the 1:1 reminder, its writers and the yes that attaches one', () => {
    const touching = SCAN.flatMap((root) => sourceFiles(join(REPO_ROOT, root)))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        if (!TOUCHES.test(text)) return false;
        // `./store` only counts inside the bring directory, where it is this store.
        const rel = relative(REPO_ROOT, file);
        if (
          !/familyEventBringItems|family_event_bring_items|reminders\/bring\/store|bring\/store/.test(
            text,
          )
        ) {
          return rel.startsWith('apps/web/lib/loop/reminders/bring/');
        }
        return true;
      })
      .map((file) => relative(REPO_ROOT, file))
      .sort();
    expect(touching).toEqual(Object.keys(ALLOWED).sort());
  });

  it('no group, caregiver or digest surface is among them', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(file).not.toMatch(/\/group\/|\/linq\/|caregiver|weekly|digest/);
    }
  });
});
