import { describe, expect, it } from 'vitest';
import type { EnforcedRead } from './claim-enforce';
import type { ReadClaimResolution } from './claim-verdict';
import {
  citedOnSurvivors,
  coachClaimLayout,
  cutSegmentSpans,
  inviteOnlyCut,
  judgeCoachRead,
  survivingMints,
} from './coach-enforce';
import type { ReconcileVerdict, RegistrationWatchMint } from './reconcile';
import { segmentSentences, subtractSpans } from './sentences';

type ReadOk = Extract<EnforcedRead, { status: 'read' }>;
const MINT: RegistrationWatchMint = {
  kind: 'registration_watch',
  summary: 'Riverford registration: a text before it opens.',
  dueAt: new Date('2026-12-01T12:00:00Z'),
};
const CLEAN: ReconcileVerdict = { resolutions: [], refused: [], mints: [] };

function cutSegments(reply: string, read: ReadOk, cut: ReadonlySet<number>): string {
  const out = subtractSpans(reply, cutSegmentSpans(reply, read, cut));
  if (out.status !== 'cut') throw new Error('the cut left a fragment');
  return out.text;
}

function readOf(
  body: string,
  resolutions: ReadClaimResolution[],
  mints: RegistrationWatchMint[] = [],
): ReadOk {
  const refused = resolutions.filter((r) => r.status === 'refused').map((r) => r.claim.segment);
  return {
    status: 'read',
    segments: segmentSentences(body, 'en'),
    verdict: { resolutions, refusedSegments: [...new Set(refused)], mints: [] },
    mints,
  };
}

const refused = (
  segment: number,
  kind: ReadClaimResolution['claim']['kind'],
): ReadClaimResolution => ({
  claim: { segment, kind, row: 'none' },
  status: 'refused',
  reason: kind === 'co_parent_invite' ? 'no_coparent_invite' : 'no_scheduled_row',
  why: 'cited_none',
});

describe('coach enforce', () => {
  it('a refused card title or leave line is flagged on its own and never cuts the reply', () => {
    const layout = coachClaimLayout(
      'Swim is Saturday.',
      'Your swim is booked',
      'Your class is booked.',
    );
    const read = readOf(layout.body, [
      refused(1, 'scheduled_event'),
      refused(2, 'scheduled_event'),
    ]);
    expect(read.segments.map((s) => s.text)).toEqual([
      'Swim is Saturday.',
      'Your swim is booked',
      'Your class is booked.',
    ]);
    const judged = judgeCoachRead(read, layout);
    expect(judged).toMatchObject({ cardRefused: true, leaveRefused: true, replyReasons: [] });
    expect(judged.replyCut.size).toBe(0);
  });

  it('the cut is by index: the second of two identical sentences goes, the first stays', () => {
    const reply = 'It is booked. Swim is at ten. It is booked.';
    const read = readOf(reply, [refused(2, 'scheduled_event')]);
    const judged = judgeCoachRead(read, coachClaimLayout(reply, null, null));
    expect(cutSegments(reply, read, judged.replyCut).replace(/\s+/g, ' ').trim()).toBe(
      'It is booked. Swim is at ten.',
    );
  });

  it('a refused sentence naming "St. Mary\'s" is cut whole (VIL-575)', () => {
    const reply = "Swim runs Tuesdays at 4. Your visit at St. Mary's clinic is booked.";
    const read = readOf(reply, [refused(1, 'scheduled_event')]);
    const judged = judgeCoachRead(read, coachClaimLayout(reply, null, null));
    expect(cutSegments(reply, read, judged.replyCut)).toBe('Swim runs Tuesdays at 4.');
  });

  it('a citation counts only on a sentence that reached the parent', () => {
    const reply = "I'll keep looking for swim. Your visit is booked.";
    const read = readOf(reply, [
      {
        claim: { segment: 0, kind: 'activity_followup', row: 'p1' },
        status: 'backed',
        alias: 'p1',
        matchedBy: 'pending_commitment',
      },
      {
        claim: { segment: 1, kind: 'activity_followup', row: 'p2' },
        status: 'backed',
        alias: 'p2',
        matchedBy: 'pending_commitment',
      },
      refused(1, 'scheduled_event'),
    ]);
    const judged = judgeCoachRead(read, coachClaimLayout(reply, null, null));
    const sent = cutSegments(reply, read, judged.replyCut).replace(/\s+/g, ' ').trim();
    expect([...citedOnSurvivors(read, judged, sent)]).toEqual(['p1']);
  });

  it('a mint survives only with its sentence, once however many readings minted it', () => {
    const reply = 'I am watching Riverford registration. It is booked.';
    const minted: ReadClaimResolution = {
      claim: { segment: 0, kind: 'registration_watch', row: 'w1' },
      status: 'minted',
      alias: 'w1',
      window: {} as never,
    };
    const read = readOf(reply, [minted, refused(1, 'scheduled_event')], [MINT]);
    const judged = judgeCoachRead(read, coachClaimLayout(reply, null, null));
    const regex: ReconcileVerdict = {
      resolutions: [
        {
          claim: {
            sentence: 'I am watching Riverford registration.',
            kind: 'registration_watch',
            words: [],
          },
          status: 'minted',
          mint: MINT,
        },
      ],
      refused: [],
      mints: [MINT],
    };
    expect(survivingMints(regex, read, judged, 'I am watching Riverford registration.')).toEqual([
      MINT,
    ]);
    expect(survivingMints(CLEAN, read, judged, 'It is booked.')).toEqual([]);
  });

  it('the empty cut is the invite only when every refused sentence holds a refused invite', () => {
    const reply = "I'll send an invite to that number, and your visit is booked.";
    const layout = coachClaimLayout(reply, null, null);
    const both = judgeCoachRead(
      readOf(reply, [refused(0, 'co_parent_invite'), refused(0, 'scheduled_event')]),
      layout,
    );
    expect(inviteOnlyCut(CLEAN, both)).toBe(true);
    const twoSentences = 'I sent an invite. Your visit is booked.';
    const apart = judgeCoachRead(
      readOf(twoSentences, [refused(0, 'co_parent_invite'), refused(1, 'scheduled_event')]),
      coachClaimLayout(twoSentences, null, null),
    );
    expect(inviteOnlyCut(CLEAN, apart)).toBe(false);
  });
});
