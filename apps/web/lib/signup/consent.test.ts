import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SHAREABLE_SIGNUP_FIELDS,
  fieldListWiderThanTyped,
  fieldsPreparedToType,
  normalizeShareFields,
  signupProviderHost,
  typedOutsideGrant,
} from './consent';
import type { SignupIdentity } from './types';

const IDENTITY: SignupIdentity = {
  childFirstName: 'Ada',
  childLastName: null,
  childDob: '2023-09-29',
  parentFirstName: 'Test Parent',
  parentEmail: 'parent@example.test',
  postalCode: 'M5V2T6',
  teenager: false,
};

describe('signup field consent', () => {
  it('keeps the closed slot list aligned with the migration check', () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../packages/db/drizzle/0139_authorized_signup_consent.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    for (const field of SHAREABLE_SIGNUP_FIELDS) {
      expect(sql).toContain(`'${field}'`);
    }
    expect(normalizeShareFields(['phone', 'child_first_name'])).toBeNull();
    expect(normalizeShareFields(['child_first_name', 'child_first_name'])).toEqual([
      'child_first_name',
    ]);
  });

  it('treats a grant that lists an untyped slot as wider than the share', () => {
    expect(
      fieldListWiderThanTyped(
        ['child_first_name', 'parent_email', 'session'],
        ['child_first_name', 'parent_email'],
      ),
    ).toBe(true);
    expect(
      fieldListWiderThanTyped(
        ['child_first_name', 'parent_email'],
        ['child_first_name', 'parent_email'],
      ),
    ).toBe(false);
    expect(typedOutsideGrant(['parent_email', 'postal_code'], ['parent_email'])).toBe(true);
    expect(typedOutsideGrant(['parent_email'], ['parent_email', 'postal_code'])).toBe(false);
  });

  it('prepares only slots that already have a value, plus the session and its date', () => {
    expect(
      fieldsPreparedToType(IDENTITY, {
        startsAt: '2026-10-06T20:30:00.000Z',
        partySize: null,
        seatingNote: null,
      }),
    ).toEqual([
      'child_first_name',
      'child_dob',
      'parent_first_name',
      'parent_email',
      'postal_code',
      'session',
      'visit_date',
    ]);
    expect(signupProviderHost('WWW.Brampton.ca.')).toBe('www.brampton.ca');
    expect(signupProviderHost('[::1]')).toBe('::1');
  });
});
