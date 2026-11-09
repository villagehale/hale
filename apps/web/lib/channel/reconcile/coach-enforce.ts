import type { ClaimRowAlias } from './candidates';
import { type EnforcedRead, refusedResolutions } from './claim-enforce';
import type { ReconcileVerdict, RefusalReason, RegistrationWatchMint } from './reconcile';
import type { Span } from './sentences';

/**
 * VIL-581 PR 3 · what an enforced claim read means for one coach attempt. Pure.
 *
 * The coach can send three model-written strings: the reply, the experience card's
 * title and the line it sends if a group leave is refused. All three are read in one
 * call, each its own segment (a blank line always splits). A refusal in the reply
 * re-asks as main's regex refusal does; a refused card title sends no card and a
 * refused leave line is never sent, while the text still goes.
 *
 * The cut is by SEGMENT INDEX, never by searching for a sentence, so it cannot hit the
 * wrong place. And what survives the cut decides what is written after the send: a
 * pending promise or watch is kept only if a sentence that cites it reached the parent.
 */

type ReadOk = Extract<EnforcedRead, { status: 'read' }>;

export interface CoachClaimLayout {
  body: string;
  /** Code units [0, replyEnd) of `body` are the reply. */
  replyEnd: number;
  cardStart: number | null;
  leaveStart: number | null;
}

export function coachClaimLayout(
  reply: string,
  cardTitle: string | null,
  leaveLine: string | null,
): CoachClaimLayout {
  let body = reply.trim() === '' ? '' : reply;
  const replyEnd = body.length;
  const append = (text: string | null): number | null => {
    if (text === null || text.trim() === '') return null;
    if (body !== '') body += '\n\n';
    const start = body.length;
    body += text;
    return start;
  };
  const cardStart = append(cardTitle);
  const leaveStart = append(leaveLine);
  return { body, replyEnd, cardStart, leaveStart };
}

export interface CoachJudgement {
  /** The reasons the reply's refused claims carry, for the re-ask and the counts. */
  replyReasons: readonly RefusalReason[];
  /** Reply segments holding any refused claim. */
  replyCut: ReadonlySet<number>;
  /** Reply segments holding a refused co-parent invite. */
  inviteSegments: ReadonlySet<number>;
  cardRefused: boolean;
  leaveRefused: boolean;
}

type Part = 'reply' | 'card' | 'leave';

function partOf(start: number, layout: CoachClaimLayout): Part {
  if (layout.leaveStart !== null && start >= layout.leaveStart) return 'leave';
  if (layout.cardStart !== null && start >= layout.cardStart) return 'card';
  return 'reply';
}

export function judgeCoachRead(read: ReadOk, layout: CoachClaimLayout): CoachJudgement {
  const replyReasons: RefusalReason[] = [];
  const replyCut = new Set<number>();
  const inviteSegments = new Set<number>();
  let cardRefused = false;
  let leaveRefused = false;
  for (const refusal of refusedResolutions(read.verdict)) {
    const segment = read.segments[refusal.claim.segment];
    if (!segment) throw new RangeError('coach enforce: a refusal cites no segment');
    const part = partOf(segment.start, layout);
    if (part === 'card') cardRefused = true;
    else if (part === 'leave') leaveRefused = true;
    else {
      replyReasons.push(refusal.reason);
      replyCut.add(segment.index);
      if (refusal.claim.kind === 'co_parent_invite') inviteSegments.add(segment.index);
    }
  }
  return { replyReasons, replyCut, inviteSegments, cardRefused, leaveRefused };
}

/** Where the cut segments sit in the reply, by index (`subtractSpans` removes them). */
export function cutSegmentSpans(reply: string, read: ReadOk, cut: ReadonlySet<number>): Span[] {
  return read.segments
    .filter((segment) => segment.start < reply.length && cut.has(segment.index))
    .map((segment) => ({ start: segment.start, end: Math.min(segment.end, reply.length) }));
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A reply segment the parent will actually read: not cut by the reader, and not
 * removed by the regex floor's own cut either. */
function survives(read: ReadOk, judged: CoachJudgement, sent: string, index: number): boolean {
  const segment = read.segments[index];
  return (
    segment !== undefined && !judged.replyCut.has(index) && sent.includes(collapse(segment.text))
  );
}

/** The aliases backed claims cite in sentences that reached the parent. */
export function citedOnSurvivors(
  read: ReadOk,
  judged: CoachJudgement,
  sent: string,
): ReadonlySet<ClaimRowAlias> {
  return new Set(
    read.verdict.resolutions
      .filter((r) => r.status !== 'refused' && survives(read, judged, sent, r.claim.segment))
      .map((r) => r.claim.row),
  );
}

/** The mints whose sentence reached the parent, from either reading, once per window. */
export function survivingMints(
  regex: ReconcileVerdict,
  read: ReadOk,
  judged: CoachJudgement,
  sent: string,
): RegistrationWatchMint[] {
  const regexMints = regex.resolutions.flatMap((r) =>
    r.status === 'minted' && sent.includes(collapse(r.claim.sentence)) ? [r.mint] : [],
  );
  const readerMinted = read.verdict.resolutions.some(
    (r) => r.status === 'minted' && survives(read, judged, sent, r.claim.segment),
  );
  const all = [...regexMints, ...(readerMinted ? read.mints : [])];
  const seen = new Set<string>();
  return all.filter((mint) => {
    const key = `${mint.summary}|${mint.dueAt.toISOString()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every refusal, from either reading, sits in a sentence that also holds a refused
 * co-parent invite: the empty cut is the invite, and the invite path may answer it. */
export function inviteOnlyCut(regex: ReconcileVerdict, judged: CoachJudgement): boolean {
  return (
    regex.refused.every((r) => r.reason === 'no_coparent_invite') &&
    [...judged.replyCut].every((segment) => judged.inviteSegments.has(segment))
  );
}
