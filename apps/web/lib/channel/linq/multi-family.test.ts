import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqMultiFamilyGroupsEnabled } from './config';
import { sharedThreadContext } from './multi-family';

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

describe('shared group path has no keyword and no fixed line', () => {
  const files = [
    'multi-family.ts',
    'shared-group-reading.ts',
    'shared-group-line-input.ts',
    'shared-group-voice.ts',
    'inbound.ts',
  ];

  it('grep: no TODO-Design, no join phrase, no classifySharedGroupIntent', () => {
    for (const file of files) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toContain('TODO-Design:');
      expect(source, file).not.toMatch(/our family is in this group/i);
      expect(source, file).not.toMatch(/notre famille est dans ce groupe/i);
      expect(source, file).not.toMatch(/our family is leaving this group/i);
      expect(source, file).not.toMatch(/notre famille quitte ce groupe/i);
      expect(source, file).not.toContain('classifySharedGroupIntent');
      expect(source, file).not.toContain('MULTI_FAMILY_JOINED_TEXT');
      expect(source, file).not.toContain('MULTI_FAMILY_SHARED_REPLY');
    }
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
