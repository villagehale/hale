import { describe, expect, it } from 'vitest';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { parseTransportAddress } from './transport-address';

/**
 * The webhook-boundary parser. A `whatsapp:` prefix is named so the inbound
 * webhook can drop that pipe. The bare address is what `normalizePhoneE164`
 * would see; the webhook does not hand a WhatsApp turn to that normalizer.
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
