import { describe, expect, it } from 'vitest';
import { createResendContentReader } from './content';

/**
 * The typed refusal on the content fetch (the PR #497 shape, applied to the read
 * side): a provider error must carry WHETHER RETRYING CAN EVER HELP, because the
 * webhook's answer hangs on it — transient answers 5xx so svix redelivers, permanent
 * answers 200 so it never does. A string reason alone let a 30-second Resend blip be
 * acknowledged as handled, which permanently dropped the parent's email.
 *
 * Permanent is ENUMERATED (the email itself is gone: not_found / 404) and everything
 * else is transient, so a misclassification fails toward the retry — the direction
 * that cannot lose mail.
 */

function readerAnswering(answer: {
  data: { text: string | null; html: string | null; headers?: Record<string, string> } | null;
  error: { name: string; message: string; statusCode: number | null } | null;
}) {
  return createResendContentReader({
    client: {
      receiving: {
        get: async () => answer,
      },
    } as never,
  });
}

describe('createResendContentReader · typed refusals', () => {
  it('a 404 the provider names not_found is permanent', async () => {
    const reader = readerAnswering({
      data: null,
      error: { name: 'not_found', message: 'Email not found', statusCode: 404 },
    });
    expect(await reader.fetch('email-1')).toEqual({
      status: 'failed',
      reason: 'not_found',
      transient: false,
    });
  });

  it('a missing body with no error at all is permanent not_found', async () => {
    const reader = readerAnswering({ data: null, error: null });
    expect(await reader.fetch('email-1')).toEqual({
      status: 'failed',
      reason: 'not_found',
      transient: false,
    });
  });

  it('a rate limit is transient — svix must be allowed to retry it', async () => {
    const reader = readerAnswering({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Too many requests', statusCode: 429 },
    });
    expect(await reader.fetch('email-1')).toEqual({
      status: 'failed',
      reason: 'provider_error',
      transient: true,
    });
  });

  it('a provider 5xx is transient', async () => {
    const reader = readerAnswering({
      data: null,
      error: { name: 'internal_server_error', message: 'boom', statusCode: 500 },
    });
    expect(await reader.fetch('email-1')).toEqual({
      status: 'failed',
      reason: 'provider_error',
      transient: true,
    });
  });

  it('an unreachable provider (the SDK reports no status code) is transient', async () => {
    const reader = readerAnswering({
      data: null,
      error: {
        name: 'application_error',
        message: 'Unable to fetch data. The request could not be resolved.',
        statusCode: null,
      },
    });
    expect(await reader.fetch('email-1')).toEqual({
      status: 'failed',
      reason: 'provider_error',
      transient: true,
    });
  });

  it('a readable email comes back whole', async () => {
    const reader = readerAnswering({
      data: { text: 'hi', html: null, headers: { 'x-test': 'yes' } },
      error: null,
    });
    expect(await reader.fetch('email-1')).toEqual({
      status: 'ok',
      content: { text: 'hi', html: null, headers: { 'x-test': 'yes' } },
    });
  });
});
