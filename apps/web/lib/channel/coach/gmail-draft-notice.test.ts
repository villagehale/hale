import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  GmailDraftNoticeUnsent,
  MAX_NOTICE_ATTEMPTS,
  composeGmailDraftNotice,
  isGmailDraftNoticeUnsent,
  noticeProblems,
} from './gmail-draft-notice';

function clientSaying(bodies: string[]): AgentClient {
  let call = 0;
  return {
    messages: {
      async create() {
        const notice = bodies[Math.min(call, bodies.length - 1)] ?? '';
        call += 1;
        return {
          content: [{ type: 'tool_use', name: 'gmail_draft_notice', input: { notice } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  } as unknown as AgentClient;
}

describe('gmail draft notice', () => {
  it('sends the first sentence that clears the gates', async () => {
    const text = await composeGmailDraftNotice(
      clientSaying(['A draft is in your Gmail for you to review and send.']),
      'create',
    );
    expect(text).toBe('A draft is in your Gmail for you to review and send.');
  });

  it('retries a keyword ask once, then sends the sentence that does not ask', async () => {
    const text = await composeGmailDraftNotice(
      clientSaying([
        'Reply YES and I will send it.',
        'A draft is in your Gmail. You send it when it looks right.',
      ]),
      'create',
    );
    expect(text).toBe('A draft is in your Gmail. You send it when it looks right.');
    expect(noticeProblems('Reply YES and I will send it.')).toContain('keyword_yes');
  });

  it('sends nothing after the one retry is also refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const create = vi.fn(async () => ({
      content: [
        { type: 'tool_use', name: 'gmail_draft_notice', input: { notice: 'I sent the email.' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const text = await composeGmailDraftNotice(
      { messages: { create } } as unknown as AgentClient,
      'create',
    );
    expect(text).toBeNull();
    expect(create).toHaveBeenCalledTimes(MAX_NOTICE_ATTEMPTS);
    error.mockRestore();
  });

  it('walks a wrapped cause to the unsent notice', () => {
    const wrapped = new Error('turn failed', { cause: new GmailDraftNoticeUnsent() });
    expect(isGmailDraftNoticeUnsent(wrapped)).toBe(true);
    expect(isGmailDraftNoticeUnsent(new Error('other'))).toBe(false);
  });
});
