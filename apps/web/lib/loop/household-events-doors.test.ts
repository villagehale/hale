import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural tripwire for the calendar-mirror boundary (VIL-416 follow-up).
 *
 * A row with `google_event_id` set is one parent's own Google event, copied so Hale can
 * remind THAT parent. Only Hale sees both parents' calendars, so every read of
 * family_events that can reach the household has to say `householdFamilyEvent()`.
 * A code review cannot keep that true as readers are added, so every file that reads
 * the table is named here with the reason it may or may not carry the predicate. A new
 * reader fails this test until someone decides which kind it is.
 */

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const SCAN_ROOTS = ['apps/web/lib', 'apps/web/app', 'apps/worker/src', 'packages'];
const READ_SITE =
  /\.from\(\s*schema\.familyEvents\s*\)|Join\(\s*schema\.familyEvents\b|query\.familyEvents\b/g;
const PREDICATE = /householdFamilyEvent\(\)/g;

type Door =
  /** Reaches the household (a parent, a feed, MCP, the coach): every read carries the predicate. */
  | 'household'
  /** Reads mirrors on purpose and answers only to the parent who connected the calendar. */
  | 'owner'
  /** Writes or reconciles the rows; reads only to decide its own write. */
  | 'writer'
  /** Keyed on something a mirror never carries (a source, a join, a placement id). */
  | 'scoped'
  /** Not a product surface. */
  | 'harness';

const DOORS: Record<string, Door> = {
  'apps/web/lib/loop/queries.ts': 'household',
  'apps/web/lib/loop/ics-feed.ts': 'household',
  'apps/web/lib/loop/assistant-events.ts': 'household',
  'apps/web/lib/channel/coach/tools.ts': 'household',
  'apps/web/lib/channel/nudge/saturday-plans.ts': 'household',
  'apps/web/lib/channel/coparent/duty/calendar.ts': 'household',
  'apps/web/lib/channel/coparent/duty/metrics.ts': 'household',
  'apps/web/lib/channel/reconcile/view.ts': 'household',
  'apps/web/lib/memory/workstream-extract.ts': 'household',
  'apps/web/lib/sentinel/candidates.ts': 'household',
  'apps/web/lib/cron/inference-tools.ts': 'household',
  'apps/worker/src/tools/registry.ts': 'household',
  'apps/web/lib/loop/reminders/run.ts': 'owner',
  'apps/web/lib/integrations/calendar-mirror.ts': 'writer',
  'apps/web/lib/integrations/google-calendar-placement.ts': 'writer',
  'apps/worker/src/services/internal-writes.ts': 'writer',
  // source = 'party', or joined through party_invites
  'apps/web/lib/party/reply.ts': 'scoped',
  'apps/web/lib/party/store.ts': 'scoped',
  'apps/web/lib/party/reminders.ts': 'scoped',
  // source = 'placement'
  'apps/web/lib/channel/followup/run.ts': 'scoped',
  'apps/web/lib/loop/calendar-invite.ts': 'scoped',
  // joined through activity_bookings.event_id, reads `source` only
  'apps/web/lib/integrations/booking.ts': 'scoped',
  // sensitive = true; the mirror writer never sets it
  'apps/web/lib/mcp/read-tools.ts': 'scoped',
  // by id, from a placement or a placement follow-up
  'apps/web/lib/loop/ics-invite.ts': 'scoped',
  'apps/web/lib/reviews/capture.ts': 'scoped',
  'apps/web/lib/reviews/subject.ts': 'scoped',
  'apps/web/lib/testing/onboarding-live-harness.ts': 'harness',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

function readSites(): Map<string, { reads: number; predicates: number }> {
  const sites = new Map<string, { reads: number; predicates: number }>();
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(join(REPO_ROOT, root))) {
      const text = readFileSync(file, 'utf8');
      const reads = text.match(READ_SITE)?.length ?? 0;
      if (reads === 0) continue;
      const predicates = text.match(PREDICATE)?.length ?? 0;
      sites.set(file.slice(REPO_ROOT.length + 1), { reads, predicates });
    }
  }
  return sites;
}

describe('every family_events reader is a named door', () => {
  const sites = readSites();

  it('classifies exactly the files that read family_events', () => {
    expect([...sites.keys()].sort()).toEqual(Object.keys(DOORS).sort());
  });

  it('puts householdFamilyEvent() on every read in a household door', () => {
    const household = Object.entries(DOORS).filter(([, door]) => door === 'household');
    expect(household.length).toBeGreaterThan(0);
    for (const [file] of household) {
      const site = sites.get(file);
      expect({ file, ...site }).toEqual({ file, reads: site?.reads, predicates: site?.reads });
    }
  });
});
