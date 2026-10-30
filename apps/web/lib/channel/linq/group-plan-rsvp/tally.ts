/**
 * VIL-442 (T15) — the live count for any plan in a group chat.
 *
 * Generalized from lib/party/tally.ts: birthdays were the first plan; this is
 * the same headcount math for a picnic, a museum Saturday, soccer, anything
 * the group is collecting yeses for.
 *
 * HEADS, NOT REPLIES. One answer can be a family of four, so `yesHeads` is what
 * the group hears first; `yesCount` is how many households answered yes.
 * `waiting` is who has not answered yet — "6 yes, 2 to go" is these two
 * numbers, as facts, never as a frozen sentence.
 *
 * `maybe` stays its own bucket. Rolling it into `no` understates the room;
 * rolling it into `yes` overstates it.
 */

import type { GroupPlanRsvpIntent } from './reading';

export type PlanRsvpResponse = 'yes' | 'no' | 'maybe';

export interface PlanTallyRow {
  memberKey: string;
  displayName: string;
  response: PlanRsvpResponse;
  headcount: number;
  householdLabel: string | null;
  coversKeys: readonly string[];
}

export interface PlanExpectedRow {
  memberKey: string;
  displayName: string;
}

export interface PlanTally {
  yesCount: number;
  yesHeads: number;
  yesNames: string[];
  noCount: number;
  noNames: string[];
  maybeCount: number;
  maybeHeads: number;
  maybeNames: string[];
  waitingCount: number;
  waitingNames: string[];
  /** Same number as waitingCount — the "to go" half of the live count. */
  toGo: number;
}

function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function coveredKeys(rows: readonly PlanTallyRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    keys.add(row.memberKey);
    for (const extra of row.coversKeys) keys.add(extra);
  }
  return keys;
}

export function tallyPlanRsvps(
  rows: readonly PlanTallyRow[],
  expected: readonly PlanExpectedRow[],
): PlanTally {
  const tally: PlanTally = {
    yesCount: 0,
    yesHeads: 0,
    yesNames: [],
    noCount: 0,
    noNames: [],
    maybeCount: 0,
    maybeHeads: 0,
    maybeNames: [],
    waitingCount: 0,
    waitingNames: [],
    toGo: 0,
  };

  for (const row of rows) {
    const label = row.householdLabel?.trim() || row.displayName;
    if (row.response === 'yes') {
      tally.yesCount += 1;
      tally.yesHeads += row.headcount;
      tally.yesNames.push(label);
    } else if (row.response === 'maybe') {
      tally.maybeCount += 1;
      tally.maybeHeads += row.headcount;
      tally.maybeNames.push(label);
    } else {
      tally.noCount += 1;
      tally.noNames.push(label);
    }
  }

  const taken = coveredKeys(rows);
  for (const person of expected) {
    if (taken.has(person.memberKey)) continue;
    tally.waitingNames.push(person.displayName);
  }
  tally.waitingCount = tally.waitingNames.length;
  tally.toGo = tally.waitingCount;

  tally.yesNames = uniqueNames(tally.yesNames);
  tally.noNames = uniqueNames(tally.noNames);
  tally.maybeNames = uniqueNames(tally.maybeNames);
  tally.waitingNames = uniqueNames(tally.waitingNames);
  return tally;
}

/**
 * Whether Hale should speak this turn. Settle points, not every reply:
 * someone asked, tracking just started, an answer was edited, a household
 * answered for several people, or nobody is left waiting.
 */
export function isMeaningfulTallyChange(input: {
  intent: GroupPlanRsvpIntent;
  before: PlanTally | null;
  after: PlanTally;
  householdAnswer: boolean;
}): boolean {
  if (
    input.intent === 'start_tracking' ||
    input.intent === 'ask_tally' ||
    input.intent === 'edit'
  ) {
    return true;
  }
  if (input.intent !== 'rsvp') return false;
  if (input.householdAnswer) return true;
  if (input.after.toGo === 0 && (input.before === null || input.before.toGo > 0)) return true;
  return false;
}

/** Facts the voice skill may use. Numbers and names only — never a sentence. */
export function planTallyFacts(tally: PlanTally): {
  yesCount: number;
  yesHeads: number;
  yesNames: string[];
  noCount: number;
  noNames: string[];
  maybeCount: number;
  maybeHeads: number;
  maybeNames: string[];
  waitingCount: number;
  waitingNames: string[];
  toGo: number;
} {
  return {
    yesCount: tally.yesCount,
    yesHeads: tally.yesHeads,
    yesNames: [...tally.yesNames],
    noCount: tally.noCount,
    noNames: [...tally.noNames],
    maybeCount: tally.maybeCount,
    maybeHeads: tally.maybeHeads,
    maybeNames: [...tally.maybeNames],
    waitingCount: tally.waitingCount,
    waitingNames: [...tally.waitingNames],
    toGo: tally.toGo,
  };
}
