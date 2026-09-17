import { describe, expect, it } from 'vitest';
import type { ActorResolver, AuditLogEntry } from '~/lib/dashboard/mappers';
import { toTrailView } from '~/lib/dashboard/mappers';
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

  it('says one text of a plan, because that is what one row is', () => {
    // sendInOrder writes one row per MESSAGE of a plan (compose enforces 2-3 per plan),
    // so "Hale sent you a coaching plan" three times reads as three plans.
    expect(trailVerb('coach_plan_message_sent').sentence).not.toContain('sent you a coaching plan');
    expect(trailVerb('coach_plan_message_sent').sentence).toContain('coaching plan');
  });

  it('reads as a warm human sentence for a representative verb', () => {
    expect(trailVerb('action.executed').sentence).toBe('carried out the action');
    expect(trailVerb('action.reviewer.rejected').sentence).toBe(
      'the reviewer raised a concern and held it',
    );
    expect(trailVerb('plan_created').sentence).toBe('you added a plan');
  });
});

/**
 * VIL-355 · WHO the trail's sentence is addressed to, when the person it is about has
 * already left.
 *
 * A departure closes three doors that each have a verb of their own — the SMS channel,
 * a connected assistant, a connector — and reusing those verbs looked like the right
 * kind of thrift. It is not, because of who reads the row afterwards. The trail is one
 * family's, the departed co-parent has no seat, and `buildActorResolver` resolves an
 * actor with no seat to HALE. So the parent who stayed opens their receipts and finds
 * Hale telling them "you turned off texting with Hale" and "you disconnected an outside
 * assistant" about somebody else's doors — two claims about the reader that are false,
 * on the surface whose whole job is to be true.
 *
 * `after.reason` carries 'co_parent_departed', but nothing renders `after`, so the fix
 * is a verb of its own per effect: third-person, and it says leaving is why.
 */
describe('a departure’s rows never tell the parent who stayed that they did it', () => {
  const DEPARTURE_VERBS = [
    'co_parent_channel_sms_revoked',
    'co_parent_mcp_grant_revoked',
    'co_parent_integration_revoked',
  ] as const;

  it.each(DEPARTURE_VERBS)('%s reads in the third person and names the departure', (verb) => {
    const { sentence, family } = trailVerb(verb);
    expect(family).not.toBe('neutral');
    expect(sentence).toContain('co-parent');
    expect(sentence).toContain('left');
    // 'you' as a word, not as the letters inside 'your' — the row is about someone else.
    expect(sentence).not.toMatch(/\byou\b/);
  });

  /**
   * Rendered through the mapper the receipts page actually uses, with the resolver's
   * real answer for a seatless actor ('hale'), because the sentence and the attribution
   * are only wrong TOGETHER: Hale's byline over a first-person claim.
   */
  it('renders the staying parent a third-person row, attributed to Hale', () => {
    const departed = 'user-who-left-uuid';
    const entry = {
      id: 'log-depart-1',
      familyId: 'f1',
      actor: departed,
      actionTaken: 'co_parent_channel_sms_revoked',
      targetTable: 'parent_channels',
      targetId: 'chan-1',
      before: null,
      after: { revoked: true, reason: 'co_parent_departed' },
      occurredAt: new Date('2026-10-01T08:30:00Z'),
      ip: null,
      userAgent: null,
      agentRunId: null,
    } as AuditLogEntry;
    // buildActorResolver's answer for an actor with no family_members row.
    const resolveSeatless: ActorResolver = () => 'hale';

    const view = toTrailView(entry, false, 'America/Toronto', resolveSeatless);

    expect(view.actor).toBe('hale');
    expect(view.summary).toBe('a co-parent’s texting with Hale ended when they left this family');
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
