import { describe, expect, it } from 'vitest';
import {
  FRIEND_MARKS_FIXTURES,
  friendMarksMisses,
  knownSeamMiss,
} from './friend-marks-fixtures.mjs';

const join = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'coparent-yes-join');
const zh = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'email-question-zh');
const fr = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'email-question-fr');

const map = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'find-show-two-groups');

describe('friendMarksMisses', () => {
  it('passes a map with a kept bubble per group, and fails one with a group dropped', () => {
    expect(friendMarksMisses(map, {}, { keptGroupBubbles: 2 })).toEqual([]);
    expect(friendMarksMisses(map, {}, { keptGroupBubbles: 1 })).toEqual(['groupBubbles:1']);
    expect(friendMarksMisses(map, {})).toEqual(['groupBubbles:0']);
  });

  it('passes a co-parent yes that points below', () => {
    expect(
      friendMarksMisses(join, { asks: false, parentQuestion: false, joinPointer: 'below' }),
    ).toEqual([]);
  });

  it('fails when the pointer the send depends on is omitted', () => {
    expect(friendMarksMisses(join, { asks: false, parentQuestion: false })).toEqual([
      'joinPointer:omitted',
      'joinPointer:null',
    ]);
  });

  it('fails a pointer that is not below, and a value outside the enum', () => {
    expect(
      friendMarksMisses(join, { asks: false, parentQuestion: false, joinPointer: 'missing' }),
    ).toEqual(['joinPointer:"missing"']);
    expect(
      friendMarksMisses(join, { asks: false, parentQuestion: false, joinPointer: 'under' }),
    ).toEqual(['joinPointer:omitted', 'joinPointer:"under"']);
  });

  it('fails a question read as agreement, and an omitted asks', () => {
    expect(
      friendMarksMisses(zh, { asks: true, parentQuestion: true, connectorsOffered: ['gmail'] }),
    ).toEqual([]);
    expect(friendMarksMisses(zh, { parentQuestion: false, connectorsOffered: ['gmail'] })).toEqual([
      'asks:omitted',
      'parentQuestion:false',
    ]);
  });

  it('fails a question turned into a yes the code would keep, or not read as a question', () => {
    const marks = { asks: true, connectorsOffered: ['gmail'] };
    expect(friendMarksMisses(fr, { ...marks, parentQuestion: true, connectGmail: null })).toEqual(
      [],
    );
    expect(friendMarksMisses(fr, { ...marks, parentQuestion: true, connectGmail: true })).toEqual(
      [],
    );
    expect(friendMarksMisses(fr, { ...marks, parentQuestion: false, connectGmail: null })).toEqual([
      'parentQuestion:false',
    ]);
    expect(friendMarksMisses(fr, { ...marks, parentQuestion: false, connectGmail: true })).toEqual([
      'connectGmail:yes_kept',
      'parentQuestion:false',
    ]);
    // The English question with no question mark is held to the same.
    const bare = FRIEND_MARKS_FIXTURES.find(
      (fixture) => fixture.id === 'email-question-en-no-mark',
    );
    expect(
      friendMarksMisses(bare, { ...marks, parentQuestion: false, connectGmail: true }),
    ).toEqual(['connectGmail:yes_kept', 'parentQuestion:false']);
  });

  it('fails a Gmail pitch on a turn that answers their own other question', () => {
    const own = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'ages-own-question');
    const marks = { asks: true, parentQuestion: true };
    expect(friendMarksMisses(own, { ...marks, connectorsOffered: [] })).toEqual([]);
    expect(friendMarksMisses(own, { ...marks, connectorsOffered: ['gmail'] })).toEqual([
      'connectorsOffered:["gmail"]',
    ]);
  });

  it('fails a declined place whose reply code would not send', () => {
    const declined = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'place-declined-fr');
    const value = { asks: true, reply: 'Pas de souci. Tes enfants ont quel âge?' };
    expect(friendMarksMisses(declined, value, { judged: { ok: true } })).toEqual([]);
    expect(
      friendMarksMisses(declined, value, { judged: { ok: false, reason: 'question' } }),
    ).toEqual(['reply:unsendable:question']);
    expect(friendMarksMisses(declined, value)).toEqual(['reply:unsendable:not_judged']);
    expect(
      friendMarksMisses(declined, { ...value, postalCode: 'Z9Z' }, { judged: { ok: true } }),
    ).toEqual(['postalCode:"Z9Z"']);
  });

  // VIL-641: a declined place is graded on meaning, and the first no keeps the place open.
  it('fails a declined place the judge scores low, one never judged, and a first no taken as final', () => {
    const first = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'place-decline-1-en-us');
    const second = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'place-decline-2-fr');
    const ok = { judged: { ok: true }, meaning: { score: 5, reason: 'fine' } };
    const value = {
      asks: true,
      placeAsk: 'coarse',
      reply: 'Totally fair. Just the five-digit ZIP?',
    };
    expect(friendMarksMisses(first, value, ok)).toEqual([]);
    expect(
      friendMarksMisses(first, value, { ...ok, meaning: { score: 2, reason: 'promised nearby' } }),
    ).toEqual(['meaning:2 (promised nearby)']);
    expect(friendMarksMisses(first, value, { judged: { ok: true } })).toEqual([
      'meaning:not_judged',
    ]);
    expect(friendMarksMisses(first, { ...value, placeDeclined: true }, ok)).toEqual([
      'placeDeclined:true',
    ]);
    const sent = { source: 'composed', placeDeclined: true };
    const moved = { asks: true, placeDeclined: true, reply: 'Pas de souci. Tes enfants?' };
    expect(friendMarksMisses(second, moved, { ...ok, sent })).toEqual([]);
    expect(friendMarksMisses(second, { ...moved, placeDeclined: false }, { ...ok, sent })).toEqual([
      'placeDeclined:false',
    ]);
  });

  // VIL-641 round 2: the first no's coarse ask is what code keeps, and the second no is
  // graded on what code sends, after its refusal and one rewrite.
  it('fails a first no whose coarse ask is not marked, and a second no code would not send', () => {
    const first = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'place-decline-1-en-ca');
    const second = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'place-decline-2-en-ca');
    const ok = { judged: { ok: true }, meaning: { score: 5, reason: 'fine' } };
    const asked = { asks: true, placeAsk: 'coarse', reply: 'Just the first three?' };
    expect(friendMarksMisses(first, asked, ok)).toEqual([]);
    expect(friendMarksMisses(first, { ...asked, placeAsk: 'full' }, ok)).toEqual([
      'placeAsk:"full"',
    ]);
    expect(friendMarksMisses(first, { ...asked, placeAsk: undefined }, ok)).toEqual([
      'placeAsk:omitted',
      'placeAsk:null',
    ]);

    expect(second.over.coarseCodeAsked).toBe(true);
    const draft = { asks: true, placeDeclined: true, reply: 'Even the first three?' };
    const sent = { source: 'retry', placeDeclined: true };
    expect(friendMarksMisses(second, draft, { ...ok, sent })).toEqual([]);
    expect(
      friendMarksMisses(second, draft, { ...ok, sent: { ...sent, source: 'unsent' } }),
    ).toEqual(['sent:unsent']);
    expect(
      friendMarksMisses(second, draft, { ...ok, sent: { ...sent, placeDeclined: false } }),
    ).toEqual(['sent:placeDeclined:false']);
    expect(friendMarksMisses(second, draft, ok)).toEqual(['sent:not_run']);
  });

  it('fails a calendar ask that offers Gmail under the calendar link', () => {
    const marks = { asks: true, parentQuestion: false };
    const calendar = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'calendar-yes');
    expect(friendMarksMisses(calendar, { ...marks, connectorsOffered: ['calendar'] })).toEqual([]);
    expect(
      friendMarksMisses(calendar, { ...marks, connectorsOffered: ['calendar', 'gmail'] }),
    ).toEqual(['connectorsOffered:["calendar","gmail"]']);
  });

  it("fails a reply not in the English parent's language, and a save with nothing saved", () => {
    const retry = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'coparent-carpool-retry');
    const turn = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'coparent-carpool');
    const honest = { asks: true, claimsSaved: false, reply: "That one isn't saved. Group chat?" };
    expect(friendMarksMisses(retry, honest)).toEqual([]);
    expect(
      friendMarksMisses(retry, { ...honest, reply: 'Bien noté, ta demande est enregistrée.' }),
    ).toEqual(['reply:not_their_language']);
    expect(friendMarksMisses(retry, { ...honest, claimsSaved: true })).toEqual([
      'claimsSaved:true',
    ]);
    expect(friendMarksMisses(turn, { ...honest, claimsSaved: true })).toEqual([
      'claimsSaved:no_add',
    ]);
    expect(
      friendMarksMisses(turn, { ...honest, claimsSaved: true, scheduleAdds: [{ line: 1 }] }),
    ).toEqual([]);
  });

  it('fails the positive control when the yes was not saved or not said', () => {
    const saved = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'schedule-add-saved');
    const good = { asks: false, claimsSaved: true, scheduleAdds: [{ line: 1 }] };
    expect(friendMarksMisses(saved, good)).toEqual([]);
    expect(friendMarksMisses(saved, { ...good, scheduleAdds: [] })).toEqual(['scheduleAdds:0']);
    expect(friendMarksMisses(saved, { ...good, claimsSaved: false })).toEqual([
      'claimsSaved:false',
    ]);
  });
});

