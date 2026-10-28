import { describe, expect, it } from 'vitest';
import {
  type ClashPerson,
  type ClashPlan,
  clashCalendar,
  findGroupClashes,
} from './group-conflict';
import {
  type GroupPickupClaimReading,
  PICKUP_OFFERS_MAX,
  type PickupCandidate,
  groupPickupClaimUserMessage,
  pickupCandidates,
  pickupClaimAction,
  pickupDecisionKey,
} from './group-pickup-claim';

/**
 * VIL-444 (T24) — the claim contract code owns: which plans a message may take, and what a
 * reading may change. Readings here are hand-written inputs to code, never stand-ins for
 * the model; the judged eval grades the real reader.
 */

const NOW = new Date('2026-09-25T18:00:00.000Z');
const AT_3 = new Date('2026-09-25T19:00:00.000Z');
const AT_330 = new Date('2026-09-25T19:30:00.000Z');
const AT_4 = new Date('2026-09-25T20:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const barton: ClashPerson = { id: 'barton', name: 'Barton', calendar: true };
const sam: ClashPerson = { id: 'sam', name: 'Sam', calendar: true };
const people = [barton, sam];
const where = { people, now: NOW, timeZone: 'America/Toronto', language: 'en' as const };

function plan(over: Partial<ClashPlan> & Pick<ClashPlan, 'key' | 'title'>): ClashPlan {
  return {
    start: AT_3,
    end: AT_330,
    holders: [],
    takerId: null,
    claimed: false,
    rows: [],
    ...over,
  };
}

const swim = plan({ key: 'swim', title: 'Maya swim pickup', holders: ['barton'] });
const daycare = plan({ key: 'daycare', title: 'Leo daycare pickup', holders: ['barton'] });

function reading(over: Partial<GroupPickupClaimReading>): GroupPickupClaimReading {
  return { intent: 'claim_pickup', pickupRefs: ['p1'], confidence: 'high', ...over };
}

describe('pickupCandidates', () => {
  it('offers every plan someone has to take, the ones an alert named first', () => {
    const piano = plan({
      key: 'piano',
      title: 'Ava piano',
      start: new Date(AT_3.getTime() + 2 * HOUR),
      end: new Date(AT_330.getTime() + 2 * HOUR),
      takerId: 'sam',
      claimed: true,
    });
    const plans = [
      piano,
      swim,
      daycare,
      plan({ key: 'started', title: 'Leo nap', start: NOW, end: AT_3, holders: ['sam'] }),
      plan({
        key: 'school',
        title: 'Maya school',
        start: new Date('2026-09-25T12:30:00.000Z'),
        end: new Date('2026-09-25T21:00:00.000Z'),
        holders: ['barton'],
      }),
      plan({
        key: 'far',
        title: 'Maya dentist',
        start: new Date(AT_3.getTime() + 15 * 24 * HOUR),
        end: new Date(AT_330.getTime() + 15 * 24 * HOUR),
        holders: ['sam'],
      }),
    ];
    const sent = findGroupClashes({ plans, busy: [], people, now: NOW });
    expect(sent).toHaveLength(1);

    const candidates = pickupCandidates({ ...where, plans, sent });

    expect(candidates.map((candidate) => candidate.offer)).toEqual([
      {
        ref: 'p1',
        title: 'Leo daycare pickup',
        day: 'Friday, September 25',
        start: '15:00',
        end: '15:30',
        has: 'Barton',
        inAlert: true,
        askedOf: null,
      },
      {
        ref: 'p2',
        title: 'Maya swim pickup',
        day: 'Friday, September 25',
        start: '15:00',
        end: '15:30',
        has: 'Barton',
        inAlert: true,
        askedOf: 'Sam',
      },
      {
        ref: 'p3',
        title: 'Ava piano',
        day: 'Friday, September 25',
        start: '17:00',
        end: '17:30',
        has: 'Sam',
        inAlert: false,
        askedOf: null,
      },
    ]);
    expect(candidates.map((candidate) => candidate.plan.key)).toEqual(['daycare', 'swim', 'piano']);
  });

  it('offers at most a fixed number of plans, soonest first', () => {
    const plans = Array.from({ length: PICKUP_OFFERS_MAX + 4 }, (_, index) =>
      plan({
        key: `k${String(index).padStart(2, '0')}`,
        title: `Leo pickup ${index}`,
        start: new Date(AT_3.getTime() + index * HOUR),
        end: new Date(AT_330.getTime() + index * HOUR),
        holders: ['barton'],
      }),
    );
    const candidates = pickupCandidates({ ...where, plans: [...plans].reverse(), sent: [] });
    expect(candidates).toHaveLength(PICKUP_OFFERS_MAX);
    expect(candidates[0]?.offer).toMatchObject({ ref: 'p1', title: 'Leo pickup 0' });
    expect(candidates.at(-1)?.offer.title).toBe(`Leo pickup ${PICKUP_OFFERS_MAX - 1}`);
  });

  it('never offers a private plan, so its title never reaches the reader', () => {
    const calendar = clashCalendar({
      blocks: [
        {
          integrationId: 'gcal-barton',
          eventId: 'swim',
          userId: 'barton',
          start: AT_3,
          end: AT_330,
          allDay: false,
          kidRelated: true,
          title: 'Maya swim pickup',
          status: 'confirmed',
        },
        {
          integrationId: 'gcal-barton',
          eventId: 'placed-allergist',
          userId: 'barton',
          start: AT_3,
          end: AT_4,
          allDay: false,
          kidRelated: true,
          title: 'Maya allergist',
          status: 'confirmed',
        },
      ],
      events: [
        {
          id: 'allergist',
          title: 'Maya allergist',
          start: AT_3,
          end: AT_4,
          private: true,
          owner: { kind: 'parent', userId: 'barton' },
          ownerSince: null,
          placedGoogleEventId: 'placed-allergist',
        },
      ],
      decided: () => ({ takerId: 'sam', at: NOW, claim: true }),
    });
    const candidates = pickupCandidates({ ...where, plans: calendar.plans, sent: [] });
    expect(candidates.map((candidate) => candidate.offer.title)).toEqual(['Maya swim pickup']);
    const message = groupPickupClaimUserMessage({
      text: "I'll do the allergist",
      senderName: 'Sam',
      pickups: candidates.map((candidate) => candidate.offer),
      recent: [],
    });
    expect(JSON.parse(message).pickups).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(message).pickups)).not.toMatch(/allergist/i);
  });
});

