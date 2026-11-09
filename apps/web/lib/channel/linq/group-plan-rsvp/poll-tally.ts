/**
 * VIL-471 — the live count for a poll in a group chat.
 *
 * One current pick per person (latest word wins). Code counts option keys the
 * reader or a native card already resolved; it never reads message text.
 * `waiting` is who Hale expected and has not picked yet. Every number here is
 * a fact for the voice skill, never a sentence.
 */

export interface GroupPollOption {
  key: string;
  text: string;
  providerOptionId: string | null;
}

export interface GroupPollVoteRow {
  memberKey: string;
  displayName: string;
  optionKey: string;
}

export interface GroupPollExpectedRow {
  memberKey: string;
  displayName: string;
}

export interface GroupPollOptionCount {
  key: string;
  text: string;
  votes: number;
  voterNames: string[];
}

export interface GroupPollTally {
  options: GroupPollOptionCount[];
  /** Texts of the options with the most votes. Empty until someone votes; more than one is a tie. */
  leaders: string[];
  votedCount: number;
  waitingCount: number;
  waitingNames: string[];
  toGo: number;
}

/** Most choices a group poll carries. A native card stays readable on a phone. */
export const GROUP_POLL_MAX_OPTIONS = 6;

export function optionKeyAt(index: number): string {
  return `o${index + 1}`;
}

export function tallyGroupPoll(
  options: readonly GroupPollOption[],
  votes: readonly GroupPollVoteRow[],
  expected: readonly GroupPollExpectedRow[],
): GroupPollTally {
  const counts = options.map((option) => ({
    key: option.key,
    text: option.text,
    votes: 0,
    voterNames: [] as string[],
  }));
  const byKey = new Map(counts.map((count) => [count.key, count]));
  const voted = new Set<string>();
  for (const vote of votes) {
    const count = byKey.get(vote.optionKey);
    if (!count || voted.has(vote.memberKey)) continue;
    voted.add(vote.memberKey);
    count.votes += 1;
    count.voterNames.push(vote.displayName);
  }
  const top = Math.max(0, ...counts.map((count) => count.votes));
  const leaders = top > 0 ? counts.filter((c) => c.votes === top).map((c) => c.text) : [];
  const waitingNames: string[] = [];
  const seen = new Set<string>();
  for (const person of expected) {
    if (voted.has(person.memberKey) || seen.has(person.memberKey)) continue;
    seen.add(person.memberKey);
    waitingNames.push(person.displayName);
  }
  return {
    options: counts,
    leaders,
    votedCount: voted.size,
    waitingCount: waitingNames.length,
    waitingNames,
    toGo: waitingNames.length,
  };
}

/**
 * Whether Hale reads the tally back this turn. Settle points only: someone
 * asked, or the last person Hale was waiting on just picked. A vote in the
 * middle is recorded quietly.
 */
export function isPollSettlePoint(input: {
  asked: boolean;
  before: GroupPollTally;
  after: GroupPollTally;
}): boolean {
  if (input.asked) return true;
  return input.before.toGo > 0 && input.after.toGo === 0 && input.after.votedCount > 0;
}
