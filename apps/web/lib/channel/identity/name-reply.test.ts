import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import {
  type NameCaptureDeps,
  type NameCaptureWrite,
  handleNameCaptureReply,
  soleGivenName,
} from './name-reply';

const DB = {} as Database;
const NOW = new Date('2026-08-13T15:00:00Z');
const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';

describe('soleGivenName', () => {
  it.each([
    ['Sam', 'Sam'],
    ['sam', 'sam'],
    ['Sam Lee', 'Sam Lee'],
    ['  Dana  ', 'Dana'],
    ['Zoé', 'Zoé'],
    ["O'Brien", "O'Brien"],
    ['Anne-Marie', 'Anne-Marie'],
    ['Ng', 'Ng'],
  ])('reads %s as a name', (body, expected) => {
    expect(soleGivenName(body)).toBe(expected);
  });

  /** The commonest way anybody answers this question is not a bare name. Each lead-in is
   * stripped, and only when something is left behind to BE the name. */
  it.each([
    ["I'm Sam", 'Sam'],
    ['im sam', 'sam'],
    ['My name is Dana Okafor', 'Dana Okafor'],
    ['call me Bea', 'Bea'],
    ['this is Priya', 'Priya'],
    ["it's Tom", 'Tom'],
    ['just Sam', 'Sam'],
  ])('strips the lead-in on %s', (body, expected) => {
    expect(soleGivenName(body)).toBe(expected);
  });

  /**
   * The expensive direction. A false ACCEPT writes a wrong name into every message Hale
   * sends afterwards, so an ordinary reply that happens to be one word must never be read
   * as one. Everything refused here still reaches the coach, which can read it properly.
   */
  it.each([
    ['yes'],
    ['ok'],
    ['thanks'],
    ['sure'],
    ['no'],
    ['hey'],
    ['maybe'],
    ['nevermind'],
    ['sorry'],
  ])('refuses the ordinary reply %s', (body) => {
    expect(soleGivenName(body)).toBeNull();
  });

  it.each([
    ['a sentence about something else entirely that goes on', 'too many words'],
    ['sam@example.com', 'an address'],
    ['Sam 2', 'a digit'],
    ['see https://x.com', 'a link'],
    ['', 'nothing'],
    ['   ', 'whitespace'],
    ['Maya is 4 and Leo is 1', 'a whole answer'],
    ['bedtime, honestly. it takes two hours', 'a real reply to a real question'],
  ])('refuses %s (%s)', (body) => {
    expect(soleGivenName(body)).toBeNull();
  });

  it('refuses a name longer than anything Hale would put in a greeting', () => {
    expect(soleGivenName('Bartholomewmaximilianalexander'.repeat(2))).toBeNull();
  });

  /** STOP is a legal instruction answered upstream; reading it again here could only ever
   * disagree with the first answer — and would name somebody Stop. */
  it.each(['STOP', 'HELP', 'START', 'stop'])('never claims the carrier keyword %s', (body) => {
    expect(soleGivenName(body)).toBeNull();
  });
});

describe('handleNameCaptureReply', () => {
  function deps(overrides: Partial<NameCaptureDeps> & { write?: NameCaptureWrite } = {}) {
    const captured: string[] = [];
    const said: string[] = [];
    const base: NameCaptureDeps = {
      wasAsked: async () => true,
      capture: async (_db, input) => {
        captured.push(input.name);
        return overrides.write ?? 'stored';
      },
      read: async ({ parentWords }) => {
        said.push(parentWords);
        const name = parentWords.replace(/^I'm /, '');
        return { parentName: name, nameDeclined: false, reply: 'MODEL RECEIPT' };
      },
    };
    return { deps: { ...base, ...overrides } as NameCaptureDeps, captured, said };
  }

  const turn = (body: string) => ({ familyId: FAMILY, parentUserId: PARENT, body, now: NOW });

  it('stores the name and hands the model the name and the parent words for the receipt', async () => {
    const { deps: d, captured, said } = deps();

    const outcome = await handleNameCaptureReply(DB, turn("I'm Dana"), d);

    expect(captured).toEqual(['Dana']);
    expect(outcome).toEqual({ status: 'captured', reply: 'MODEL RECEIPT' });
    expect(said).toEqual(["I'm Dana"]);
  });

  it('stores nothing when the model leaves parentName empty', async () => {
    const { deps: d, captured } = deps({
      read: async () => ({
        parentName: null,
        nameDeclined: true,
        reply: 'What should I call you?',
      }),
    });

    const outcome = await handleNameCaptureReply(DB, turn('undo'), d);

    expect(captured).toEqual([]);
    expect(outcome).toEqual({ status: 'taken_back', reply: 'What should I call you?' });
  });

  it('does not store a name the model copied from a take-back', async () => {
    const { deps: d, captured } = deps({
      read: async () => ({
        parentName: 'undo',
        nameDeclined: true,
        reply: 'What should I call you?',
      }),
    });

    const outcome = await handleNameCaptureReply(DB, turn('undo'), d);

    expect(captured).toEqual([]);
    expect(outcome.status).toBe('taken_back');
  });

  it('still stores the name the model returned when the reply could not be written', async () => {
    const { deps: d, captured } = deps({
      read: async () => ({ parentName: 'Dana', nameDeclined: false, reply: null }),
    });

    const outcome = await handleNameCaptureReply(DB, turn("I'm Dana"), d);

    expect(captured).toEqual(['Dana']);
    expect(outcome).toEqual({ status: 'captured', reply: null });
  });

  it('falls through when Hale never asked this family for a name', async () => {
    const { deps: d, captured } = deps({ wasAsked: async () => false });

    expect(await handleNameCaptureReply(DB, turn('Dana'), d)).toEqual({
      status: 'declined_to_claim',
    });
    // Nothing was written on the strength of a word nobody asked for.
    expect(captured).toEqual([]);
  });

  it('does not call the model when Hale never asked, and stores nothing when the model names nobody', async () => {
    let reads = 0;
    const unasked = deps({
      wasAsked: async () => false,
      read: async () => {
        reads += 1;
        return { parentName: 'Dana', nameDeclined: false, reply: 'x' };
      },
    });
    await handleNameCaptureReply(DB, turn('Dana'), unasked.deps);
    expect(reads).toBe(0);
    expect(unasked.captured).toEqual([]);

    const unnamed = deps({
      read: async () => ({ parentName: null, nameDeclined: false, reply: null }),
    });
    await handleNameCaptureReply(DB, turn('what time is the storytime on saturday'), unnamed.deps);
    expect(unnamed.captured).toEqual([]);
  });

  /** A name already on file is somebody's considered answer, and a later text is not
   * evidence it was wrong. The turn is handed on rather than claimed. */
  it('never overwrites a name, and hands the turn to the coach when there is one', async () => {
    const { deps: d } = deps({ write: 'already_named' });

    expect(await handleNameCaptureReply(DB, turn('Sam'), d)).toEqual({
      status: 'declined_to_claim',
    });
  });
});
