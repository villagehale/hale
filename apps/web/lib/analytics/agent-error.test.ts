import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentError,
  buildAgentErrorPayload,
  captureAgentError,
  hashFamilyId,
  resetAnalyticsAbsenceLogForTests,
} from './server-capture';

/**
 * AGENT ERROR TRACKING, and the guarantee that makes it safe to have at all.
 *
 * The lanes these report from are the places Hale is holding a parent's own words: a
 * coach turn, a Twilio send, a relay call, a trimmed reply, a promised follow-up. So the
 * question is not "does it report" — it is "could a message ever ride out on one".
 *
 * Expected values are derived from the rule (a lane, an enum class, a one-way family
 * digest, nothing else), not from what the builder happens to return.
 */

const FAMILY = 'f0f1f2f3-1111-4111-8111-aaaaaaaaaaaa';

/**
 * A parent's real text, a child's name, a phone number, a Twilio error string — the
 * things that actually sit in scope at each of these call sites. Every assertion below
 * runs against these, so a leak has to show up as one of them.
 */
const POISON = {
  parentText: 'Mia has a fever of 39 and I am scared, what do I do',
  childName: 'Mia',
  phone: '+16475551234',
  twilioMessage: 'twilio send failed: HTTP 400, twilio code 21610',
  familyId: FAMILY,
};

function serialized(error: AgentError): string {
  return JSON.stringify(buildAgentErrorPayload(error));
}

describe('the payload carries a lane, a class, and a hashed family — nothing else', () => {
  it('reports a deferred coach turn by its reason enum', () => {
    expect(
      buildAgentErrorPayload({ lane: 'coach', reason: 'model_unreachable', familyId: FAMILY }),
    ).toEqual({
      event: 'agent_turn_failed',
      distinctId: hashFamilyId(FAMILY),
      properties: {
        lane: 'coach',
        error_class: 'model_unreachable',
        family_hash: hashFamilyId(FAMILY),
      },
    });
  });

  it('reports a Twilio refusal by its numeric code and whether a retry could help', () => {
    expect(
      buildAgentErrorPayload({
        lane: 'transport',
        code: '21610',
        retry: 'permanent',
        familyId: FAMILY,
      }).properties,
    ).toEqual({
      lane: 'transport',
      error_class: '21610',
      retry: 'permanent',
      family_hash: hashFamilyId(FAMILY),
    });
  });

  it('reports how far past the segment budget an answer ran', () => {
    expect(
      buildAgentErrorPayload({ lane: 'reply_budget', overBy: 47, familyId: FAMILY }).properties,
    ).toEqual({
      lane: 'reply_budget',
      error_class: 'budget_overflow',
      over_by: 47,
      family_hash: hashFamilyId(FAMILY),
    });
  });

  it('keys a pre-auth relay refusal on the lane, since there is no family to blame', () => {
    const payload = buildAgentErrorPayload({ lane: 'relay', reason: 'replayed', familyId: null });
    expect(payload.distinctId).toBe('lane:relay');
    expect(payload.properties).toEqual({ lane: 'relay', error_class: 'replayed' });
    // Absent, not a placeholder: a household that does not exist must not look like one.
    expect(payload.properties).not.toHaveProperty('family_hash');
  });

  it('reports a sweep failure by the kind of promise that was owed', () => {
    expect(
      buildAgentErrorPayload({ lane: 'commitments', kind: 'first_find', familyId: FAMILY })
        .properties.error_class,
    ).toBe('first_find');
  });
});

describe('the family id never leaves as itself', () => {
  it('sends a one-way digest, not the id', () => {
    const payload = buildAgentErrorPayload({
      lane: 'coach',
      reason: 'model_unreachable',
      familyId: FAMILY,
    });
    expect(JSON.stringify(payload)).not.toContain(FAMILY);
    expect(payload.properties.family_hash).toBe(hashFamilyId(FAMILY));
  });

  it('is stable, so failures for one household group together', () => {
    expect(hashFamilyId(FAMILY)).toBe(hashFamilyId(FAMILY));
    expect(hashFamilyId(FAMILY)).not.toBe(hashFamilyId('f0f1f2f3-1111-4111-8111-aaaaaaaaaaab'));
  });
});

describe('no free text can reach the payload (poisoned fixtures)', () => {
  // POSITIVE CONTROL — without this, every assertion below could pass because the
  // payload was empty, or because the fixture never reached the builder at all. This
  // proves the same channel DOES carry the value it is supposed to.
  it('positive control: an enum class the same width as a name does come through', () => {
    expect(serialized({ lane: 'coach', reason: 'model_unreachable', familyId: FAMILY })).toContain(
      'model_unreachable',
    );
  });

  it("a parent's own text passed as a reason is dropped, not sent", () => {
    const out = serialized({ lane: 'coach', reason: POISON.parentText, familyId: FAMILY });
    expect(out).not.toContain('fever');
    expect(out).not.toContain(POISON.parentText);
    expect(out).toContain('unclassified');
  });

  it("a child's name passed as a commitment kind is dropped", () => {
    // Lowercase and short — it would pass a naive length check. The token rule is what
    // catches it: a capitalised or spaced value is not an enum from this repo.
    const out = serialized({ lane: 'commitments', kind: POISON.childName, familyId: FAMILY });
    expect(out).not.toContain('Mia');
    expect(out).toContain('unclassified');
  });

  it("Twilio's own error string is dropped where only its code belongs", () => {
    const out = serialized({
      lane: 'transport',
      code: POISON.twilioMessage,
      retry: 'permanent',
      familyId: FAMILY,
    });
    expect(out).not.toContain('twilio send failed');
    expect(out).toContain('unclassified');
  });

  it('a phone number passed as a relay reason is dropped', () => {
    const out = serialized({ lane: 'relay', reason: POISON.phone, familyId: null });
    expect(out).not.toContain('6475551234');
    expect(out).toContain('unclassified');
  });

  it('a trim overflow reports a count and cannot report a body', () => {
    // `overBy` is a number: the type system is the guarantee here, and this pins that
    // the sent payload is the count and the two enums, with no room beside them.
    const payload = buildAgentErrorPayload({
      lane: 'reply_budget',
      overBy: POISON.parentText.length,
      familyId: FAMILY,
    });
    expect(Object.keys(payload.properties).sort()).toEqual([
      'error_class',
      'family_hash',
      'lane',
      'over_by',
    ]);
  });
});

describe('reporting never makes a failure worse', () => {
  beforeEach(() => {
    resetAnalyticsAbsenceLogForTests();
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://ph.example.com');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('swallows a provider outage and says so, rather than throwing into a catch block', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    await expect(
      captureAgentError({ lane: 'coach', reason: 'model_unreachable', familyId: FAMILY }),
    ).resolves.toBe('provider_error');
  });

  it('names the missing key instead of pretending the report was sent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      captureAgentError({ lane: 'coach', reason: 'model_unreachable', familyId: FAMILY }),
    ).resolves.toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the poisoned-fixture-proof payload on the wire, not just in the builder', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await captureAgentError({ lane: 'coach', reason: POISON.parentText, familyId: FAMILY });

    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain('fever');
    expect(body).not.toContain(FAMILY);
    expect(JSON.parse(body).properties).toEqual({
      lane: 'coach',
      error_class: 'unclassified',
      family_hash: hashFamilyId(FAMILY),
    });
  });
});
