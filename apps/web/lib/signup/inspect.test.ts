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

  it('stops when the page left the registration origin', () => {
    const result = inspect(SAFE, { href: 'https://login.example.test/signin' });
    expect(result).toMatchObject({ action: 'stop', reason: 'redirect' });
  });
});
