import { describe, expect, it } from 'vitest';
import type { PageControl, PageSnapshot, SignupIdentity } from '../types';
import { planBookingStep } from './plan';

const ORIGIN = 'https://book.example-venue.test';

const IDENTITY: SignupIdentity = {
  childFirstName: 'Ada',
  childLastName: 'Lovelace',
  childDob: '2022-04-02',
  parentFirstName: 'Ana',
  parentEmail: 'ana@example.test',
  postalCode: 'M5V',
  teenager: false,
};

function control(partial: Partial<PageControl> & Pick<PageControl, 'name'>): PageControl {
  return {
    type: 'text',
    required: true,
    label: '',
    autocomplete: null,
    options: [],
    ...partial,
  };
}

function snapshot(controls: PageControl[], extra: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    href: `${ORIGIN}/book`,
    controls,
    priceCents: [],
    captcha: false,
    confirmed: false,
    formText: '',
    waitingRoom: false,
    ...extra,
  };
}

function plan(
  controls: PageControl[],
  extra: Partial<PageSnapshot> = {},
  over: Partial<Parameters<typeof planBookingStep>[0]> = {},
) {
  return planBookingStep({
    snapshot: snapshot(controls, extra),
    identity: IDENTITY,
    sessionId: 'sat-1100',
    sessionStartsAt: '2026-10-10T15:00:00.000Z',
    partySize: null,
    seatingNote: null,
    approvedPriceCents: null,
    expectedOrigin: ORIGIN,
    sessionSelected: false,
    ...over,
  });
}

