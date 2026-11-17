import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksLikeJoinRequest } from '~/lib/channel/join/parse';
import { CONTENT_CLASSES, type ContentClass, roleAllows } from '~/lib/channel/role-scope';
import { speak } from '~/lib/channel/spoken-line';

/**
 * The scope a caregiver agrees to lives in the consent-ask skill, which is what
 * the model is told to write. Widening the matrix without rewriting that skill
 * fails here.
 */

const SKILL = readFileSync(
  join(process.cwd(), '../../packages/agent/skills/consent-ask.md'),
  'utf8',
);

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

  it('tells the model to name STOP on a first text, and never a consent token', () => {
    expect(SKILL).toContain('STOP');
    expect(SKILL).toContain('ARRET');
    expect(SKILL).toMatch(/Do not tell them to reply YES/i);
  });

  it('points the refused co-parent add at the command that does work', async () => {
    process.env.JOIN_DOOR_MODEL_COPY_ENABLED = 'true';
    const line = await speak({ purpose: 'caregiver_co_parent_redirect', language: 'en' });
    expect(looksLikeJoinRequest('add my partner')).toBe(true);
    expect(line).toContain('add my partner');
    expect(line).not.toMatch(/sign in|the app|https?:/i);
  });
});