// VIL-645: only the exact tool-call XML leak is quarantined, and only where the fixture names it.
describe('knownSeamMiss', () => {
  const ownQuestion = FRIEND_MARKS_FIXTURES.find((fixture) => fixture.id === 'ages-own-question');
  const leaked = {
    asks: true,
    reply: 'Classes, lessons and story times near you. How old are Mia and Leo?',
    parentQuestion: 'true</parentQuestion>\n<parameter name="connectorsOffered">[]',
  };

  it('names the ticket for the leak and nothing else wrong', () => {
    const misses = friendMarksMisses(ownQuestion, leaked);
    expect(misses.length).toBeGreaterThan(0);
    expect(knownSeamMiss(ownQuestion, leaked, misses)).toBe('VIL-645');
  });

  it('still fails the leak when anything else is wrong too', () => {
    const { asks: _asks, ...noAsks } = leaked;
    const misses = friendMarksMisses(ownQuestion, noAsks);
    expect(misses).toContain('asks:omitted');
    expect(knownSeamMiss(ownQuestion, noAsks, misses)).toBeNull();
  });

  it('still fails a plain wrong answer, and the leak on a fixture that names no ticket', () => {
    const wrong = { ...leaked, parentQuestion: false, connectorsOffered: [] };
    expect(knownSeamMiss(ownQuestion, wrong, friendMarksMisses(ownQuestion, wrong))).toBeNull();
    expect(knownSeamMiss(fr, leaked, friendMarksMisses(fr, leaked))).toBeNull();
  });
});
