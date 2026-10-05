import { schema } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { COLD_START_ASK, greeting } from '~/lib/channel/intake/copy';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import {
  type ParentCallNameRead,
  type ParentCallNameVoice,
  decideParentCallName,
  handleParentCallNameReply,
  holdGoogleGivenName,
  safeGivenName,
} from './parent-call-name';

const FAMILY_A = '11111111-1111-4111-8111-111111111111';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';
const PHONE = '+14165550100';

/** A voice that answers with what the test says the model read. */
function voiceReading(read: Partial<ParentCallNameRead>): ParentCallNameVoice & {
  calls: { body: string; heldName: string }[];
} {
  const calls: { body: string; heldName: string }[] = [];
  return {
    calls,
    async read(input) {
      calls.push({ body: input.body, heldName: input.heldName });
      return {
        reply: 'MODEL REPLY',
        parentName: null,
        nameConfirmed: null,
        parentRole: null,
        ...read,
      };
    },
  };
}

describe('decideParentCallName', () => {
  const open = {
    needsName: true,
    alreadyAsked: false,
    isWin: true,
    googleGivenName: null as string | null,
  };

  it('asks once after a win, and not before one, and carries no fixed words', () => {
    const decision = decideParentCallName(open);
    expect(decision).toEqual({ kind: 'ask', templateKey: 'parent_name_ask' });
    expect(decision).not.toHaveProperty('body');
    expect(decideParentCallName({ ...open, isWin: false }).kind).toBe('none');
  });

  it('confirms a Google given name by handing the model the name, not a sentence', () => {
    expect(decideParentCallName({ ...open, googleGivenName: 'Bea' })).toEqual({
      kind: 'confirm',
      first: 'Bea',
      templateKey: 'parent_name_confirm',
    });
  });

  it('keeps an accented given name — the model writes the line, so GSM-7 is no longer a gate', () => {
    expect(decideParentCallName({ ...open, googleGivenName: 'Zoë' })).toEqual({
      kind: 'confirm',
      first: 'Zoë',
      templateKey: 'parent_name_confirm',
    });
  });

  it('never invents a name from a phone number', () => {
    expect(safeGivenName(PHONE)).toBeNull();
    expect(safeGivenName('416-555-0100')).toBeNull();
    const decision = decideParentCallName({ ...open, googleGivenName: PHONE });
    expect(decision).toEqual({ kind: 'ask', templateKey: 'parent_name_ask' });
    expect(JSON.stringify(decision)).not.toContain('416');
  });

  it('does not ask twice, and does not ask someone already named', () => {
    expect(decideParentCallName({ ...open, alreadyAsked: true, googleGivenName: 'Bea' }).kind).toBe(
      'none',
    );
    expect(decideParentCallName({ ...open, needsName: false, googleGivenName: 'Bea' }).kind).toBe(
      'none',
    );
  });

  it('never asks in the door greeting', () => {
    const door = `${greeting(null, 'en')}\n${COLD_START_ASK}`;
    expect(door).not.toMatch(/call you/i);
  });
});

