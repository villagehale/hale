import { describe, expect, it } from 'vitest';
import {
  type MonitorAlert,
  classifyAlert,
  composeTriageDigest,
  gsm7SingleSegment,
  triageAlerts,
} from './triage';

/**
 * VIL-331 · the triage classifier, tested against the REAL Twilio Monitor Alert list
 * shapes (field names from `GET monitor.twilio.com/v1/Alerts`): snake_case keys,
 * `alert_text` a URL-encoded blob whose `httpResponse` key is the only place the
 * webhook's answering status lives, `error_code` the 11200-class string.
 *
 * The three shapes that matter are the three the incident review named: a 403 (Twilio
 * rejected — signature/config), a fast 500 (the app answered with a crash — the
 * 2026-08-28 Supabase incident), and a bare 11200/11205 with no httpResponse at all
 * (nothing answered — deploy/network).
 */

const ALERT_403: MonitorAlert = {
  sid: 'NO00000000000000000000000000000403',
  account_sid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  alert_text:
    'Msg=HTTP+retrieval+failure&EmailNotification=false&LogLevel=ERROR&sourceComponent=14100&httpResponse=403&url=https%3A%2F%2Fapp.villagehale.com%2Fapi%2Fchannels%2Ftwilio%2Finbound&ErrorCode=11200',
  api_version: '2010-04-01',
  date_created: '2026-08-28T13:04:20Z',
  date_generated: '2026-08-28T13:04:19Z',
  date_updated: '2026-08-28T13:04:20Z',
  error_code: '11200',
  log_level: 'error',
  more_info: 'https://www.twilio.com/docs/errors/11200',
  request_method: 'POST',
  request_url: 'https://app.villagehale.com/api/channels/twilio/inbound',
  resource_sid: 'SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  service_sid: null,
  url: 'https://monitor.twilio.com/v1/Alerts/NO00000000000000000000000000000403',
};

/** The 2026-08-28 shape: the route answered 500 in well under a second. Its
 * alert_text carries the parent's To number — the thing that must never reach the
 * digest or the evidence lines. */
const ALERT_FAST_500: MonitorAlert = {
  sid: 'NO00000000000000000000000000000500',
  account_sid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  alert_text:
    'Msg=HTTP+retrieval+failure&EmailNotification=false&LogLevel=ERROR&sourceComponent=14100&httpResponse=500&To=%2B14165550123&url=https%3A%2F%2Fapp.villagehale.com%2Fapi%2Fchannels%2Ftwilio%2Finbound&ErrorCode=11200',
  api_version: '2010-04-01',
  date_created: '2026-08-28T13:02:11Z',
  date_generated: '2026-08-28T13:02:10Z',
  date_updated: '2026-08-28T13:02:11Z',
  error_code: '11200',
  log_level: 'error',
  more_info: 'https://www.twilio.com/docs/errors/11200',
  request_method: 'POST',
  request_url: 'https://app.villagehale.com/api/channels/twilio/inbound?From=%2B14165550123',
  resource_sid: 'SMyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
  service_sid: null,
  url: 'https://monitor.twilio.com/v1/Alerts/NO00000000000000000000000000000500',
};

/** Nothing answered at all: no httpResponse key, error_code the connection-failure
 * class. */
const ALERT_NO_RESPONSE: MonitorAlert = {
  sid: 'NO00000000000000000000000000011205',
  account_sid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  alert_text:
    'Msg=Connection+refused&EmailNotification=false&LogLevel=ERROR&sourceComponent=14100&url=https%3A%2F%2Fapp.villagehale.com%2Fapi%2Fchannels%2Ftwilio%2Finbound&ErrorCode=11205',
  api_version: '2010-04-01',
  date_created: '2026-08-28T13:03:05Z',
  date_generated: '2026-08-28T13:03:05Z',
  date_updated: '2026-08-28T13:03:05Z',
  error_code: '11205',
  log_level: 'error',
  more_info: 'https://www.twilio.com/docs/errors/11205',
  request_method: 'POST',
  request_url: 'https://app.villagehale.com/api/channels/twilio/inbound',
  resource_sid: 'SMzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  service_sid: null,
  url: 'https://monitor.twilio.com/v1/Alerts/NO00000000000000000000000000011205',
};

describe('classifyAlert', () => {
  it('classifies an httpResponse=403 as rejected — signature/config layer', () => {
    const triage = classifyAlert(ALERT_403);
    expect(triage.class).toBe('rejected_4xx');
    expect(triage.likelyLayer).toBe('signature_or_config');
    expect(triage.httpStatus).toBe(403);
    expect(triage.evidence).toContain('httpResponse=403');
    expect(triage.evidence).toContain('error_code=11200');
  });

  it('classifies an httpResponse=500 as a crash — DB/connection layer', () => {
    const triage = classifyAlert(ALERT_FAST_500);
    expect(triage.class).toBe('crash_5xx');
    expect(triage.likelyLayer).toBe('db_or_connection');
    expect(triage.httpStatus).toBe(500);
    expect(triage.evidence).toContain('httpResponse=500');
  });

  it('classifies a bare 11205 with no httpResponse as no response — deploy/network layer', () => {
    const triage = classifyAlert(ALERT_NO_RESPONSE);
    expect(triage.class).toBe('no_response');
    expect(triage.likelyLayer).toBe('deploy_or_network');
    expect(triage.httpStatus).toBeNull();
    expect(triage.evidence).toContain('error_code=11205');
  });

  it('names an unrecognized shape unclassified rather than folding it into a real class', () => {
    const triage = classifyAlert({
      sid: 'NO00000000000000000000000000030007',
      alert_text: 'Msg=Some+new+shape',
      error_code: '30007',
      date_created: '2026-08-28T13:05:00Z',
    });
    expect(triage.class).toBe('unclassified');
    expect(triage.likelyLayer).toBe('unknown');
  });

  it('evidence carries the route path but never a digit run long enough to be a phone number', () => {
    // Positive control: the raw alert DOES carry a parent's number, so the regex
    // below is proven able to catch a leak before we assert its absence.
    expect(decodeURIComponent(ALERT_FAST_500.alert_text ?? '')).toMatch(/\d{7,}/);
    expect(ALERT_FAST_500.request_url).toMatch(/\d{7,}/);

    const triage = classifyAlert(ALERT_FAST_500);
    const joined = triage.evidence.join('\n');
    expect(joined).toContain('url=/api/channels/twilio/inbound');
    expect(joined).not.toMatch(/\d{7,}/);
    expect(joined).not.toContain('4165550123');
  });
});

