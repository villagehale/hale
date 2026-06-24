import { describe, expect, it } from 'vitest';
import { JOIN_HREF, JoinCta, SocialProofBadge } from './public-surface';

/**
 * The public artifacts' conversion hook MUST send a non-user to sign-up so the
 * share loop closes (view → join → contribute → recommend). We assert the single
 * source-of-truth constant and that JoinCta renders an anchor to it.
 */
describe('public-surface conversion hook', () => {
  it('JOIN_HREF points at the in-app sign-up / join entry', () => {
    expect(JOIN_HREF).toBe('/sign-in');
  });

  it('JoinCta renders an anchor whose href is JOIN_HREF', () => {
    const el = JoinCta({});
    const serialized = JSON.stringify(el);
    // The CTA anchor carries the join href so a viewer can convert.
    expect(serialized).toContain(JOIN_HREF);
    expect(serialized).toContain('join the village');
  });
});

describe('SocialProofBadge — aggregate only (rule #1)', () => {
  it('renders nothing below the threshold', () => {
    expect(SocialProofBadge({ count: 1 })).toBeNull();
  });

  it('renders a count label (never a family name) at 2+', () => {
    const el = SocialProofBadge({ count: 4 });
    expect(JSON.stringify(el)).toContain('loved by 4 families near you');
  });
});
