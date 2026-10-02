import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqMultiFamilyGroupsEnabled } from './config';
import {
  MULTI_FAMILY_ASK_DAILY_MAX,
  MULTI_FAMILY_FAMILY_SEND_DAILY_MAX,
  MULTI_FAMILY_GROUP_SEND_DAILY_MAX,
  MULTI_FAMILY_PARENT_COPY,
  classifySharedGroupIntent,
  judgeFamilyAskBudget,
  judgeFamilySendCap,
  replyStaysInThread,
  sharedThreadContext,
} from './multi-family';

describe('LINQ_MULTI_FAMILY_GROUPS_ENABLED', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on only when the flag is exactly true', () => {
    vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
    expect(linqMultiFamilyGroupsEnabled()).toBe(true);
    vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'on');
    expect(linqMultiFamilyGroupsEnabled()).toBe(false);
    vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'false');
    expect(linqMultiFamilyGroupsEnabled()).toBe(false);
    vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', '');
    expect(linqMultiFamilyGroupsEnabled()).toBe(false);
    vi.unstubAllEnvs();
    expect(linqMultiFamilyGroupsEnabled()).toBe(false);
  });
});

describe('shared group intent', () => {
  it('joins or leaves only on the explicit phrase', () => {
    expect(classifySharedGroupIntent('our family is in this group')).toBe('join');
    expect(classifySharedGroupIntent('Notre famille est dans ce groupe.')).toBe('join');
    expect(classifySharedGroupIntent('our family is leaving this group')).toBe('leave');
    expect(classifySharedGroupIntent('notre famille quitte ce groupe')).toBe('leave');
    expect(classifySharedGroupIntent('I think the other family is in')).toBe('none');
    expect(classifySharedGroupIntent('add the Chens')).toBe('none');
  });
});

describe('shared thread copy', () => {
  it('is a design placeholder and carries no opt-out wording', () => {
    for (const line of MULTI_FAMILY_PARENT_COPY) {
      expect(line.startsWith('TODO-Design:')).toBe(true);
      expect(line.toLowerCase()).not.toContain('stop');
    }
    expect(replyStaysInThread(MULTI_FAMILY_PARENT_COPY[0])).toBe(true);
    expect(replyStaysInThread('Zephyrina has soccer on Thursday')).toBe(false);
  });

  it('keeps memory, calendar, email, children, and signups out of the reply context', () => {
    const context = sharedThreadContext(['saturday at the park', '  ']);
    expect(context.threadTexts).toEqual(['saturday at the park']);
    expect(context.memory).toEqual([]);
    expect(context.calendar).toEqual([]);
    expect(context.email).toEqual([]);
    expect(context.children).toEqual([]);
    expect(context.signups).toEqual([]);
  });
});

describe('per-family ask budget and send caps', () => {
  const now = new Date('2026-10-02T15:00:00.000Z');
  const familyA = 'family-a';
  const familyB = 'family-b';

  it('counts asks against the family that was asked', () => {
    const rows = Array.from({ length: MULTI_FAMILY_ASK_DAILY_MAX }, () => ({
      familyId: familyA,
      kind: 'ask' as const,
      createdAt: now,
    }));
    expect(judgeFamilyAskBudget({ now, rows }, familyA)).toEqual({
      allow: false,
      reason: 'ask_budget',
    });
    expect(judgeFamilyAskBudget({ now, rows }, familyB)).toEqual({ allow: true });
  });

  it('counts sends per family and stops the whole chat at the group cap', () => {
    const familyFull = Array.from({ length: MULTI_FAMILY_FAMILY_SEND_DAILY_MAX }, () => ({
      familyId: familyA,
      kind: 'send' as const,
      createdAt: now,
    }));
    expect(judgeFamilySendCap({ now, rows: familyFull }, familyA).allow).toBe(false);
    expect(judgeFamilySendCap({ now, rows: familyFull }, familyB)).toEqual({ allow: true });

    const groupFull = Array.from({ length: MULTI_FAMILY_GROUP_SEND_DAILY_MAX }, (_, index) => ({
      familyId: index % 2 === 0 ? familyA : familyB,
      kind: 'send' as const,
      createdAt: now,
    }));
    expect(judgeFamilySendCap({ now, rows: groupFull }, familyB)).toEqual({
      allow: false,
      reason: 'group_send_cap',
    });
  });
});
