import { describe, expect, it } from 'vitest';
import {
  type CarpoolReading,
  type CarpoolSender,
  applyCarpoolReading,
  carpoolPlanKey,
} from './carpool-apply';

const TZ = 'America/Toronto';
const NOW = new Date('2026-10-08T16:00:00.000Z');
const PICKUP_ISO = '2026-10-10T12:00:00.000Z';

function localClock(at: Date | null | undefined, timeZone: string): string {
  if (!at) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('weekday')} ${pick('hour')}:${pick('minute')}`;
}

const MAYA: CarpoolSender = {
  userId: 'user-maya',
  name: 'Maya',
  haleCustomer: true,
  timezone: TZ,
};

const PRIYA: CarpoolSender = {
  userId: null,
  name: 'Priya',
  haleCustomer: false,
  timezone: TZ,
};

function reading(overrides: Partial<CarpoolReading>): CarpoolReading {
  return {
    intent: 'chatter',
    driverName: null,
    eventLabel: null,
    pickupAtIso: null,
    pickupPlace: null,
    kids: null,
    confidence: 'high',
    ...overrides,
  };
}

describe('applyCarpoolReading', () => {
  it('records a driver who claimed the ride and schedules the night-before reminder', () => {
    const plan = applyCarpoolReading(
      null,
      reading({
        intent: 'driver_claim',
        driverName: 'Maya',
        driverIsSender: true,
        eventLabel: 'soccer',
        pickupAtIso: PICKUP_ISO,
        pickupPlace: 'the rec',
        kids: 'Noah and Lea',
      }),
      MAYA,
      NOW,
    );
    expect(plan).toMatchObject({
      status: 'assigned',
      driverName: 'Maya',
      driverUserId: 'user-maya',
      driverHaleCustomer: true,
      pickupPlace: 'the rec',
      kids: 'Noah and Lea',
      reminderStatus: 'pending',
    });
    expect(plan?.reminderFireAt).toBeInstanceOf(Date);
    expect(plan?.planKey).toBe(carpoolPlanKey('soccer', new Date(PICKUP_ISO), TZ));
  });

  it('swaps the driver mid-thread and re-aims the reminder', () => {
    const first = applyCarpoolReading(
      null,
      reading({
        intent: 'driver_claim',
        driverName: 'Maya',
        eventLabel: 'soccer',
        pickupAtIso: PICKUP_ISO,
      }),
      MAYA,
      NOW,
    );
    const swapped = applyCarpoolReading(
      first,
      reading({
        intent: 'driver_swap',
        driverName: 'Priya',
        eventLabel: 'soccer',
        pickupAtIso: PICKUP_ISO,
      }),
      PRIYA,
      NOW,
    );
    expect(swapped).toMatchObject({
      status: 'assigned',
      driverName: 'Priya',
      driverUserId: null,
      driverHaleCustomer: false,
      reminderStatus: 'pending',
    });
    expect(swapped?.reminderFireAt?.getTime()).toBe(first?.reminderFireAt?.getTime());
  });

  it('opens a plan with no driver and does not invent one', () => {
    const plan = applyCarpoolReading(
      null,
      reading({
        intent: 'plan_needs_driver',
        eventLabel: 'soccer',
        pickupAtIso: PICKUP_ISO,
        pickupPlace: 'the rec',
        kids: 'Noah',
      }),
      MAYA,
      NOW,
    );
    expect(plan).toMatchObject({
      status: 'open',
      driverName: null,
      reminderStatus: 'skipped_no_driver',
      reminderFireAt: null,
    });
  });

  it('cancels the plan so a later reminder cannot fire', () => {
    const first = applyCarpoolReading(
      null,
      reading({
        intent: 'driver_claim',
        driverName: 'Maya',
        eventLabel: 'soccer',
        pickupAtIso: PICKUP_ISO,
      }),
      MAYA,
      NOW,
    );
    const cancelled = applyCarpoolReading(
      first,
      reading({ intent: 'cancel', eventLabel: 'soccer' }),
      MAYA,
      NOW,
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      reminderStatus: 'skipped_cancelled',
      reminderFireAt: null,
    });
  });

  it('ignores low-confidence chatter so a guess cannot become the driver', () => {
    const plan = applyCarpoolReading(
      null,
      reading({
        intent: 'driver_claim',
        driverName: 'Someone',
        confidence: 'low',
      }),
      MAYA,
      NOW,
    );
    expect(plan).toBeNull();
  });

  it('does not assign a driver from a sender name unless they claimed the ride', () => {
    const plan = applyCarpoolReading(
      null,
      reading({
        intent: 'plan_needs_driver',
        eventLabel: 'soccer',
        pickupAtIso: PICKUP_ISO,
      }),
      MAYA,
      NOW,
    );
    expect(plan?.driverName).toBeNull();
  });

  it('VIL-520: tomorrow Saturday 8am is Saturday 08:00 Toronto, not Sunday 07:00', () => {
    // Friday 9pm EDT is Saturday 01:00 UTC. The reader attached Friday's EDT
    // offset to Sunday 8:00, and that instant renders as Sunday 07:00 EST.
    const skewed = '2026-11-01T08:00:00-04:00';
    const plan = applyCarpoolReading(
      null,
      reading({
        intent: 'driver_claim',
        driverName: 'Maya',
        driverIsSender: true,
        eventLabel: 'soccer',
        pickupDate: '2026-10-31',
        pickupTime: '08:00',
        pickupAtIso: skewed,
      }),
      MAYA,
      new Date('2026-10-31T01:00:00.000Z'),
    );
    expect(plan?.pickupAt?.toISOString()).toBe('2026-10-31T12:00:00.000Z');
    expect(localClock(plan?.pickupAt, TZ)).toBe('Saturday 08:00');
  });

  it('VIL-520: 8:00 on the Toronto fall-back Sunday stays 08:00, not the EDT hour', () => {
    const plan = applyCarpoolReading(
      null,
      reading({
        intent: 'plan_needs_driver',
        eventLabel: 'soccer',
        pickupDate: '2026-11-01',
        pickupTime: '08:00',
        pickupAtIso: '2026-11-01T08:00:00-04:00',
      }),
      MAYA,
      new Date('2026-10-31T01:00:00.000Z'),
    );
    expect(plan?.pickupAt?.toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(localClock(plan?.pickupAt, TZ)).toBe('Sunday 08:00');
  });

  it('Devin #975: a name matching the sender is not a self-claim on its own', () => {
    const plan = applyCarpoolReading(
      null,
      reading({
        intent: 'driver_claim',
        driverName: 'Maya',
        eventLabel: 'soccer',
        pickupAtIso: PICKUP_ISO,
      }),
      MAYA,
      NOW,
    );
    expect(plan).toMatchObject({
      driverName: 'Maya',
      driverUserId: null,
      driverHaleCustomer: false,
    });
  });
});

describe('date-only ride move (Devin #984)', () => {
  it('"soccer pickup moved to Sunday" keeps the Saturday 08:00 hour on Sunday', () => {
    const saturday = applyCarpoolReading(
      null,
      reading({
        intent: 'driver_claim',
        driverName: 'Maya',
        eventLabel: 'soccer',
        pickupDate: '2026-10-10',
        pickupTime: '08:00',
      }),
      MAYA,
      NOW,
    );
    expect(localClock(saturday?.pickupAt, TZ)).toBe('Saturday 08:00');

    const moved = applyCarpoolReading(
      saturday,
      reading({
        intent: 'plan_needs_driver',
        eventLabel: 'soccer',
        pickupDate: '2026-10-11',
        pickupTime: null,
      }),
      MAYA,
      NOW,
    );
    expect(localClock(moved?.pickupAt, TZ)).toBe('Sunday 08:00');
    expect(moved?.planKey).toBe(carpoolPlanKey('soccer', moved?.pickupAt ?? null, TZ));
  });

  it('keeps the known hour across a DST change (Sat EDT → Sun after fall-back)', () => {
    const saturday = applyCarpoolReading(
      null,
      reading({
        intent: 'driver_claim',
        driverName: 'Maya',
        eventLabel: 'soccer',
        pickupDate: '2026-10-31',
        pickupTime: '08:00',
      }),
      MAYA,
      NOW,
    );
    const moved = applyCarpoolReading(
      saturday,
      reading({ intent: 'plan_needs_driver', pickupDate: '2026-11-01', pickupTime: null }),
      MAYA,
      NOW,
    );
    expect(localClock(moved?.pickupAt, TZ)).toBe('Sunday 08:00');
  });

  it('a date with no hour and no known ride sets no instant', () => {
    const plan = applyCarpoolReading(
      null,
      reading({ intent: 'plan_needs_driver', eventLabel: 'soccer', pickupDate: '2026-10-11' }),
      MAYA,
      NOW,
    );
    expect(plan?.pickupAt ?? null).toBeNull();
  });
});