describe('planBookingStep', () => {
  it('continues a ticket cart when the page only asks for the visit date', () => {
    const result = plan([
      control({
        name: 'visit_date',
        type: 'select',
        label: 'Visit date',
        options: [{ value: '2026-10-10', label: 'Sat Oct 10', disabled: false }],
      }),
    ]);
    expect(result.action).toBe('continue');
    if (result.action !== 'continue') return;
    expect(result.fills).toEqual([
      { name: 'visit_date', slot: 'visit_date', value: '2026-10-10', control: 'select' },
    ]);
  });

  it('submits a show time with the adult name and not the child', () => {
    const result = plan(
      [
        control({ name: 'guest_name', label: 'Ticket holder' }),
        control({ name: 'email', type: 'email', label: 'Email' }),
        control({
          name: 'showtime',
          type: 'select',
          label: 'Performance time',
          options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
        }),
      ],
      { priceCents: [1800] },
      { approvedPriceCents: 1800 },
    );
    expect(result.action).toBe('submit');
    if (result.action !== 'submit') return;
    expect(result.fills.map((fill) => fill.value).sort()).toEqual(
      ['Ana', 'ana@example.test', 'sat-1100'].sort(),
    );
    expect(result.fills.some((fill) => fill.slot === 'child_first_name')).toBe(false);
  });

  it('continues when the time slot page says continue', () => {
    const result = plan(
      [
        control({
          name: 'showtime',
          type: 'select',
          label: 'Showtime',
          options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
        }),
      ],
      { submitLabel: 'Continue', priceCents: [1800] },
      { approvedPriceCents: 1800 },
    );
    expect(result.action).toBe('continue');
  });

  it('submits a cart review only after the time slot was already chosen', () => {
    const review = plan(
      [],
      { priceCents: [1800] },
      { approvedPriceCents: 1800, sessionSelected: true },
    );
    expect(review).toMatchObject({ action: 'submit', fills: [] });
    const early = plan([], { priceCents: [1800] }, { approvedPriceCents: 1800 });
    expect(early).toMatchObject({ action: 'stop', reason: 'unexpected_field' });
  });

  it('fills a visit date and a timed entry on the same museum page', () => {
    const result = plan([
      control({
        name: 'entry_date',
        type: 'select',
        label: 'Entry date',
        options: [{ value: '2026-10-10', label: 'Sat Oct 10', disabled: false }],
      }),
      control({
        name: 'entry_time',
        type: 'select',
        label: 'Timed entry',
        options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
      }),
    ]);
    expect(result.action).toBe('submit');
    if (result.action !== 'submit') return;
    expect(result.fills.map((fill) => fill.slot).sort()).toEqual(['session', 'visit_date']);
  });

  it('stops a class whose only opening is the waitlist', () => {
    const result = plan(
      [
        control({ name: 'child_first_name', label: 'Child first name' }),
        control({
          name: 'session',
          type: 'select',
          label: 'Class time',
          options: [{ value: 'sat-1100', label: 'Sat 11:00 waitlist', disabled: false }],
        }),
      ],
      {},
      { sessionId: 'sat-1100' },
    );
    expect(result).toMatchObject({ action: 'stop', reason: 'session_full' });
  });

  it('stops a required waitlist checkbox', () => {
    const result = plan([
      control({ name: 'join_waitlist', type: 'checkbox', label: 'Join the waitlist' }),
    ]);
    expect(result).toMatchObject({ action: 'stop', reason: 'session_full' });
  });

  it('fills a reservation party size and seating note from the authorized session', () => {
    const result = plan(
      [
        control({ name: 'reservation_name', label: 'Name' }),
        control({ name: 'email', type: 'email', label: 'Email' }),
        control({
          name: 'party_size',
          type: 'select',
          label: 'Party size',
          options: [
            { value: '2', label: '2', disabled: false },
            { value: '4', label: '4', disabled: false },
          ],
        }),
        control({ name: 'seating_note', label: 'Seating note' }),
        control({
          name: 'reservation_time',
          type: 'select',
          label: 'Reservation time',
          options: [{ value: 'fri-1900', label: 'Fri 7:00', disabled: false }],
        }),
      ],
      {},
      { sessionId: 'fri-1900', partySize: 4, seatingNote: 'Window' },
    );
    expect(result.action).toBe('submit');
    if (result.action !== 'submit') return;
    expect(result.fills.find((fill) => fill.slot === 'party_size')?.value).toBe('4');
    expect(result.fills.find((fill) => fill.slot === 'seating_note')?.value).toBe('Window');
    expect(result.fills.some((fill) => fill.slot === 'child_first_name')).toBe(false);
  });

  it('does not invent a party size', () => {
    const result = plan(
      [
        control({
          name: 'party_size',
          type: 'select',
          label: 'Guest count',
          options: [{ value: '4', label: '4', disabled: false }],
        }),
        control({
          name: 'party_time',
          type: 'select',
          label: 'Party time',
          options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
        }),
      ],
      {},
      { sessionId: 'sat-1100' },
    );
    expect(result).toMatchObject({ action: 'stop', reason: 'missing_detail' });
  });

  it('does not type a seating note that mentions an allergy', () => {
    const result = plan(
      [
        control({ name: 'seating_note', label: 'Seating note' }),
        control({
          name: 'reservation_time',
          type: 'select',
          label: 'Reservation time',
          options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
        }),
      ],
      {},
      { sessionId: 'sat-1100', seatingNote: 'peanut allergy' },
    );
    expect(result).toMatchObject({ action: 'stop', reason: 'allergy' });
  });

  it('hands back when a required field is not one the adapters know', () => {
    const result = plan([
      control({ name: 'school_name', label: 'School name' }),
      control({
        name: 'session',
        type: 'select',
        label: 'Session',
        options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
      }),
    ]);
    expect(result).toMatchObject({ action: 'stop', reason: 'unexpected_field' });
  });

  it('books a haircut from the appointment time and the client name', () => {
    const result = plan([
      control({ name: 'client_name', label: 'Client name' }),
      control({
        name: 'appointment_time',
        type: 'select',
        label: 'Appointment time',
        options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
      }),
    ]);
    expect(result.action).toBe('submit');
    if (result.action !== 'submit') return;
    expect(result.fills.find((fill) => fill.slot === 'parent_first_name')?.value).toBe('Ana');
    expect(result.fills.find((fill) => fill.slot === 'session')?.value).toBe('sat-1100');
  });

  it('hands back a rush open or a resident check on any host', () => {
    const session = control({
      name: 'session',
      type: 'select',
      label: 'Session',
      options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
    });
    expect(plan([session], { formText: 'Registration opens at 7:00am.' })).toMatchObject({
      action: 'stop',
      reason: 'timed_open',
    });
    expect(plan([session], { formText: 'Resident ID verification is required.' })).toMatchObject({
      action: 'stop',
      reason: 'resident_verification',
    });
    expect(plan([session], { formText: 'You are in the queue.' })).toMatchObject({
      action: 'stop',
      reason: 'waiting_room',
    });
  });

  it('books a drop-in from the child name and the gym time', () => {
    const result = plan([
      control({ name: 'player_name', label: 'Player name' }),
      control({
        name: 'drop_in',
        type: 'select',
        label: 'Drop-in time',
        options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
      }),
    ]);
    expect(result.action).toBe('submit');
    if (result.action !== 'submit') return;
    expect(result.fills.find((fill) => fill.slot === 'child_first_name')?.value).toBe('Ada');
    expect(result.fills.find((fill) => fill.slot === 'session')?.value).toBe('sat-1100');
  });
});
