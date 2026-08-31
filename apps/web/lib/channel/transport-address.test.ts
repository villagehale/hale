import { describe, expect, it } from 'vitest';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { parseTransportAddress } from './transport-address';

/**
 * The webhook-boundary parser — the ONE place the `whatsapp:` prefix is stripped.
 * Everything downstream (normalize → blind index → resolve → keywords → machine)
 * runs on the bare address, which is what makes `whatsapp:+1416…` and `+1416…`
 * the same person by construction (the continuity law).
 */

describe('parseTransportAddress', () => {
  it('strips the whatsapp: prefix and names the transport', () => {
    expect(parseTransportAddress('whatsapp:+14165551234')).toEqual({
      transport: 'whatsapp',
      address: '+14165551234',
    });
  });

  it('leaves a bare number untouched as sms', () => {
    expect(parseTransportAddress('+14165551234')).toEqual({
      transport: 'sms',
      address: '+14165551234',
    });
  });

  it('a prefix with nothing behind it yields an empty address, not a crash', () => {
    expect(parseTransportAddress('whatsapp:')).toEqual({ transport: 'whatsapp', address: '' });
  });

  it('the stripped address canonicalizes to the SAME E.164 as its sms twin', () => {
    // The continuity law at the unit level: one number, one canonical form, one
    // blind index — whichever pipe it arrived on.
    const viaWhatsApp = parseTransportAddress('whatsapp:+1 (416) 555-1234');
    expect(normalizePhoneE164(viaWhatsApp.address)).toBe(normalizePhoneE164('+14165551234'));
  });

  it('does not treat a prefix anywhere but the start as a transport', () => {
    expect(parseTransportAddress('+1whatsapp:4165551234')).toEqual({
      transport: 'sms',
      address: '+1whatsapp:4165551234',
    });
  });
});
