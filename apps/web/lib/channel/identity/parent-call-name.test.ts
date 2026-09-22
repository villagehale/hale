import { schema } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { COLD_START_ASK, greeting } from '~/lib/channel/intake/copy';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { NAME_CAPTURED_REPLY } from '~/lib/channel/router/copy';
import {
  PARENT_CALL_NAME_ASK,
  decideParentCallName,
  handleParentCallNameReply,
  holdGoogleGivenName,
  parentCallNameConfirm,
  safeGivenName,
} from './parent-call-name';

const FAMILY_A = '11111111-1111-4111-8111-111111111111';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';
const PHONE = '+14165550100';

describe('decideParentCallName', () => {
  const open = {
    needsName: true,
    alreadyAsked: false,
    isWin: true,
    googleGivenName: null as string | null,
  };

  it('asks once after a win, and not before one', () => {
    expect(decideParentCallName(open)).toEqual({
      kind: 'ask',
      body: PARENT_CALL_NAME_ASK,
      templateKey: 'parent_name_ask',
    });
    expect(decideParentCallName({ ...open, isWin: false }).kind).toBe('none');
  });

  it('confirms a Google given name', () => {
    expect(decideParentCallName({ ...open, googleGivenName: 'Bea' })).toEqual({
      kind: 'confirm',
      body: parentCallNameConfirm('Bea'),
      templateKey: 'parent_name_confirm',
    });
  });

  it('falls open when the Google value is not GSM-7, and does not interpolate it', () => {
    // é is in GSM-7. ë is not, so "Zoë" is the name that must not be interpolated.
    const decision = decideParentCallName({ ...open, googleGivenName: 'Zoë' });
    expect(decision).toEqual({
      kind: 'ask',
      body: PARENT_CALL_NAME_ASK,
      templateKey: 'parent_name_ask',
    });
    expect(JSON.stringify(decision)).not.toContain('Zoë');
  });

  it('never invents a name from a phone number', () => {
    expect(safeGivenName(PHONE)).toBeNull();
    expect(safeGivenName('416-555-0100')).toBeNull();
    const decision = decideParentCallName({ ...open, googleGivenName: PHONE });
    expect(decision.kind).toBe('ask');
    if (decision.kind !== 'ask') return;
    expect(decision.body).toBe(PARENT_CALL_NAME_ASK);
    expect(decision.body).not.toContain('416');
    expect(decision.body).not.toContain(PHONE);
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
    expect(door).not.toContain(PARENT_CALL_NAME_ASK);
    expect(door).not.toContain('Can I call you');
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
    const outcome = await handleParentCallNameReply(fake.db, {
      familyId: FAMILY_A,
      parentUserId: USER_A,
      body: 'yes',
    });
    expect(outcome).toEqual({ status: 'answered', reply: NAME_CAPTURED_REPLY });
    const a = fake.rows(schema.users).find((row) => row.id === USER_A);
    const b = fake.rows(schema.users).find((row) => row.id === USER_B);
    expect(a).toMatchObject({ name: 'Bea', googleGivenName: null });
    expect(b).toMatchObject({ name: null, googleGivenName: 'Other' });
  });

  it('no clears the held name and asks what to call them', async () => {
    const fake = await seedConfirm('Bea');
    const outcome = await handleParentCallNameReply(fake.db, {
      familyId: FAMILY_A,
      parentUserId: USER_A,
      body: 'no',
    });
    expect(outcome).toEqual({
      status: 'answered',
      reply: PARENT_CALL_NAME_ASK,
      templateKey: 'parent_name_ask',
    });
    const a = fake.rows(schema.users).find((row) => row.id === USER_A);
    expect(a).toMatchObject({ name: null, googleGivenName: null });
    expect(fake.rows(schema.users).find((row) => row.id === USER_B)?.googleGivenName).toBe('Other');
  });

  it('a preference stores that name, not the Google one', async () => {
    const fake = await seedConfirm('Bea');
    const outcome = await handleParentCallNameReply(fake.db, {
      familyId: FAMILY_A,
      parentUserId: USER_A,
      body: 'call me Robin',
    });
    expect(outcome).toEqual({ status: 'answered', reply: NAME_CAPTURED_REPLY });
    expect(fake.rows(schema.users).find((row) => row.id === USER_A)).toMatchObject({
      name: 'Robin',
      googleGivenName: null,
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
    const outcome = await handleParentCallNameReply(fake.db, {
      familyId: FAMILY_A,
      parentUserId: USER_A,
      body: 'no',
    });
    expect(outcome).toEqual({ status: 'declined' });
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
