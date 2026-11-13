import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claimRowLabel } from './claim-label';

/**
 * VIL-581 · the only way a label reaches the claim reader. A 13+ child's row and a
 * sensitive row are "A private calendar item"; the age gate is deriveStage's 156-month
 * boundary, so the expected values below come from the stage spec, not from the helper.
 */

const NOW = new Date('2026-11-03T12:00:00Z');
const PRIVATE = 'A private calendar item';

const calendar = (over: {
  childId?: string | null;
  childDateOfBirth?: string | null;
  sensitive?: boolean;
}) =>
  claimRowLabel(
    {
      from: 'calendar',
      title: 'Practice',
      childId: over.childId ?? null,
      childDateOfBirth: over.childDateOfBirth ?? null,
      sensitive: over.sensitive ?? false,
    },
    NOW,
  );

describe('claimRowLabel — calendar rows', () => {
  it('a child of exactly 156 completed months is a teen: private', () => {
    expect(calendar({ childId: 'c1', childDateOfBirth: '2013-11-03' })).toBe(PRIVATE);
  });

  it('a child one day short of 156 months keeps the title (control)', () => {
    expect(calendar({ childId: 'c1', childDateOfBirth: '2013-11-04' })).toBe('Practice');
  });

  it('a sensitive row with no child is private', () => {
    expect(calendar({ sensitive: true })).toBe(PRIVATE);
  });

  it('an adult, non-sensitive row keeps its title', () => {
    expect(calendar({})).toBe('Practice');
  });

  it('a child with no date of birth keeps the title (no age is invented)', () => {
    expect(calendar({ childId: 'c1', childDateOfBirth: null })).toBe('Practice');
  });
});

describe('claimRowLabel — commitments about one child', () => {
  const commitment = (childDateOfBirth: string) =>
    claimRowLabel(
      { from: 'commitment', summary: 'Practice follow-up', childId: 'c1', childDateOfBirth },
      NOW,
    );

  it('a 13+ child is private; one day short of 156 months keeps the summary (control)', () => {
    expect(commitment('2013-11-03')).toBe('A private item');
    expect(commitment('2013-11-04')).toBe('Practice follow-up');
  });
});

describe('claimRowLabel — named sources', () => {
  it('a commitment, a watched page, a stated booking and a pending intent carry their one field', () => {
    expect(
      claimRowLabel(
        { from: 'commitment', summary: 'Swim classes', childId: null, childDateOfBirth: null },
        NOW,
      ),
    ).toBe('Swim classes');
    expect(claimRowLabel({ from: 'watched_page', label: 'Saturday swim' }, NOW)).toBe(
      'Saturday swim',
    );
    expect(claimRowLabel({ from: 'stated_booking', text: '18-month checkup' }, NOW)).toBe(
      '18-month checkup',
    );
    expect(claimRowLabel({ from: 'pending', text: 'Toddler activities' }, NOW)).toBe(
      'Toddler activities',
    );
  });

  it('a program renders town, domain and cycle; underscores open out', () => {
    expect(
      claimRowLabel({ from: 'program', town: 'Riverford', domain: 'swim', cycle: 'winter' }, NOW),
    ).toBe('Riverford swim winter registration');
    expect(
      claimRowLabel(
        { from: 'program', town: 'Riverford', domain: 'day_camp', cycle: 'summer' },
        NOW,
      ),
    ).toBe('Riverford day camp summer registration');
  });

  it('a program with only a town, and one with nothing, still says what it is', () => {
    expect(
      claimRowLabel({ from: 'program', town: 'Riverford', domain: null, cycle: null }, NOW),
    ).toBe('Riverford registration');
    expect(claimRowLabel({ from: 'program', town: null, domain: null, cycle: null }, NOW)).toBe(
      'registration',
    );
  });
});

// ── B5 · the call-site tripwire ───────────────────────────────────────────────────

const WEB_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');

/** Each `claimRowLabel(` call's argument text, by balanced parentheses. */
function callArguments(source: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('claimRowLabel(', from);
    if (at < 0) return out;
    let depth = 0;
    let end = at + 'claimRowLabel'.length;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(at + 'claimRowLabel('.length, end));
    from = end;
  }
}

/** What the tripwire flags: an unlisted caller, or a non-calendar label built from a title. */
function labelOffenders(files: ReadonlyArray<{ path: string; source: string }>): string[] {
  const allowed = new Set([
    'lib/channel/reconcile/candidate-rows.ts',
    'lib/channel/reconcile/claim-read-probe.ts',
  ]);
  const offenders: string[] = [];
  for (const { path, source } of files) {
    // The definition is not a call.
    if (path === 'lib/channel/reconcile/claim-label.ts') continue;
    const calls = callArguments(source);
    if (calls.length === 0) continue;
    if (!allowed.has(path)) {
      offenders.push(`${path}: unlisted caller`);
      continue;
    }
    for (const arg of calls) {
      // `booking` is activity_bookings.title, a table a 13+ child's confirmation never
      // writes; a family_events title still has only the calendar way in.
      if (!/from:\s*'(?:calendar|booking)'/.test(arg) && /\btitle\b/.test(arg)) {
        offenders.push(`${path}: a title outside the calendar source`);
      }
    }
  }
  return offenders;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts)$/.test(entry) && !/\.test\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('claimRowLabel is called from named files only', () => {
  const files = ['lib', 'app', 'scripts'].flatMap((root) =>
    walk(join(WEB_ROOT, root)).map((full) => ({
      path: full.slice(WEB_ROOT.length + 1),
      source: readFileSync(full, 'utf8'),
    })),
  );

  it('every non-test caller is listed, and a title is labelled only as a calendar row', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(labelOffenders(files)).toEqual([]);
  });

  it('both listed callers are actually found (the walk reaches them)', () => {
    const callers = files.filter((f) => callArguments(f.source).length > 0).map((f) => f.path);
    expect(callers).toEqual(
      expect.arrayContaining([
        'lib/channel/reconcile/candidate-rows.ts',
        'lib/channel/reconcile/claim-read-probe.ts',
      ]),
    );
  });

  it('flags a planted second caller and a title passed to a pending label (positive control)', () => {
    expect(
      labelOffenders([
        {
          path: 'lib/channel/other.ts',
          source: "claimRowLabel({ from: 'pending', text: x }, now)",
        },
        {
          path: 'lib/channel/reconcile/candidate-rows.ts',
          source: "claimRowLabel({ from: 'pending', text: row.title }, now)",
        },
      ]),
    ).toEqual([
      'lib/channel/other.ts: unlisted caller',
      'lib/channel/reconcile/candidate-rows.ts: a title outside the calendar source',
    ]);
  });
});
