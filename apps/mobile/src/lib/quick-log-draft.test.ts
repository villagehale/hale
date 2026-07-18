import { describe, expect, it } from 'vitest';

import { buildDraftBody, draftNeedsInput, EMPTY_PICKS, type DraftPicks } from './quick-log-draft';

/**
 * The DRAFT-LOG card's no-fabrication contract. Expected values are derived from the
 * server boundaries (resolveFeed / resolveNap / diaperSchema / milestoneSchema), NOT
 * from the code's output: each kind requires exactly one datum, and a draft that lacks
 * it must (a) report needsInput=true so Approve is withheld, and (b) build a body that
 * OMITS the field — never a fabricated default (no 120 ml, no 30 min, no 'wet', no
 * 'Milestone').
 */

const CHILD = 'c1';
const AT = '2026-07-18T12:00:00.000Z';
const picks = (over: Partial<DraftPicks> = {}): DraftPicks => ({ ...EMPTY_PICKS, ...over });

describe('draftNeedsInput', () => {
  it('feed with no amount needs input; a picked or detected amount resolves it', () => {
    expect(draftNeedsInput({ kind: 'feed' }, picks())).toBe(true);
    expect(draftNeedsInput({ kind: 'feed', feedAmount: 'all' }, picks())).toBe(false);
    expect(draftNeedsInput({ kind: 'feed', amountMl: 90 }, picks())).toBe(false);
    expect(draftNeedsInput({ kind: 'feed' }, picks({ feedAmount: 'half' }))).toBe(false);
  });

  it('nap with no duration needs input; a picked or detected duration resolves it', () => {
    expect(draftNeedsInput({ kind: 'nap' }, picks())).toBe(true);
    expect(draftNeedsInput({ kind: 'nap', durationMin: 45 }, picks())).toBe(false);
    expect(draftNeedsInput({ kind: 'nap' }, picks({ durationMin: 60 }))).toBe(false);
  });

  it('diaper with no kind needs input; a picked or detected kind resolves it', () => {
    expect(draftNeedsInput({ kind: 'diaper' }, picks())).toBe(true);
    expect(draftNeedsInput({ kind: 'diaper', diaperKind: 'dirty' }, picks())).toBe(false);
    expect(draftNeedsInput({ kind: 'diaper' }, picks({ diaperKind: 'wet' }))).toBe(false);
  });

  it('milestone with no text needs input; typed or detected text resolves it (blank/space stays unresolved)', () => {
    expect(draftNeedsInput({ kind: 'milestone' }, picks())).toBe(true);
    expect(draftNeedsInput({ kind: 'milestone' }, picks({ milestone: '   ' }))).toBe(true);
    expect(draftNeedsInput({ kind: 'milestone', milestone: 'first steps' }, picks())).toBe(false);
    expect(draftNeedsInput({ kind: 'milestone' }, picks({ milestone: 'crawled' }))).toBe(false);
  });
});

describe('buildDraftBody — never fabricates a missing datum', () => {
  it('feed: numeric wins; else qualitative; else amount OMITTED (not 120)', () => {
    expect(buildDraftBody({ kind: 'feed', amountMl: 90 }, CHILD, AT, picks())).toEqual({
      kind: 'feed', childId: CHILD, occurredAt: AT, amountMl: 90,
    });
    expect(buildDraftBody({ kind: 'feed' }, CHILD, AT, picks({ feedAmount: 'most' }))).toEqual({
      kind: 'feed', childId: CHILD, occurredAt: AT, feedAmount: 'most',
    });
    const bare = buildDraftBody({ kind: 'feed' }, CHILD, AT, picks());
    expect(bare).not.toHaveProperty('amountMl');
    expect(bare).not.toHaveProperty('feedAmount');
  });

  it('nap: uses the real duration; else durationMin OMITTED (not 30)', () => {
    expect(buildDraftBody({ kind: 'nap', durationMin: 45 }, CHILD, AT, picks())).toEqual({
      kind: 'nap', childId: CHILD, occurredAt: AT, durationMin: 45,
    });
    expect(buildDraftBody({ kind: 'nap' }, CHILD, AT, picks({ durationMin: 90 }))).toEqual({
      kind: 'nap', childId: CHILD, occurredAt: AT, durationMin: 90,
    });
    expect(buildDraftBody({ kind: 'nap' }, CHILD, AT, picks())).not.toHaveProperty('durationMin');
  });

  it('diaper: uses the real kind; else diaperKind OMITTED (not "wet")', () => {
    expect(buildDraftBody({ kind: 'diaper', diaperKind: 'dirty' }, CHILD, AT, picks())).toEqual({
      kind: 'diaper', childId: CHILD, occurredAt: AT, diaperKind: 'dirty',
    });
    expect(buildDraftBody({ kind: 'diaper' }, CHILD, AT, picks({ diaperKind: 'mixed' }))).toEqual({
      kind: 'diaper', childId: CHILD, occurredAt: AT, diaperKind: 'mixed',
    });
    expect(buildDraftBody({ kind: 'diaper' }, CHILD, AT, picks())).not.toHaveProperty('diaperKind');
  });

  it('milestone: uses the real text; NEVER writes the literal "Milestone"', () => {
    expect(buildDraftBody({ kind: 'milestone', milestone: 'first steps' }, CHILD, AT, picks())).toEqual({
      kind: 'milestone', childId: CHILD, occurredAt: AT, milestone: 'first steps',
    });
    expect(buildDraftBody({ kind: 'milestone' }, CHILD, AT, picks({ milestone: '  waved  ' }))).toEqual({
      kind: 'milestone', childId: CHILD, occurredAt: AT, milestone: 'waved',
    });
    const bare = buildDraftBody({ kind: 'milestone' }, CHILD, AT, picks());
    expect(bare).not.toHaveProperty('milestone');
  });
});
