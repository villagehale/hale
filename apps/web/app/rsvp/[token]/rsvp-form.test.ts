import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReminderConfirmation, RsvpForm } from './rsvp-form';

const CHECKBOX_OFF =
  "Text me a reminder the day before. One message from Hale about this party only — reply STOP any time. Your number isn't stored unless you tick this.";
const CHECKBOX_ON =
  "Text me a reminder the day before. One message from Hale about this party only. If you'd rather not hear from Hale, reply and say so. Your number isn't stored unless you tick this.";
const CONFIRMATION_OFF = "I'll text you once, the day before. Reply STOP any time.";
const CONFIRMATION_ON =
  "I'll text you once, the day before. If you'd rather not hear from Hale, reply and say so, and I won't text you again.";

/** The page as a guest reads it: tags dropped, entities decoded, whitespace collapsed. */
function pageText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const form = (plainStopWording: boolean) =>
  pageText(renderToStaticMarkup(createElement(RsvpForm, { token: 't', plainStopWording })));
const confirmation = (plainStopWording: boolean) =>
  pageText(renderToStaticMarkup(createElement(ReminderConfirmation, { plainStopWording })));

describe('VIL-742 the reminder wording on the RSVP page', () => {
  it('flag on: the checkbox says it in plain words and names no keyword', () => {
    const text = form(true);
    expect(text).toContain(CHECKBOX_ON);
    expect(text).not.toMatch(/\bSTOP\b/i);
    expect(text).not.toMatch(/\bHELP\b/i);
  });

  it('flag on: the confirmation says it in plain words and names no keyword', () => {
    const text = confirmation(true);
    expect(text).toBe(CONFIRMATION_ON);
    expect(text).not.toMatch(/\bSTOP\b/i);
    expect(text).not.toMatch(/\bHELP\b/i);
  });

  it("positive control: flag off keeps today's checkbox", () => {
    expect(form(false)).toContain(CHECKBOX_OFF);
  });

  it("positive control: flag off keeps today's confirmation", () => {
    expect(confirmation(false)).toBe(CONFIRMATION_OFF);
  });
});
