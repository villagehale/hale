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

  it('sends the reader text when a mental reply spells the line 9-8-8', async () => {
    const { writer, write } = recordingWriter('should not be asked');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverCrisisReply({
      kind: 'mental',
      readerText: ' Appelle ou texte le 9-8-8. ',
      parentWords: "je n'en peux plus",
      where: 'intake crisis',
      region: 'CA',
      writer,
    });
    expect(body).toBe('Appelle ou texte le 9-8-8.');
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

  it('narrows an emergency that also carries 988 to a 911-only rewrite', async () => {
    const { writer, write } = recordingWriter('Call 911 now.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverCrisisReply({
      kind: 'emergency',
      readerText: 'Call 911, or text 988.',
      parentWords: 'not breathing',
      where: 'intake crisis',
      region: 'CA',
      writer,
    });
    expect(body).toBe('Call 911 now.');
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'crisis_emergency',
        mustInclude: ['911'],
        facts: { emergency: '911' },
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('sends nothing and pages when the emergency rewrite still carries 988', async () => {
    const { writer } = recordingWriter('Call 911 or text 9-8-8.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverCrisisReply({
      kind: 'emergency',
      readerText: 'Text 988 and call 911.',
      parentWords: 'not breathing',
      where: 'intake crisis',
      region: 'US',
      writer,
    });
    expect(body).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ urgent: true, kind: 'emergency', where: 'intake crisis' }),
      PAGE,
    );
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

  it('hands a reader reply with another phone number to the writer, and sends a clean one as is', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stray = recordingWriter('Call or text 988, any time.');
    const strayBody = await deliverCrisisReply({
      kind: 'mental',
      readerText: 'Call or text 988, or the clinic on 555 0100.',
      parentWords: 'i want to end it',
      where: 'intake crisis',
      region: 'US',
      writer: stray.writer,
    });
    expect(strayBody).toBe('Call or text 988, any time.');
    expect(stray.write).toHaveBeenCalledTimes(1);

    const clean = recordingWriter('should not be asked');
    const cleanBody = await deliverCrisisReply({
      kind: 'mental',
      readerText: 'Call or text 988, any time. 911 if you are in danger.',
      parentWords: 'i want to end it',
      where: 'intake crisis',
      region: 'US',
      writer: clean.writer,
    });
    expect(cleanBody).toBe('Call or text 988, any time. 911 if you are in danger.');
    expect(clean.write).not.toHaveBeenCalled();
  });

  it('hands a reader reply with a link to the writer; with no writer text it sends nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const readerText of [
      'Call or text 988, or chat at https://example.org/help.',
      'Call or text 988 or visit www.example.org.',
      'Call or text 988, or see example.org',
    ]) {
      const { writer, write } = recordingWriter(null);
      const body = await deliverCrisisReply({
        kind: 'mental',
        readerText,
        parentWords: 'i want to end it',
        where: 'intake crisis',
        region: 'CA',
        writer,
      });
      expect(body).toBeNull();
      expect(write).toHaveBeenCalledTimes(1);
    }
    expect(error).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ urgent: true, kind: 'mental', where: 'intake crisis' }),
      PAGE,
    );
  });
});
