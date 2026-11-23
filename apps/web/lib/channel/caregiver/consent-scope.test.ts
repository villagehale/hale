import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksLikeJoinRequest } from '~/lib/channel/join/parse';
import { CONTENT_CLASSES, type ContentClass, roleAllows } from '~/lib/channel/role-scope';

/**
 * The scope a caregiver agrees to lives in the consent-ask skill, which is what
 * the model is told to write. Widening the matrix without rewriting that skill
 * fails here.
 */

const skill = (name: string) =>
  readFileSync(join(process.cwd(), `../../packages/agent/skills/${name}.md`), 'utf8');

const SKILL = skill('consent-ask');

const NAMED: Partial<Record<ContentClass, string>> = {
  schedule: "the week's schedule",
  pickup_duty: 'pickup reminders',
  event_logistics: 'time and address',
  health: 'health or appointments',
  teen_content: 'teenager',
  registration: 'sign-ups or money',
  family_settings: 'account settings',
};

describe('caregiver scope · the skill matches the matrix', () => {
  it('accounts for every content class — named, or closed off as nothing else', () => {
    const unnamed = CONTENT_CLASSES.filter((c) => !(c in NAMED));
    expect(unnamed).toEqual(['village_suggestion']);
    expect(SKILL).toContain('nothing else');
  });

  it.each(Object.entries(NAMED))('names %s in the skill', (_cls, phrase) => {
    expect(SKILL).toContain(phrase);
  });

  it('puts every denied class after the word Never', () => {
    const denied = CONTENT_CLASSES.filter((c) => !roleAllows('grandparent', c) && c in NAMED);
    const never = SKILL.slice(SKILL.indexOf('Never'));
    for (const cls of denied) {
      expect(never).toContain(NAMED[cls]);
    }
  });

  it('never tells the model to ask for a consent token', () => {
    expect(SKILL).toMatch(/Do not tell them to reply YES/i);
  });

  /**
   * VIL-706. Dark, the skill keeps its bytes, and with them its STOP line on a first text
   * to a stranger. Lit, the `consent-ask-no-keyword` addendum rides on exactly those
   * kinds and withdraws it (consent-ask.ts `consentAskKeywordless`).
   */
  it('dark keeps the STOP line; the lit addendum withdraws it and names no keyword to type', () => {
    expect(SKILL).toContain('STOP');
    const addendum = skill('consent-ask-no-keyword');
    expect(addendum).toContain('This replaces every line above that lets you name STOP or ARRET');
    expect(addendum).toContain(
      'never name STOP, ARRET, HELP, AIDE, or any other word to reply with',
    );
    expect(addendum).toContain('in their own words');
  });

  it('points the refused co-parent add at a command the join door actually reads', () => {
    // The door-line skill tells the model to point at "add my partner". That only helps
    // if the parser takes those exact words as a join request.
    const doors = skill('door-line');
    const redirect = doors.slice(doors.indexOf('`caregiver_co_parent_redirect`'));
    expect(redirect).toContain('"add my partner"');
    expect(looksLikeJoinRequest('add my partner')).toBe(true);
    expect(redirect.split('\n')[0]).not.toMatch(/sign in|the app|https?:/i);
  });
});