describe('handleParentCallNameReply', () => {
  async function seedConfirm(googleName: string) {
    const fake = makeFakeDb();
    await fake.db.insert(schema.users).values({
      id: USER_B,
      name: null,
      googleGivenName: 'Other',
    });
    await fake.db.insert(schema.users).values({
      id: USER_A,
      name: null,
      googleGivenName: googleName,
    });
    await fake.db.insert(schema.channelMessages).values({
      familyId: FAMILY_A,
      parentUserId: USER_A,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: 'parent_name_confirm',
      status: 'queued',
      sentAt: new Date('2026-09-22T15:00:00.000Z'),
    });
    return fake;
  }

  it('yes keeps the held name and leaves the other family alone', async () => {
    const fake = await seedConfirm('Bea');
    const voice = voiceReading({ nameConfirmed: true });
    const outcome = await handleParentCallNameReply(
      fake.db,
      { familyId: FAMILY_A, parentUserId: USER_A, body: 'yes' },
      voice,
    );
    expect(outcome).toEqual({ status: 'answered', reply: 'MODEL REPLY' });
    expect(voice.calls).toEqual([{ body: 'yes', heldName: 'Bea' }]);
    const a = fake.rows(schema.users).find((row) => row.id === USER_A);
    const b = fake.rows(schema.users).find((row) => row.id === USER_B);
    expect(a).toMatchObject({ name: 'Bea', googleGivenName: null });
    expect(b).toMatchObject({ name: null, googleGivenName: 'Other' });
  });

  it('no clears the held name; the model’s reply is what asks what to call them', async () => {
    const fake = await seedConfirm('Bea');
    const outcome = await handleParentCallNameReply(
      fake.db,
      { familyId: FAMILY_A, parentUserId: USER_A, body: 'no' },
      voiceReading({ nameConfirmed: false }),
    );
    expect(outcome).toEqual({ status: 'answered', reply: 'MODEL REPLY' });
    const a = fake.rows(schema.users).find((row) => row.id === USER_A);
    expect(a).toMatchObject({ name: null, googleGivenName: null });
    expect(fake.rows(schema.users).find((row) => row.id === USER_B)?.googleGivenName).toBe('Other');
  });

  it('a preference stores that name, not the Google one', async () => {
    const fake = await seedConfirm('Bea');
    const outcome = await handleParentCallNameReply(
      fake.db,
      { familyId: FAMILY_A, parentUserId: USER_A, body: 'call me Robin' },
      voiceReading({ parentName: 'Robin' }),
    );
    expect(outcome).toEqual({ status: 'answered', reply: 'MODEL REPLY' });
    expect(fake.rows(schema.users).find((row) => row.id === USER_A)).toMatchObject({
      name: 'Robin',
      googleGivenName: null,
    });
  });

  it('shape-checks what the model read as a name: a phone is never stored', async () => {
    const fake = await seedConfirm('Bea');
    const outcome = await handleParentCallNameReply(
      fake.db,
      { familyId: FAMILY_A, parentUserId: USER_A, body: PHONE },
      voiceReading({ parentName: PHONE }),
    );
    expect(outcome).toEqual({ status: 'declined' });
    expect(fake.rows(schema.users).find((row) => row.id === USER_A)).toMatchObject({
      name: null,
      googleGivenName: 'Bea',
    });
  });

  it('a failed compose stores the yes and reports a null reply — nothing canned goes out', async () => {
    const fake = await seedConfirm('Bea');
    const outcome = await handleParentCallNameReply(
      fake.db,
      { familyId: FAMILY_A, parentUserId: USER_A, body: 'yes' },
      voiceReading({ nameConfirmed: true, reply: null }),
    );
    expect(outcome).toEqual({ status: 'answered', reply: null });
    expect(fake.rows(schema.users).find((row) => row.id === USER_A)?.name).toBe('Bea');
  });

  it('stores the soft parent-role guess the model offered, marked as a guess', async () => {
    const fake = await seedConfirm('Bea');
    await handleParentCallNameReply(
      fake.db,
      { familyId: FAMILY_A, parentUserId: USER_A, body: "yes, I'm their mum" },
      voiceReading({ nameConfirmed: true, parentRole: { role: 'mother', basis: 'stated' } }),
    );
    expect(fake.rows(schema.users).find((row) => row.id === USER_A)).toMatchObject({
      parentRole: 'mother',
      parentRoleBasis: 'stated',
    });
  });

  it('does not claim the open ask, so a later no is not asked again from here', async () => {
    const fake = makeFakeDb();
    await fake.db.insert(schema.users).values({ id: USER_A, name: null, googleGivenName: null });
    await fake.db.insert(schema.channelMessages).values({
      familyId: FAMILY_A,
      parentUserId: USER_A,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: 'parent_name_ask',
      status: 'delivered',
      sentAt: new Date('2026-09-22T15:00:00.000Z'),
    });
    const voice = voiceReading({});
    const outcome = await handleParentCallNameReply(
      fake.db,
      { familyId: FAMILY_A, parentUserId: USER_A, body: 'no' },
      voice,
    );
    expect(outcome).toEqual({ status: 'declined' });
    expect(voice.calls).toEqual([]);
  });
});

describe('holdGoogleGivenName', () => {
  it('refuses a phone and does not write it', async () => {
    const fake = makeFakeDb();
    await fake.db.insert(schema.users).values({ id: USER_A, name: null, googleGivenName: null });
    const held = await holdGoogleGivenName(fake.db, {
      familyId: FAMILY_A,
      userId: USER_A,
      givenName: PHONE,
    });
    expect(held).toBe('refused');
    expect(fake.rows(schema.users)[0]?.googleGivenName).toBeNull();
    expect(fake.rows(schema.users)[0]?.name).toBeNull();
  });
});