describe('pickupClaimAction', () => {
  const candidates: PickupCandidate[] = pickupCandidates({
    ...where,
    plans: [swim, daycare],
    sent: [],
  });

  it('takes a high-confidence claim or drop of plans that were offered', () => {
    expect(pickupClaimAction(reading({ pickupRefs: ['p2'] }), candidates)).toEqual({
      kind: 'claim',
      plans: [swim],
    });
    expect(
      pickupClaimAction(reading({ intent: 'drop_pickup', pickupRefs: ['p1', 'p1'] }), candidates),
    ).toEqual({ kind: 'drop', plans: [daycare] });
    expect(pickupClaimAction(reading({ pickupRefs: ['p1', 'p2'] }), candidates)?.plans).toEqual([
      daycare,
      swim,
    ]);
  });

  it('changes nothing for a failed read, a low one, chatter, unclear or no plan', () => {
    expect(pickupClaimAction(null, candidates)).toBeNull();
    expect(pickupClaimAction(reading({ confidence: 'low' }), candidates)).toBeNull();
    expect(pickupClaimAction(reading({ intent: 'chatter' }), candidates)).toBeNull();
    expect(pickupClaimAction(reading({ intent: 'unclear' }), candidates)).toBeNull();
    expect(pickupClaimAction(reading({ pickupRefs: [] }), candidates)).toBeNull();
  });

  it('sets the whole reading aside when it names a plan that was not offered', () => {
    expect(pickupClaimAction(reading({ pickupRefs: ['p1', 'p3'] }), candidates)).toBeNull();
    expect(pickupClaimAction(reading({ pickupRefs: ['swim'] }), candidates)).toBeNull();
  });
});

describe('pickupDecisionKey', () => {
  it('is the key the planner reads a who-takes decision back by', () => {
    const asked: Array<[string, string]> = [];
    const calendar = clashCalendar({
      blocks: [
        {
          integrationId: 'gcal-barton',
          eventId: 'swim',
          userId: 'barton',
          start: AT_3,
          end: AT_330,
          allDay: false,
          kidRelated: true,
          title: '  Maya   Swim Pickup ',
          status: 'confirmed',
        },
      ],
      events: [
        {
          id: 'piano',
          title: 'Leo Piano',
          start: AT_4,
          end: new Date(AT_4.getTime() + HOUR / 2),
          private: false,
          owner: null,
          ownerSince: null,
          placedGoogleEventId: null,
        },
      ],
      decided: (startIso, titleNorm) => {
        asked.push([startIso, titleNorm]);
        return null;
      },
    });
    expect(
      calendar.plans.map((row) => {
        const key = pickupDecisionKey(row);
        return [key.startIso, key.titleNorm];
      }),
    ).toEqual(asked);
    expect(asked).toEqual([
      [AT_4.toISOString(), 'leo piano'],
      [AT_3.toISOString(), 'maya swim pickup'],
    ]);
  });
});

describe('groupPickupClaimUserMessage', () => {
  it('hands the reader the text, the offers and at most six recent lines', () => {
    const offers = pickupCandidates({ ...where, plans: [swim], sent: [] }).map(
      (candidate) => candidate.offer,
    );
    const recent = Array.from({ length: 9 }, (_, index) => ({
      from: 'member' as const,
      text: `m${index}`,
    }));
    const payload = JSON.parse(
      groupPickupClaimUserMessage({ text: 'got it', senderName: 'Sam', pickups: offers, recent }),
    );
    expect(payload).toEqual({
      text: 'got it',
      senderName: 'Sam',
      pickups: offers,
      recent: recent.slice(-6),
    });
  });
});
