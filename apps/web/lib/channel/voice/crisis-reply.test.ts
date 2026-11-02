import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaidLineWriter } from './said-line';
import { deliverCrisisReply } from './said-line';

const PAGE = 'URGENT: crisis flagged, no reply sent - page #ops now';

function recordingWriter(text: string | null): {
  writer: SaidLineWriter;
  write: ReturnType<typeof vi.fn>;
} {
  const write = vi.fn(async () => text);
  return { writer: { write }, write };
}

describe('deliverCrisisReply', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the reader text when a mental reply already contains 988', async () => {
    const { writer, write } = recordingWriter('should not be asked');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverCrisisReply({
      kind: 'mental',
      readerText: '  Call or text 988.  ',
      parentWords: "je n'en peux plus",
      where: 'intake crisis',
      region: null,
      writer,
    });
    expect(body).toBe('Call or text 988.');
    expect(write).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('sends the reader text when an emergency reply already contains 911', async () => {
    const { writer, write } = recordingWriter('should not be asked');
    const body = await deliverCrisisReply({
      kind: 'emergency',
      readerText: 'Call 911 now.',
      parentWords: 'he is not breathing',
      where: 'intake crisis',
      region: 'US',
      writer,
    });
    expect(body).toBe('Call 911 now.');
    expect(write).not.toHaveBeenCalled();
  });

  it('hands a mental reply without 988 to writeCrisisLine and sends that text', async () => {
    const { writer, write } = recordingWriter('Text 988. I am here.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverCrisisReply({
      kind: 'mental',
      readerText: 'I am glad you told me.',
      parentWords: "je n'en peux plus",
      where: 'intake crisis',
      region: 'CA',
      writer,
    });
    expect(body).toBe('Text 988. I am here.');
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'crisis_mental',
        parentWords: "je n'en peux plus",
        mustInclude: ['988'],
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('hands an emergency reply without 911 to writeCrisisLine and sends that text', async () => {
    const { writer, write } = recordingWriter('Call 911.');
    const body = await deliverCrisisReply({
      kind: 'emergency',
      readerText: 'Call or text 988.',
      parentWords: 'not breathing',
      where: 'intake crisis',
      region: 'US',
      writer,
    });
    expect(body).toBe('Call 911.');
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'crisis_emergency',
        mustInclude: ['911'],
        facts: { emergency: '911' },
      }),
    );
  });

  it('sends nothing and pages when writeCrisisLine cannot write', async () => {
    const { writer } = recordingWriter(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverCrisisReply({
      kind: 'mental',
      readerText: '',
      parentWords: 'i want to end it',
      where: 'intake crisis',
      region: null,
      writer,
    });
    expect(body).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ urgent: true, kind: 'mental' }),
      PAGE,
    );
  });

  it('sends nothing and pages when the handed-off reply still lacks the number', async () => {
    const { writer } = recordingWriter('I am here with you.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverCrisisReply({
      kind: 'emergency',
      readerText: 'Stay calm.',
      parentWords: 'not breathing',
      where: 'intake crisis',
      region: null,
      writer,
    });
    expect(body).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ urgent: true, kind: 'emergency', where: 'intake crisis' }),
      PAGE,
    );
  });
});