describe('triageAlerts', () => {
  it('counts each class and finds the earliest alert time', () => {
    const summary = triageAlerts([ALERT_403, ALERT_FAST_500, ALERT_NO_RESPONSE]);
    expect(summary.total).toBe(3);
    expect(summary.counts.rejected_4xx).toBe(1);
    expect(summary.counts.crash_5xx).toBe(1);
    expect(summary.counts.no_response).toBe(1);
    expect(summary.earliest?.toISOString()).toBe('2026-08-28T13:02:11.000Z');
  });

  it('a tie between classes resolves to the most severe: crash beats no-response beats rejected', () => {
    const summary = triageAlerts([ALERT_403, ALERT_FAST_500, ALERT_NO_RESPONSE]);
    expect(summary.dominant.class).toBe('crash_5xx');
  });

  it('a majority class dominates regardless of severity order', () => {
    const summary = triageAlerts([ALERT_403, ALERT_403, ALERT_FAST_500]);
    expect(summary.dominant.class).toBe('rejected_4xx');
    expect(summary.counts.rejected_4xx).toBe(2);
  });
});

describe('composeTriageDigest', () => {
  const crashSummary = triageAlerts([ALERT_FAST_500, ALERT_FAST_500, ALERT_FAST_500]);

  it('the crash digest names the count, start time, status, suspected layer and next check', () => {
    const body = composeTriageDigest(crashSummary, 'ok');
    expect(body).toContain('inbound webhook failing');
    expect(body).toContain('3 alerts');
    expect(body).toContain('since 13:02Z');
    expect(body).toContain('HTTP 500');
    expect(body).toContain('DB/connection');
    expect(body).toContain('Outbound OK');
    expect(body).toContain('Supabase');
  });

  it('the rejected digest points at signature/config, the no-response digest at deploy/network', () => {
    const rejected = composeTriageDigest(triageAlerts([ALERT_403]), 'ok');
    expect(rejected).toContain('HTTP 403');
    expect(rejected).toContain('signature/config');

    const noResponse = composeTriageDigest(triageAlerts([ALERT_NO_RESPONSE]), 'ok');
    expect(noResponse).toContain('11205');
    expect(noResponse).toContain('deploy/network');
  });

  it('the unclassified digest says so and points at the Twilio console', () => {
    const body = composeTriageDigest(
      triageAlerts([{ sid: 'NO1', alert_text: 'Msg=new', error_code: '99999', date_created: '2026-08-28T13:05:00Z' }]),
      'unchecked',
    );
    expect(body).toContain('shape unknown');
    expect(body).toContain('Twilio Monitor');
  });

  it('names an unchecked and a quiet outbound path instead of claiming health it did not see', () => {
    expect(composeTriageDigest(crashSummary, 'quiet')).toContain('Outbound quiet');
    expect(composeTriageDigest(crashSummary, 'unchecked')).toContain('Outbound unchecked');
  });

  it('every variant is GSM-7-safe and fits one 160-septet segment', () => {
    const summaries = [
      crashSummary,
      triageAlerts([ALERT_403]),
      triageAlerts([ALERT_NO_RESPONSE]),
      triageAlerts(Array.from({ length: 50 }, () => ALERT_FAST_500)),
    ];
    for (const summary of summaries) {
      for (const outbound of ['ok', 'quiet', 'unchecked'] as const) {
        const body = composeTriageDigest(summary, outbound);
        expect(gsm7SingleSegment(body), `not one GSM-7 segment: ${body}`).toBe(true);
      }
    }
  });

  it('never carries a digit run beyond a status/error code — nothing phone-shaped', () => {
    // Positive control again: the input DOES hold a 10-digit number.
    expect(decodeURIComponent(ALERT_FAST_500.alert_text ?? '')).toContain('14165550123');

    for (const outbound of ['ok', 'quiet', 'unchecked'] as const) {
      const body = composeTriageDigest(crashSummary, outbound);
      expect(body).not.toMatch(/\d{6,}/);
      expect(body).not.toContain('4165550123');
    }
  });
});

describe('gsm7SingleSegment', () => {
  it('accepts plain ASCII up to 160 and refuses extension chars and overflow', () => {
    expect(gsm7SingleSegment('Hale ALERT: plain ascii. OK+/()=:;')).toBe(true);
    expect(gsm7SingleSegment('a'.repeat(160))).toBe(true);
    expect(gsm7SingleSegment('a'.repeat(161))).toBe(false);
    // '~' and '[' need the GSM-7 extension table (2 septets each) — composed bodies
    // must not use them, so the checker refuses them outright.
    expect(gsm7SingleSegment('~tilde')).toBe(false);
    expect(gsm7SingleSegment('[bracket]')).toBe(false);
    // Non-GSM: smart quote / emoji force UCS-2.
    expect(gsm7SingleSegment('curly ’ quote')).toBe(false);
  });
});
