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
