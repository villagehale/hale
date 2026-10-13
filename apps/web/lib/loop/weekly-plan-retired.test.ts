import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The weekly plan and the Sunday send are retired (VIL-226 / D-F), not braked: no switch
 * guards them, so the only proof they cannot run is that their code is gone. The
 * persisted names stay — the `weekly_plan` enum values, the `loop_prefs` columns and the
 * migrations that created them — because a schema change here would be destructive.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const THIS_FILE = 'apps/web/lib/loop/weekly-plan-retired.test.ts';
const PERSISTED = ['packages/db/drizzle/', 'packages/db/src/schema/'];

function gitGrep(pattern: string, pathspecs: string[]): string[] {
  try {
    return execFileSync('git', ['grep', '-n', '-F', '-e', pattern, '--', ...pathspecs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

describe('the weekly plan is retired', () => {
  it.each([
    'runSundaySendCron',
    'loadWeekSummarySkill',
    'weekly_plan_send_time',
    'scopeWeekItemsForRole',
  ])('%s has no reference outside the persisted schema', (symbol) => {
    const excluded = [THIS_FILE, ...PERSISTED].map((path) => `:!${path}`);
    expect(gitGrep(symbol, ['.', ...excluded])).toEqual([]);
  });

  it('keeps the persisted weekly_plan enum values (positive control on the grep)', () => {
    expect(gitGrep("'weekly_plan',", ['packages/db/src/schema/enums.ts'])).toHaveLength(2);
  });

  it('schedules neither the week-plan nor the sunday-send cron', () => {
    const { crons } = JSON.parse(readFileSync(`${REPO_ROOT}apps/web/vercel.json`, 'utf8')) as {
      crons: Array<{ path: string }>;
    };
    const paths = crons.map((cron) => cron.path);
    expect(paths).toContain('/api/cron/reminders');
    expect(paths).not.toContain('/api/cron/week-plan');
    expect(paths).not.toContain('/api/cron/sunday-send');
  });
});
