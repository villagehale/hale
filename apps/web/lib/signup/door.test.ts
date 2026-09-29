import { describe, expect, it } from 'vitest';
import { chooseReportDoor } from './door';

describe('chooseReportDoor', () => {
  it('uses the co-parent group when one exists and does not also pick 1:1', () => {
    expect(chooseReportDoor({ groupChatId: 'chat-1', existingThread: true })).toEqual({
      kind: 'group',
      chatId: 'chat-1',
    });
  });

  it('uses the thread the parent already opened when there is no group', () => {
    expect(chooseReportDoor({ groupChatId: null, existingThread: true })).toEqual({
      kind: 'existing_thread',
    });
    expect(chooseReportDoor({ groupChatId: '  ', existingThread: true })).toEqual({
      kind: 'existing_thread',
    });
  });

  it('holds when the only send would be a new 1:1', () => {
    expect(chooseReportDoor({ groupChatId: null, existingThread: false })).toEqual({
      kind: 'held',
      reason: 'would_initiate_1_1',
    });
  });
});
