import { describe, expect, it } from 'vitest';
import { targetLink, targetNoun, trailVerb, verbTone } from './verbs.js';

/**
 * The verb registry's contract: a stored audit verb (memory-writer's
 * `actionTaken` token) is turned into a warm human SENTENCE and a verb FAMILY
 * that drives the row's tone. An unknown verb degrades to a NEUTRAL sentence and
 * the neutral family — never the raw token, never a mislabelled tone. The
 * inventory is memory-writer.ts's full set + the web draft pipeline's
 * record.ts tokens (+ plan-core's `plan_created`).
 */

describe('trailVerb — every verb in the inventory maps to a human sentence', () => {
  // The exhaustive inventory (apps/worker/src/services/memory-writer.ts +
  // apps/web/lib/pipeline/record.ts + apps/web/lib/plan/plan-core.ts). Each must
  // resolve to a curated sentence (never the raw token) and a real family.
  const INVENTORY = [
    'event.classified',
    'action.drafted',
    'action.drafted_duplicate_suppressed',
    'action.reviewer.approved',
    'action.reviewer.rejected',
    'action.reviewer.flagged',
    'action.reviewed.approve',
    'action.reviewed.reject',
    'action.reviewed.flag_for_human',
    'action.executed',
    'action.execution_failed',
    'event.dropped.low_confidence',
    'event.dropped.unknown_action_type',
    'event.dropped.needs_human',
    'event.dropped.spend_ceiling',
    'action.surfaced_to_user',
    'action.entitlement_gated',
    'action.gated.observation_window',
    'action.gated.streak',
    'action.gated.cross_parent_consent',
    'action.gated.teen_redaction',
    'action.gated.over_allowance',
    'action.send_skipped_duplicate',
    'event.stage.classified',
    'event.stage.drafted',
    'event.stage.reviewed',
    'event.stage.approved_pending_execute',
    'event.stage.actioned',
    'event.stage.failed',
    'action.approved_by_human',
    'village.discovery.recorded',
    'village.routine.recorded',
    'plan_created',
  ] as const;

  it.each(INVENTORY)('maps %s to a curated sentence, never the raw token', (verb) => {
    const { sentence, family } = trailVerb(verb);
    expect(sentence).not.toBe(verb);
    expect(sentence).not.toContain('.');
    expect(sentence).not.toContain('_');
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

describe('trailVerb — neutral fallback', () => {
  it('degrades an unknown verb to a neutral sentence + the neutral family, never the raw token', () => {
    const unknown = 'some.brand.new.token';
    const { sentence, family } = trailVerb(unknown);
    expect(sentence).not.toContain(unknown);
    expect(sentence).not.toContain('.');
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
