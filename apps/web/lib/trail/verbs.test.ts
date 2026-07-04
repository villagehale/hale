import { describe, expect, it } from 'vitest';
import { AUDIT_VERBS, targetLink, targetNoun, trailVerb, verbTone } from './verbs.js';

/** No trail row may ever render a raw table name, a raw snake_case/dotted action
 * token, or a bare UUID (defect: /trail leaked `families · family_created · <uuid>`).
 * A verb sentence is clean iff it contains no `.`/`_` (the token separators) and is
 * not the token itself. */
const UUID = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
function assertCleanHuman(sentence: string, token: string): void {
  expect(sentence).not.toBe(token);
  expect(sentence).not.toContain('.');
  expect(sentence).not.toContain('_');
  expect(sentence).not.toContain(UUID);
}

/**
 * The verb registry's contract: a stored audit verb (memory-writer's
 * `actionTaken` token) is turned into a warm human SENTENCE and a verb FAMILY
 * that drives the row's tone. An unknown verb degrades to a NEUTRAL sentence and
 * the neutral family — never the raw token, never a mislabelled tone. The
 * inventory is memory-writer.ts's full set + the web draft pipeline's
 * record.ts tokens (+ plan-core's `plan_created`).
 */

describe('trailVerb — every verb the app writes maps to a human sentence', () => {
  // The inventory is DERIVED from AUDIT_VERBS (the source of truth beside the
  // registry), not hand-copied — so it cannot drift from what VERBS covers. This
  // is the test that would have caught the leak: family_created / tos_accepted /
  // quick_log_* / village.* were written but absent from the registry.
  it.each(AUDIT_VERBS)('maps %s to a curated sentence, never the raw token', (verb) => {
    const { sentence, family } = trailVerb(verb);
    assertCleanHuman(sentence, verb);
    expect(family).not.toBe('neutral');
  });

  it('reads as a warm human sentence for a representative verb', () => {
    expect(trailVerb('action.executed').sentence).toBe('carried out the action');
    expect(trailVerb('action.reviewer.rejected').sentence).toBe(
      'the reviewer raised a concern and held it',
    );
    expect(trailVerb('plan_created').sentence).toBe('you added a plan');
  });
});

describe('trailVerb — neutral fallback for an unknown verb still renders clean', () => {
  it('degrades an unknown verb to a neutral human sentence, never the raw token', () => {
    const unknown = 'families.some_brand_new.token';
    const { sentence, family } = trailVerb(unknown);
    assertCleanHuman(sentence, unknown);
    expect(family).toBe('neutral');
  });
});

describe('verbTone — the row tone follows the verb family (failures never read done)', () => {
  it('a completed action reads done', () => {
    expect(verbTone(trailVerb('action.executed').family)).toBe('done');
    expect(verbTone(trailVerb('action.reviewer.approved').family)).toBe('done');
  });

  it('a failure/rejection does NOT read done', () => {
    expect(verbTone(trailVerb('action.execution_failed').family)).not.toBe('done');
    expect(verbTone(trailVerb('action.reviewer.rejected').family)).not.toBe('done');
    expect(verbTone(trailVerb('action.reviewed.reject').family)).not.toBe('done');
    expect(verbTone(trailVerb('event.dropped.spend_ceiling').family)).not.toBe('done');
  });

  it('a held/awaiting-you gate reads as awaiting or needs-you, not done', () => {
    expect(verbTone(trailVerb('action.surfaced_to_user').family)).not.toBe('done');
    expect(verbTone(trailVerb('action.gated.cross_parent_consent').family)).not.toBe('done');
  });

  it('the neutral family reads as a quiet note, not a false done', () => {
    expect(verbTone('neutral')).not.toBe('done');
  });
});

describe('targetNoun — a stored table name becomes a domain noun, never the raw table', () => {
  it('maps known target tables to domain nouns', () => {
    expect(targetNoun('actions')).toBe('draft');
    expect(targetNoun('events')).toBe('signal');
    expect(targetNoun('family_plans')).toBe('plan');
  });

  it('degrades an unknown/absent table to a neutral noun, never the raw token', () => {
    expect(targetNoun('some_internal_table')).toBe('record');
    expect(targetNoun(null)).toBe('record');
  });
});

describe('targetLink — a UUID becomes a deep link, never a bare id', () => {
  it('links an action target to the approvals surface', () => {
    expect(targetLink('actions', 'act-9')).toBe('/approvals');
  });

  it('links a plan target to the plan surface', () => {
    expect(targetLink('family_plans', 'plan-3')).toBe('/plan');
  });

  it('returns null (no fake link) for a target with no viewable surface', () => {
    expect(targetLink('events', 'evt-1')).toBeNull();
    expect(targetLink('families', 'fam-1')).toBeNull();
    expect(targetLink(null, null)).toBeNull();
  });
});
