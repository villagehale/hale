import { describe, expect, it } from 'vitest';
import { inspectRegistrationPage } from './inspect';
import type { PageControl, PageSnapshot, SignupIdentity } from './types';

const ORIGIN = 'https://register.example.test';

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
    href: `${ORIGIN}/register`,
    controls,
    priceCents: [],
    captcha: false,
    confirmed: false,
    formText: '',
    waitingRoom: false,
    ...extra,
  };
}

const SESSION = control({
  name: 'session',
  type: 'select',
  label: 'Session',
  options: [
    { value: 'tue-1630', label: 'Tue 4:30', disabled: false },
    { value: 'wed-1000', label: 'Wed 10:00', disabled: false },
  ],
});

const SAFE = [
  control({ name: 'child_first_name', label: 'Child first name' }),
  control({ name: 'parent_email', type: 'email', label: 'Parent email' }),
  control({ name: 'postal_code', label: 'Postal code' }),
  SESSION,
];

function inspect(
  controls: PageControl[],
  extra: Partial<PageSnapshot> = {},
  sessionId = 'tue-1630',
) {
  return inspectRegistrationPage({
    snapshot: snapshot(controls, extra),
    identity: IDENTITY,
    sessionId,
    approvedPriceCents: null,
    expectedOrigin: ORIGIN,
  });
}

describe('inspectRegistrationPage', () => {
  it('fills only the required known fields and the authorized session', () => {
    const result = inspect([
      ...SAFE,
      control({ name: 'notes', label: 'Anything else?', required: false }),
    ]);
    expect(result.action).toBe('submit');
    if (result.action !== 'submit') return;
    expect(result.fills.map((fill) => fill.slot).sort()).toEqual([
      'child_first_name',
      'parent_email',
      'postal_code',
      'session',
    ]);
    expect(result.fills.find((fill) => fill.slot === 'session')?.value).toBe('tue-1630');
    expect(result.fills.some((fill) => fill.name === 'notes')).toBe(false);
  });

  it('stops on a card field and does not plan a submit', () => {
    const result = inspect([
      ...SAFE,
      control({ name: 'card_number', label: 'Card', autocomplete: 'cc-number' }),
    ]);
    expect(result).toEqual({ action: 'stop', reason: 'payment', prefilled: [] });
  });

  it('stops on captcha', () => {
    expect(inspect(SAFE, { captcha: true })).toMatchObject({ action: 'stop', reason: 'captcha' });
  });

  it('stops on a password field', () => {
    const result = inspect([
      control({ name: 'username', label: 'Email', required: true }),
      control({ name: 'password', type: 'password', label: 'Password' }),
    ]);
    expect(result).toMatchObject({ action: 'stop', reason: 'login_wall' });
  });

  it('stops when the authorized session is disabled', () => {
    const result = inspect([
      control({
        name: 'session',
        type: 'select',
        label: 'Session',
        options: [{ value: 'tue-1630', label: 'Tue 4:30', disabled: true }],
      }),
    ]);
    expect(result).toMatchObject({ action: 'stop', reason: 'session_full' });
  });

  it('stops when a required field is not one Hale knows', () => {
    const result = inspect([
      ...SAFE,
      control({ name: 'emergency_contact', label: 'Emergency contact phone' }),
    ]);
    expect(result).toMatchObject({ action: 'stop', reason: 'unexpected_field' });
  });

  it('stops when the page shows a price the parent has not approved', () => {
    const result = inspect(SAFE, { priceCents: [2500] });
    expect(result).toMatchObject({ action: 'stop', reason: 'price_not_approved' });
  });

  it('stops when the page price differs from the price the parent approved', () => {
    const result = inspectRegistrationPage({
      snapshot: snapshot(SAFE, { priceCents: [2400] }),
      identity: IDENTITY,
      sessionId: 'tue-1630',
      approvedPriceCents: 1800,
      expectedOrigin: ORIGIN,
    });
    expect(result).toMatchObject({ action: 'stop', reason: 'price_change' });
  });

  it('stops on a verification code', () => {
    const result = inspect([
      ...SAFE,
      control({ name: 'otp', label: 'Verification code', autocomplete: 'one-time-code' }),
    ]);
    expect(result).toMatchObject({ action: 'stop', reason: 'login_wall' });
  });

  it('stops when the authorized session is sold out', () => {
    const result = inspect([
      control({
        name: 'session',
        type: 'select',
        label: 'Session',
        options: [{ value: 'tue-1630', label: 'Tue 4:30 sold out', disabled: false }],
      }),
    ]);
    expect(result).toMatchObject({ action: 'stop', reason: 'session_full' });
  });

  it('fills a ticket or a reservation from the adult name and the time, not a child field', () => {
    const ticket = inspect(
      [
        control({ name: 'guest_name', label: 'Your name' }),
        control({ name: 'email', type: 'email', label: 'Email' }),
        control({
          name: 'showtime',
          type: 'select',
          label: 'Showtime',
          options: [{ value: 'sat-1100', label: 'Sat 11:00', disabled: false }],
        }),
      ],
      {},
      'sat-1100',
    );
    expect(ticket.action).toBe('submit');
    if (ticket.action !== 'submit') return;
    expect(ticket.fills.find((fill) => fill.slot === 'parent_first_name')?.value).toBe('Ana');
    expect(ticket.fills.some((fill) => fill.slot === 'child_first_name')).toBe(false);

    const table = inspect(
      [
        control({ name: 'reservation_name', label: 'Name' }),
        control({ name: 'email', type: 'email', label: 'Email' }),
        control({
          name: 'reservation_time',
          type: 'select',
          label: 'Reservation time',
          options: [{ value: 'fri-1900', label: 'Fri 7:00', disabled: false }],
        }),
      ],
      {},
      'fri-1900',
    );
    expect(table.action).toBe('submit');
    if (table.action !== 'submit') return;
    expect(table.fills.map((fill) => fill.value).sort()).toEqual(
      ['Ana', 'ana@example.test', 'fri-1900'].sort(),
    );
  });

  it('stops when a required known field has no family value', () => {
    const result = inspectRegistrationPage({
      snapshot: snapshot(SAFE),
      identity: { ...IDENTITY, childFirstName: null },
      sessionId: 'tue-1630',
      approvedPriceCents: null,
      expectedOrigin: ORIGIN,
    });
    expect(result).toMatchObject({ action: 'stop', reason: 'missing_detail' });
  });

  it('stops on a waiver, a medical form, an allergy form, or a waiting room', () => {
    expect(inspect(SAFE, { formText: 'Please sign the waiver' })).toMatchObject({
      action: 'stop',
      reason: 'waiver',
    });
    expect(inspect(SAFE, { formText: 'List any medication or medical conditions' })).toMatchObject({
      action: 'stop',
      reason: 'medical',
    });
    expect(
      inspect([...SAFE, control({ name: 'allergy_notes', label: 'Allergies', required: false })]),
    ).toMatchObject({ action: 'stop', reason: 'allergy' });
    expect(inspect(SAFE, { waitingRoom: true })).toMatchObject({
      action: 'stop',
      reason: 'waiting_room',
    });
  });

  it('stops when the page left the registration origin', () => {
    const result = inspect(SAFE, { href: 'https://login.example.test/signin' });
    expect(result).toMatchObject({ action: 'stop', reason: 'redirect' });
  });
});
