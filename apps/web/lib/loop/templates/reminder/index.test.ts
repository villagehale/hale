import { describe, expect, it } from 'vitest';
import type { LoopCategory, LoopMessage, RenderedContent } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { smsSegments } from '../weekly-plan/core';
import { loopTemplateRenderer } from '../registry';
import type { ReminderChild, ReminderEventView, ReminderPayload } from './payload';

/**
 * VIL-223 · D1 — the reminder per-channel renderers, exercised through the registry
 * seam (loopTemplateRenderer.render(message, channel, nameLevel)). Every expectation
 * derives from the copy spec + the privacy rules (teen age gate, sensitive gate, the
 * no-link-on-T-1h rule, the SMS segment budget), never from observed output.
 */

const EM_DASH = '—';
const TZ = 'America/Toronto';
const DEEP_LINK = 'https://app.villagehale.com/plan';
const UNSUB = 'https://app.villagehale.com/unsubscribe?u=user-1&t=daily_digest&sig=abc';

const maya: ReminderChild = { id: 'c-maya', name: 'Maya', dateOfBirth: '2019-03-10', gender: 'girl' };
// 2011 DOB is ~15y → deriveStage 'teenager' → forced generic at every level/channel.
const teen: ReminderChild = { id: 'c-teen', name: 'Sam', dateOfBirth: '2011-01-01', gender: 'boy' };

function ev(over: Partial<ReminderEventView> = {}): ReminderEventView {
  return { eventRef: 'e1', title: 'Swim class', startsAt: '2026-07-25T20:30:00Z', childId: null, ...over };
}

// 14:00Z = 10:00 EDT, 20:30Z = 4:30 EDT (America/Toronto, summer).
const apptAt10 = ev({ eventRef: 'e-appt', childId: 'c-teen', title: 'Therapy', startsAt: '2026-07-25T14:00:00Z' });
const swimAt430 = ev({ eventRef: 'e-swim', childId: 'c-maya', title: 'Swim class', startsAt: '2026-07-25T20:30:00Z' });

function payload(over: Partial<ReminderPayload> = {}): ReminderPayload {
  return {
    offset: '-P1D',
    timeZone: TZ,
    events: [],
    children: [maya, teen],
    deepLink: DEEP_LINK,
    unsubscribeUrl: UNSUB,
    ...over,
  };
}

function msg(p: ReminderPayload, templateKey = 'reminder', category: LoopCategory = 'reminder'): LoopMessage {
  return {
    templateKey,
    familyId: 'fam-1',
    parentUserId: 'user-1',
    category,
    urgency: p.offset === '-PT1H' ? 'time_sensitive' : 'normal',
    payload: p as unknown as Record<string, unknown>,
  };
}

function render(p: ReminderPayload, channel: 'email' | 'sms' | 'push', level: ChildNameLevel): RenderedContent {
  return loopTemplateRenderer.render(msg(p), channel, level);
}

function sms(p: ReminderPayload, level: ChildNameLevel): string {
  const r = render(p, 'sms', level);
  if (r.kind !== 'sms') throw new Error('expected sms');
  return r.text;
}

function push(p: ReminderPayload, level: ChildNameLevel) {
  const r = render(p, 'push', level);
  if (r.kind !== 'push') throw new Error('expected push');
  return r;
}

function email(p: ReminderPayload, level: ChildNameLevel) {
  const r = render(p, 'email', level);
  if (r.kind !== 'email') throw new Error('expected email');
  return r;
}

const batch = payload({ offset: '-P1D', events: [apptAt10, swimAt430] });
const single = payload({ offset: '-PT1H', events: [swimAt430], deepLink: null });

describe('T-24h batch — Tomorrow lead, every event listed', () => {
  it('push titles the lead and joins every event line inline, with the /plan deep link', () => {
    const p = push(batch, 'first_name');
    expect(p.title).toBe('Tomorrow');
    expect(p.body).toBe(`an appointment at 10:00, Maya ${EM_DASH} Swim class at 4:30`);
    expect(p.data?.deepLink).toBe(DEEP_LINK);
  });

  it('sms folds to GSM-7 (em-dash → hyphen), one segment, no link (fits the budget)', () => {
    const text = sms(batch, 'first_name');
    expect(text).toBe('Tomorrow: an appointment at 10:00, Maya - Swim class at 4:30');
    expect(smsSegments(text)).toBe(1);
    expect(text).not.toContain('http');
  });

  it('email lists both events as a time→event note and carries the See-your-week link', () => {
    const e = email(batch, 'first_name');
    expect(e.subject).toBe(`Tomorrow: an appointment at 10:00, Maya ${EM_DASH} Swim class at 4:30`);
    expect(e.html).toContain('Swim class');
    expect(e.html).toContain('an appointment');
    // Both times are surfaced in the note body (the batch tabular list).
    expect(e.html).toContain('4:30');
    expect(e.html).toContain('10:00');
    expect(e.html).toContain(`href="${DEEP_LINK}"`);
    expect(e.html).toContain('See your week');
  });
});

