import { describe, expect, it } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  type AddThemYourselfRequest,
  MAX_ADD_THEM_YOURSELF_CHARS,
  addThemYourselfRefusals,
  addThemYourselfUserMessage,
} from './add-them-yourself';

/**
 * The gates on the one reply to "add grandma 647-555-0199 as grandparent". Hale texts
 * nobody first, so the reply tells the parent to add the person to their group with Hale
 * in it, or have them text Hale. Every refusal here is a sentence that would otherwise
 * have reached a parent.
 */

const GRAN_IMESSAGE: AddThemYourselfRequest = {
  language: 'en',
  name: 'grandma',
  role: 'grandparent',
  channel: 'imessage',
};
const SAM_SMS: AddThemYourselfRequest = {
  language: 'en',
  name: 'Sam',
  role: 'co_parent',
  channel: 'sms',
};

describe('addThemYourselfRefusals', () => {
  it('passes a reply that says how they get in, on each door', () => {
    expect(
      addThemYourselfRefusals(
        "I don't text people first. Add grandma to your family group with me in it, or have her text me here.",
        GRAN_IMESSAGE,
      ),
    ).toEqual([]);
    expect(
      addThemYourselfRefusals(
        "I don't text anyone first, so have Sam text me here and I'll take it from there.",
        SAM_SMS,
      ),
    ).toEqual([]);
  });

  it('refuses a reply that says Hale texted them, or will', () => {
    for (const body of [
      "I'll text grandma now and add her to your group.",
      'I texted grandma just now.',
      "I've invited grandma to your group.",
    ]) {
      expect(addThemYourselfRefusals(body, GRAN_IMESSAGE), body).toContain('claims_contact');
    }
  });

  it('refuses a number, a link, and a second question', () => {
    expect(
      addThemYourselfRefusals('Add grandma at 647-555-0199 to your group.', GRAN_IMESSAGE),
    ).toContain('carries_number');
    expect(
      addThemYourselfRefusals(
        'Add grandma to your group: https://villagehale.com/join',
        GRAN_IMESSAGE,
      ),
    ).toContain('carries_link');
    expect(
      addThemYourselfRefusals(
        'Want to add grandma to your group? Or should she text me?',
        GRAN_IMESSAGE,
      ),
    ).toContain('too_many_questions');
  });

  it('wants the name they gave, and the group on iMessage only', () => {
    expect(
      addThemYourselfRefusals('Add her to your group, or have her text me.', GRAN_IMESSAGE),
    ).toContain('name_missing');
    expect(
      addThemYourselfRefusals('Have grandma text me here whenever she likes.', GRAN_IMESSAGE),
    ).toContain('group_missing');
    expect(addThemYourselfRefusals('Have Sam text me here whenever.', SAM_SMS)).toEqual([]);
  });

  it('refuses an empty reply and one over the budget', () => {
    expect(addThemYourselfRefusals('', GRAN_IMESSAGE)).toEqual(['empty']);
    const long = `Add grandma to your group with me. ${'x'.repeat(MAX_ADD_THEM_YOURSELF_CHARS)}`;
    expect(addThemYourselfRefusals(long, GRAN_IMESSAGE)).toContain('over_char_cap');
  });
});

describe('the request the model sees', () => {
  it('carries the kind, the facts, and no phone number', () => {
    const message = JSON.parse(addThemYourselfUserMessage(GRAN_IMESSAGE));
    expect(message).toEqual({
      kind: 'add_them_yourself',
      language: 'en',
      address: 'tu',
      facts: { name: 'grandma', role: 'grandparent', channel: 'imessage' },
    });
    expect(addThemYourselfUserMessage(GRAN_IMESSAGE)).not.toMatch(/\d{3}/);
  });

  it('hands a refused draft back on the retry', () => {
    const message = JSON.parse(
      addThemYourselfUserMessage(GRAN_IMESSAGE, [
        { draft: 'I texted grandma.', problems: ['claims_contact'] },
      ]),
    );
    expect(message.rejected).toEqual([
      { draft: 'I texted grandma.', problems: ['claims_contact'] },
    ]);
  });

  it('loads its skill by the name the group onboarding lines share', async () => {
    const skill = await loadCronSkill('group-onboarding-voice');
    expect(skill.meta.name).toBe('group-onboarding-voice');
    expect(skill.meta.task).toBe('speak');
    expect(skill.instructions).toContain('add_them_yourself');
  });
});
