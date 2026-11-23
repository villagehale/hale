import { describe, expect, it } from 'vitest';
import { connectPageMeta, connectedStatus, flattenCopy, landingCopy } from './connect-page-copy';

/**
 * VIL-721 · the web pages around the one Google link: the landing card names both
 * Gmail and Google Calendar (the same reads, nevers and unverified-app note the two
 * single pages carry), and the done page has an answer for `provider=google`. The
 * single-connector pages are unchanged.
 */

describe('the one-link landing card', () => {
  const google = landingCopy('google');
  const gmail = landingCopy('gmail');
  const gcal = landingCopy('gcal');

  it('asks for both, and prepares the parent for the unverified-app screen', () => {
    expect(google.provider).toBe('google');
    expect(flattenCopy(google.title)).toBe('Connect Gmail and your calendar');
    expect(google.note).toContain('“unverified app”');
    expect(google.note).toContain('Tap Advanced, then continue');
    expect(google.note).toContain('Gmail and Google Calendar');
  });

  it('carries the Gmail reads, then the calendar reads, and both nevers', () => {
    expect(google.reads).toEqual([...gmail.reads, ...gcal.reads]);
    expect(google.never[0]).toEqual(gmail.never[0]);
    expect(google.never[1]).toEqual(gcal.never[0]);
    expect(google.never.slice(2)).toEqual(gmail.never.slice(1));
  });

  it('unfurls as the ask for both', () => {
    expect(connectPageMeta('google').tabTitle).toBe('Connect Gmail and your calendar');
  });
});

describe('the done page for the one link', () => {
  it('says both are connected', () => {
    const ok = connectedStatus('ok', 'google');
    expect(flattenCopy(ok.heading)).toBe('Connected');
    expect(ok.tabTitle).toBe('Gmail and calendar connected');
    expect(flattenCopy(ok.lede)).toContain('Gmail and Google Calendar are connected');
  });

  it('names both boxes on a denial and when neither was ticked', () => {
    const denied = connectedStatus('denied', 'google');
    expect(flattenCopy(denied.help?.body ?? [])).toContain('Gmail and Google Calendar');
    const partial = connectedStatus('partial', 'google');
    expect(flattenCopy(partial.heading)).toContain('Gmail and Google Calendar');
  });

  it('keeps the single-connector pages as they were', () => {
    expect(connectedStatus('ok', 'gmail').tabTitle).toBe('Gmail connected');
    expect(connectedStatus('ok', 'gcal').tabTitle).toBe('Calendar connected');
    expect(connectedStatus('partial', 'gcal').tabTitle).toBe('Calendar box not ticked');
    expect(connectPageMeta('gmail').tabTitle).toBe('Connect Gmail');
  });
});
