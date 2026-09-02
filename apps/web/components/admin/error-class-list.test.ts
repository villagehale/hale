import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ErrorClass } from '~/lib/admin/queries/error-classes';
import type { AdminErrorRow } from '~/lib/admin/queries/errors';
import { lastDays } from '~/lib/admin/window';
import { emptyLine, ErrorClassList, rowsForClass, visibleClasses, windowCount } from './error-class-list';

const [dayA, dayB] = lastDays(2);
if (!dayA || !dayB) throw new Error('lastDays returned too few keys');

const smsClass: ErrorClass = {
  source: 'message',
  code: '21211',
  label: 'sms send failed',
  total: 4,
  lastAt: '2026-08-30T12:00:00Z',
  days: [
    { day: '2020-01-01', count: 1 }, // outside every dial window
    { day: dayA, count: 1 },
    { day: dayB, count: 2 },
  ],
  sparkline: true,
};

const agentClass: ErrorClass = {
  source: 'agent',
  code: 'killed_cost',
  label: 'reviewer',
  total: 1,
  lastAt: '2026-08-31T09:00:00Z',
  days: [{ day: dayB, count: 1 }],
  sparkline: true,
};

const twilioClass: ErrorClass = {
  source: 'twilio',
  code: '11200',
  label: 'HTTP retrieval failure',
  total: 7,
  lastAt: '2026-08-29T08:00:00Z',
  days: [],
  sparkline: false,
};

const rawRows: AdminErrorRow[] = [
  { at: '2026-08-30T12:00:00Z', source: 'message', code: '21211', summary: 'sms send failed · tpl_x' },
  { at: '2026-08-31T09:00:00Z', source: 'agent', code: 'killed_cost', summary: 'reviewer · claude-sonnet-5' },
  { at: '2026-08-29T08:00:00Z', source: 'twilio', code: '11200', summary: 'HTTP retrieval failure' },
  // Same code as the sms class but a different source — must never leak in.
  { at: '2026-08-28T08:00:00Z', source: 'twilio', code: '21211', summary: 'some twilio 21211' },
];

describe('windowCount', () => {
  it('sums only the dial window for day-complete classes', () => {
    expect(windowCount(smsClass, 7)).toBe(3);
  });

  it('lets a Twilio page total stand — there is no day series to slice', () => {
    expect(windowCount(twilioClass, 7)).toBe(7);
  });
});

describe('visibleClasses', () => {
  const classes = [smsClass, agentClass, twilioClass];

  it('ranks by window count by default', () => {
    expect(visibleClasses(classes, 7, 'count', '').map((v) => v.cls.code)).toEqual([
      '11200',
      '21211',
      'killed_cost',
    ]);
  });

  it('ranks by last-seen when toggled', () => {
    expect(visibleClasses(classes, 7, 'last', '').map((v) => v.cls.code)).toEqual([
      'killed_cost',
      '21211',
      '11200',
    ]);
  });

  it('filters over code AND label', () => {
    expect(visibleClasses(classes, 7, 'count', 'review').map((v) => v.cls.code)).toEqual([
      'killed_cost',
    ]);
    expect(visibleClasses(classes, 7, 'count', '212').map((v) => v.cls.code)).toEqual(['21211']);
  });

  it('drops classes whose window count is zero', () => {
    const stale: ErrorClass = { ...agentClass, days: [{ day: '2020-01-01', count: 5 }] };
    expect(visibleClasses([stale], 7, 'count', '')).toEqual([]);
  });
});

describe('rowsForClass — the drill-down shows that class only', () => {
  it('matches message rows by code + label prefix', () => {
    expect(rowsForClass(smsClass, rawRows).map((r) => r.at)).toEqual(['2026-08-30T12:00:00Z']);
  });

  it('matches agent rows by code + agent-name prefix', () => {
    expect(rowsForClass(agentClass, rawRows).map((r) => r.at)).toEqual(['2026-08-31T09:00:00Z']);
  });

  it('matches twilio rows by code, never another source with the same code', () => {
    expect(rowsForClass(twilioClass, rawRows).map((r) => r.code)).toEqual(['11200']);
  });
});

describe('emptyLine', () => {
  it('orients with the last failure when classes exist outside the window', () => {
    expect(emptyLine([smsClass])).toMatch(/^No failures in this window\. The last failure was /);
  });

  it('says so plainly when there is truly nothing on record', () => {
    expect(emptyLine([])).toBe('No failures on record.');
  });
});

describe('ErrorClassList render', () => {
  const html = renderToStaticMarkup(
    createElement(ErrorClassList, { classes: [smsClass, twilioClass], rawRows }),
  );

  it('renders a class row with code, label, sparkline and last-seen', () => {
    expect(html).toContain('21211');
    expect(html).toContain('sms send failed');
    expect(html).toContain('adm-spark');
    expect(html).toContain('adm-dot-fail');
  });

  it('renders the drill-down rows inside the class disclosure', () => {
    expect(html).toContain('tpl_x');
  });

  it('gives a Twilio class the honest no-spark caption instead of a fabricated line', () => {
    expect(html).toContain('spark unavailable — Twilio returns latest page only');
  });

  it('demotes the full raw table into a collapsed details section', () => {
    expect(html).toContain('All raw rows (latest 50 per source · 30d)');
  });
});
