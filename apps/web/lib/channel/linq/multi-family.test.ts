import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqMultiFamilyGroupsEnabled } from './config';
import {
  MULTI_FAMILY_PARENT_COPY,
  classifySharedGroupIntent,
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