describe('T-1h single — In an hour lead, glanceable, no links anywhere (rule #6)', () => {
  it('push titles In an hour, one event, and carries NO deep link', () => {
    const p = push(single, 'first_name');
    expect(p.title).toBe('In an hour');
    expect(p.body).toBe(`Maya ${EM_DASH} Swim class at 4:30`);
    expect(p.data).toBeUndefined();
  });

  it('sms is one segment and carries no url', () => {
    const text = sms(single, 'first_name');
    expect(text).toBe('In an hour: Maya - Swim class at 4:30');
    expect(smsSegments(text)).toBe(1);
    expect(text).not.toContain('http');
  });

  it('email has no See-your-week link and no /plan link (glanceable, rule #6)', () => {
    const e = email(single, 'first_name');
    expect(e.subject).toBe(`In an hour: Maya ${EM_DASH} Swim class at 4:30`);
    expect(e.html).not.toContain('See your week');
    expect(e.html).not.toContain('/plan');
  });
});

describe('teen event is generic at EVERY level and EVERY channel (rule #1)', () => {
  const teenBatch = payload({ offset: '-P1D', events: [apptAt10] });
  const teenPing = payload({ offset: '-PT1H', events: [apptAt10], deepLink: null });

  it('never surfaces the teen name or the title — only "an appointment"', () => {
    for (const level of ['first_name', 'relation', 'generic'] as ChildNameLevel[]) {
      for (const p of [teenBatch, teenPing]) {
        const smsText = sms(p, level);
        const pushBody = push(p, level).body;
        const html = email(p, level).html;
        for (const out of [smsText, pushBody, html]) {
          expect(out).toContain('an appointment');
          expect(out).not.toContain('Sam');
          expect(out).not.toContain('Therapy');
        }
      }
    }
  });
});

describe('a flagged-sensitive event is generic even for a non-teen (rule #1)', () => {
  const sensitive = ev({ childId: 'c-maya', title: 'Blood test', sensitive: true });
  const p = payload({ offset: '-P1D', events: [sensitive] });

  it('shows "an appointment", never the health title, on every channel', () => {
    for (const out of [sms(p, 'first_name'), push(p, 'first_name').body, email(p, 'first_name').html]) {
      expect(out).toContain('an appointment');
      expect(out).not.toContain('Blood test');
    }
  });
});

describe('SMS segment budget', () => {
  it('a single T-1h reminder is exactly one segment', () => {
    expect(smsSegments(sms(single, 'first_name'))).toBe(1);
  });

  it('a large batch caps the inline list to "+N more" plus the /plan link, ≤2 segments', () => {
    const many = payload({
      offset: '-P1D',
      events: Array.from({ length: 20 }, (_, i) => ev({ eventRef: `e-${i}`, title: 'Swim class' })),
    });
    const text = sms(many, 'first_name');
    expect(smsSegments(text)).toBeLessThanOrEqual(2);
    expect(text).toMatch(/\+\d+ more/);
    expect(text).toContain(DEEP_LINK);
  });
});

describe('email fail-closed CASL', () => {
  it('throws when the unsubscribe url is missing', () => {
    expect(() => email(payload({ offset: '-P1D', events: [swimAt430], unsubscribeUrl: null }), 'first_name')).toThrow(
      /unsubscribe/,
    );
  });

  it('carries the sender identity, business address, and the escaped unsubscribe url', () => {
    const e = email(batch, 'first_name');
    expect(e.html).toContain('Village Hale Technologies Inc.');
    expect(e.html).toContain('https://app.villagehale.com/unsubscribe?u=user-1&amp;t=daily_digest&amp;sig=abc');
  });
});

describe('registry routing by templateKey', () => {
  it('routes a reminder message to the reminder renderer', () => {
    const r = loopTemplateRenderer.render(msg(batch), 'push', 'first_name');
    expect(r.kind === 'push' && r.title).toBe('Tomorrow');
  });

  it('still routes a weekly_plan message to its own renderer (not the reminder one)', () => {
    const weekly: LoopMessage = {
      templateKey: 'weekly_plan',
      familyId: 'fam-1',
      parentUserId: 'user-1',
      category: 'weekly_plan',
      urgency: 'normal',
      payload: {
        weekStart: '2026-07-20',
        summary: null,
        items: [],
        children: [],
        deepLink: DEEP_LINK,
        unsubscribeUrl: UNSUB,
      },
    };
    const r = loopTemplateRenderer.render(weekly, 'push', 'generic');
    expect(r.kind === 'push' && r.title).toBe('Your week is ready');
  });
});
