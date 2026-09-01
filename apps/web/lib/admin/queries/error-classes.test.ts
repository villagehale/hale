import { describe, expect, it } from 'vitest';
import type { AdminErrorRow } from './errors';
import { groupTwilioClasses } from './error-classes';

/**
 * The Twilio page → classes fold (pure). Rows arrive pre-scrubbed from the
 * service client; grouping is by code, label = first summary seen, and
 * sparkline is OFF — one API page is not day-complete.
 */
const rows: AdminErrorRow[] = [
  { at: '2026-08-10T12:00:00Z', source: 'twilio', code: '11200', summary: 'HTTP retrieval failure' },
  { at: '2026-08-12T09:00:00Z', source: 'twilio', code: '11200', summary: 'HTTP retrieval failure ([digits])' },
  { at: '2026-08-11T10:00:00Z', source: 'twilio', code: '30003', summary: 'Unreachable handset' },
];

describe('groupTwilioClasses', () => {
  it('groups by code with totals, freshest lastAt, and no sparkline', () => {
    expect(groupTwilioClasses(rows)).toEqual([
      {
        source: 'twilio',
        code: '11200',
        label: 'HTTP retrieval failure',
        total: 2,
        lastAt: '2026-08-12T09:00:00Z',
        days: [],
        sparkline: false,
      },
      {
        source: 'twilio',
        code: '30003',
        label: 'Unreachable handset',
        total: 1,
        lastAt: '2026-08-11T10:00:00Z',
        days: [],
        sparkline: false,
      },
    ]);
  });

  it('ignores non-twilio rows — the DB classes come from their own loader', () => {
    const mixed: AdminErrorRow[] = [
      ...rows,
      { at: '2026-08-12T10:00:00Z', source: 'message', code: '21211', summary: 'sms send failed' },
    ];
    expect(groupTwilioClasses(mixed)).toHaveLength(2);
  });
});
