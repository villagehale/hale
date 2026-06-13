import { describe, expect, it } from 'vitest';
import { AGENT_MODEL, DEFAULT_SAFETY_POLICY } from './index.js';

/**
 * Expectations are hand-derived from the declared object literals in
 * safety.ts and agent.ts, not copied from runtime output.
 */

describe('DEFAULT_SAFETY_POLICY', () => {
  it('sets the spending caps to the documented defaults', () => {
    expect(DEFAULT_SAFETY_POLICY.spendingCaps.perActionMaxUsd).toBe(50);
    expect(DEFAULT_SAFETY_POLICY.spendingCaps.perDayMaxUsd).toBe(200);
    expect(DEFAULT_SAFETY_POLICY.spendingCaps.perMonthMaxUsd).toBe(1000);
  });

  it('keeps the caps monotonically non-decreasing per-action < per-day < per-month', () => {
    const { perActionMaxUsd, perDayMaxUsd, perMonthMaxUsd } = DEFAULT_SAFETY_POLICY.spendingCaps;
    expect(perActionMaxUsd).toBeLessThan(perDayMaxUsd);
    expect(perDayMaxUsd).toBeLessThan(perMonthMaxUsd);
  });

  it('requires approval for medical and legal categories', () => {
    expect(DEFAULT_SAFETY_POLICY.spendingCaps.categoriesRequiringApproval).toEqual([
      'medical',
      'legal',
    ]);
  });

  it('gates medical and legal recipients behind approval by default', () => {
    expect(DEFAULT_SAFETY_POLICY.recipientRules.medicalRecipientsRequireApproval).toBe(true);
    expect(DEFAULT_SAFETY_POLICY.recipientRules.legalRecipientsRequireApproval).toBe(true);
  });

  it('starts with empty allow/block lists so nothing is implicitly trusted', () => {
    expect(DEFAULT_SAFETY_POLICY.recipientRules.allowlist).toEqual([]);
    expect(DEFAULT_SAFETY_POLICY.recipientRules.blocklist).toEqual([]);
  });

  it('restricts the action time window to 06:00-22:00 America/Toronto', () => {
    expect(DEFAULT_SAFETY_POLICY.timeWindow.allowActionsBetween).toEqual(['06:00', '22:00']);
    expect(DEFAULT_SAFETY_POLICY.timeWindow.timezone).toBe('America/Toronto');
  });

  it('redacts PII in outgoing content by default', () => {
    expect(DEFAULT_SAFETY_POLICY.piiProtection.redactInOutgoing).toBe(true);
  });
});

describe('AGENT_MODEL', () => {
  it('routes the classifier to Haiku and the rest to Sonnet', () => {
    expect(AGENT_MODEL.classifier).toBe('claude-haiku-4-5-20251001');
    expect(AGENT_MODEL.drafter).toBe('claude-sonnet-4-6');
    expect(AGENT_MODEL.coach).toBe('claude-sonnet-4-6');
    expect(AGENT_MODEL.reviewer).toBe('claude-sonnet-4-6');
    expect(AGENT_MODEL.memory_inferencer).toBe('claude-sonnet-4-6');
  });

  it('maps exactly the five declared agents', () => {
    expect(Object.keys(AGENT_MODEL).sort()).toEqual([
      'classifier',
      'coach',
      'drafter',
      'memory_inferencer',
      'reviewer',
    ]);
  });
});
