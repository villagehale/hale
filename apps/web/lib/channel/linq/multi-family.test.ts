import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqMultiFamilyGroupsEnabled } from './config';
import * as multiFamily from './multi-family';
import { sharedGroupLineInput } from './shared-group-line-input';
import {
  SHARED_GROUP_INTENTS,
  createSharedGroupReader,
  parseSharedGroupReading,
  sharedGroupReader,
} from './shared-group-reading';

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

describe('shared group path has no keyword list', () => {
  it('the door consumes a model reading, not a phrase table', () => {
    expect(multiFamily).not.toHaveProperty('classifySharedGroupIntent');
    expect(multiFamily).not.toHaveProperty('MULTI_FAMILY_JOINED_TEXT');
    expect(multiFamily).not.toHaveProperty('MULTI_FAMILY_SHARED_REPLY');
    expect(typeof multiFamily.takeMultiFamilyTurn).toBe('function');
    expect(typeof createSharedGroupReader).toBe('function');
    expect(SHARED_GROUP_INTENTS).toEqual(
      expect.arrayContaining(['stop_me', 'chatter', 'question', 'who_i_am']),
    );
    expect(parseSharedGroupReading('anything they typed').intent).toBe('unclear');
    expect(
      parseSharedGroupReading({
        intent: 'stop_me',
        role: 'unclear',
        familyLabel: null,
        kidName: null,
        confidence: 'high',
      }).intent,
    ).toBe('stop_me');
    const stop = sharedGroupLineInput({ kind: 'member_stop', name: 'Jordan' }, 'en');
    expect(stop.facts).toEqual({ name: 'Jordan' });
    expect(stop).not.toHaveProperty('line');
    expect(stop.skill).toBe('shared-group-voice');
  });

  it('has no reader when the model is not there — not a word list', () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeFalsy();
    expect(sharedGroupReader()).toBeNull();
  });

  it('keeps memory, calendar, email, children, and signups out of the reply context', () => {
    const context = multiFamily.sharedThreadContext(['saturday at the park', '  ']);
    expect(context.threadTexts).toEqual(['saturday at the park']);
    expect(context.memory).toEqual([]);
    expect(context.calendar).toEqual([]);
    expect(context.email).toEqual([]);
    expect(context.children).toEqual([]);
    expect(context.signups).toEqual([]);
  });
});
