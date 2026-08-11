import { describe, expect, it } from 'vitest';
import { automationKind } from './automated';

describe('automationKind', () => {
  it('reads an ordinary human message as not automated', () => {
    expect(automationKind({ from: 'sam@example.com' }, 'mail.villagehale.com')).toBeNull();
    expect(
      automationKind(
        { from: 'sam@example.com', headers: { subject: 'Re: your week', 'message-id': '<a@b>' } },
        'mail.villagehale.com',
      ),
    ).toBeNull();
  });

  /**
   * RFC 3834's own marker. An out-of-office replying to Hale's reply, which replies to
   * the out-of-office, is a loop that costs real money and buries a parent's inbox — and
   * it is the single most common way a first email leg fails in production.
   */
  it('detects RFC 3834 Auto-Submitted', () => {
    for (const value of ['auto-replied', 'auto-generated', 'AUTO-REPLIED']) {
      expect(
        automationKind({ from: 'sam@example.com', headers: { 'auto-submitted': value } }, 'x.test'),
      ).toBe('auto_submitted');
    }
  });

  it('treats Auto-Submitted: no as a human message, because that is what it means', () => {
    expect(
      automationKind({ from: 'sam@example.com', headers: { 'auto-submitted': 'no' } }, 'x.test'),
    ).toBeNull();
  });

  it('detects the vendor out-of-office markers', () => {
    expect(
      automationKind({ from: 'sam@example.com', headers: { 'x-autoreply': 'yes' } }, 'x.test'),
    ).toBe('auto_submitted');
    expect(
      automationKind({ from: 'sam@example.com', headers: { 'x-autorespond': 'ooo' } }, 'x.test'),
    ).toBe('auto_submitted');
  });

  it('detects bulk and auto_reply precedence', () => {
    for (const value of ['bulk', 'list', 'junk', 'auto_reply']) {
      expect(
        automationKind({ from: 'sam@example.com', headers: { precedence: value } }, 'x.test'),
      ).toBe('bulk');
    }
  });

  /** A null return path is the sender an SMTP bounce uses; nothing may be sent to it. */
  it('detects a null return-path bounce', () => {
    expect(
      automationKind({ from: 'sam@example.com', headers: { 'return-path': '<>' } }, 'x.test'),
    ).toBe('bounce');
  });

  it('detects the standard bounce sender addresses', () => {
    for (const from of [
      'MAILER-DAEMON@example.com',
      'postmaster@example.com',
      'mailer-daemon@mail.example.com',
    ]) {
      expect(automationKind({ from }, 'x.test')).toBe('bounce');
    }
  });

  /**
   * Hale's own address writing to Hale is a loop by definition, whether it is a bounce,
   * a forwarding misconfiguration, or the leg answering itself.
   */
  it('detects our own inbound domain as the sender', () => {
    expect(automationKind({ from: 'aloha@mail.villagehale.com' }, 'mail.villagehale.com')).toBe(
      'self',
    );
    expect(automationKind({ from: 'Hale <ALOHA@Mail.VillageHale.com>' }, 'mail.villagehale.com')).toBe(
      'self',
    );
  });

  it('does not mistake a lookalike domain for our own', () => {
    expect(
      automationKind({ from: 'sam@notmail.villagehale.com' }, 'mail.villagehale.com'),
    ).toBeNull();
    expect(
      automationKind({ from: 'sam@mail.villagehale.com.evil.test' }, 'mail.villagehale.com'),
    ).toBeNull();
  });

  it('matches header names case-insensitively', () => {
    expect(
      automationKind({ from: 'sam@example.com', headers: { 'Auto-Submitted': 'auto-replied' } }, 'x.test'),
    ).toBe('auto_submitted');
    expect(
      automationKind({ from: 'sam@example.com', headers: { Precedence: 'bulk' } }, 'x.test'),
    ).toBe('bulk');
  });

  it('does not fire on a header whose value merely mentions a marker', () => {
    expect(
      automationKind(
        { from: 'sam@example.com', headers: { subject: 'my auto-replied bulk bounce' } },
        'x.test',
      ),
    ).toBeNull();
  });

  it('does not treat a parent whose name contains postmaster as a bounce', () => {
    expect(automationKind({ from: 'postmasters-kid@example.com' }, 'x.test')).toBeNull();
  });
});
