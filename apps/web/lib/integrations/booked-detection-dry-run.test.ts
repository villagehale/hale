import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { falseBookingSignal } from '~/lib/sentinel/booking-guard';
import { type DryRunEnvelope, runBookedDetectionDryRun } from './booked-detection-dry-run';

/**
 * The dry-run calls the real classifier with the skills off disk. Only the model's
 * two answers are scripted (rule #8) — what is under test is that a scripted
 * `booking_confirmation` still comes back refused when the envelope says it is not
 * a held place, and that the runner has no database to write.
 */

const FIXTURE = fileURLToPath(
  new URL('../../scripts/fixtures/booked-detection/envelopes.json', import.meta.url),
);

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null };

function scriptedBookingClient(): AgentClient {
  const create = vi.fn().mockImplementation(async (params: { tools?: Array<{ name: string }> }) => {
    const toolName = params.tools?.[0]?.name;
    if (toolName === 'triage') {
      return {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'triage',
            input: { child_related: true, confidence: 0.9, rationale: 'fixture' },
          },
        ],
        usage,
      };
    }
    return {
      content: [
        {
          type: 'tool_use',
          id: 'e1',
          name: 'extraction',
          input: {
            kind: 'booking_confirmation',
            event: {
              title: 'Tadpole Swim',
              child_ref: null,
              original_time: null,
              new_time: '2026-10-04T13:00:00.000Z',
              location: 'the Northwind Pool',
            },
            source_confidence: 0.92,
            quote_evidence: 'scripted',
            teen_content: false,
          },
        },
      ],
      usage,
    };
  });
  return { messages: { create } } as unknown as AgentClient;
}

function loadFixtures(): DryRunEnvelope[] {
  const parsed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { emails: DryRunEnvelope[] };
  return parsed.emails;
}

describe('booked-detection dry-run fixtures', () => {
  const emails = loadFixtures();

  it('covers the synthetic set and contains no real mailbox', () => {
    expect(emails.map((email) => email.id)).toEqual([
      'class-receipt',
      'resent-receipt',
      'waitlist',
      'adult-ticket',
      'airline-booking',
      'restaurant-booking',
      'registration-opens',
      'session-reminder',
      'cancellation',
    ]);
    const blob = JSON.stringify(emails);
    expect(blob).not.toMatch(/gmail\.com|yahoo\.|icloud\.com|hotmail\./);
    expect(blob).not.toMatch(/\+1\d{10}/);
    for (const email of emails) {
      expect(email.sender).toMatch(/\.example>?$/);
    }
  });

  it('names the guard on the envelopes that are not a held place', () => {
    const guardOf = (id: string) => {
      const email = emails.find((row) => row.id === id);
      if (!email) throw new Error(`missing ${id}`);
      return falseBookingSignal({ subject: email.subject, snippet: email.snippet });
    };
    expect(guardOf('class-receipt')).toBeNull();
    expect(guardOf('resent-receipt')).toBeNull();
    expect(guardOf('waitlist')).toBe('waitlist');
    expect(guardOf('registration-opens')).toBe('registration_opens');
    expect(guardOf('session-reminder')).toBe('reminder_only');
    expect(guardOf('adult-ticket')).toBeNull();
    expect(guardOf('airline-booking')).toBeNull();
    expect(guardOf('restaurant-booking')).toBeNull();
    expect(guardOf('cancellation')).toBeNull();
  });

  it('runs the real classifier and refuses a scripted confirmation the envelope contradicts', async () => {
    const verdicts = await runBookedDetectionDryRun(emails, { client: scriptedBookingClient() });
    const byId = Object.fromEntries(verdicts.map((row) => [row.id, row]));

    expect(byId['class-receipt']).toMatchObject({
      kind: 'booking_confirmation',
      guard: null,
      wouldRecordBooking: true,
      bookingRefusal: null,
    });
    expect(byId['resent-receipt']).toMatchObject({
      kind: 'booking_confirmation',
      wouldRecordBooking: true,
    });
    expect(byId.waitlist).toMatchObject({
      kind: 'reminder_only',
      guard: 'waitlist',
      wouldRecordBooking: false,
      bookingRefusal: 'not_a_booking',
    });
    expect(byId['registration-opens']).toMatchObject({
      kind: 'reminder_only',
      guard: 'registration_opens',
      wouldRecordBooking: false,
    });
    expect(byId['session-reminder']).toMatchObject({
      kind: 'reminder_only',
      guard: 'reminder_only',
      wouldRecordBooking: false,
    });
  });
});
