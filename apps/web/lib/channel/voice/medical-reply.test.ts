import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverMedicalReply } from './medical-reply';
import type { SaidLineWriter } from './said-line';

const PAGE = 'URGENT: medical reply flagged, no reply sent - page #ops now';

function scriptedWriter(replies: readonly (string | null)[]): {
  writer: SaidLineWriter;
  write: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  const write = vi.fn(async () => replies[Math.min(n++, replies.length - 1)] ?? null);
  return { writer: { write }, write };
}

describe('deliverMedicalReply', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the writer text when a health reply already carries 811 and 911', async () => {
    const { writer, write } = scriptedWriter(['Call 811, or 911 if it is an emergency.']);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverMedicalReply({
      kind: 'health',
      parentWords: 'his wrist is swollen',
      where: 'intake health',
      region: 'ON',
      writer,
    });
    expect(body).toBe('Call 811, or 911 if it is an emergency.');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'health',
        parentWords: 'his wrist is swollen',
        mustInclude: ['811', '911'],
        facts: expect.objectContaining({
          region: 'Ontario',
          healthLine: 'Health811 (Ontario), call 811, any time',
          emergency: '911',
        }),
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('passes the BC line when the region is British Columbia', async () => {
    const { writer, write } = scriptedWriter(['Call 8-1-1 or 9-1-1.']);
    const body = await deliverMedicalReply({
      kind: 'health',
      parentWords: 'fever',
      where: 'off-domain medical',
      region: 'BC',
      writer,
    });
    expect(body).toBe('Call 8-1-1 or 9-1-1.');
    expect(write.mock.calls[0]?.[0].facts.healthLine).toBe('HealthLink BC, call 8-1-1, any time');
    expect(write.mock.calls[0]?.[0].facts.healthLine).not.toContain('Health811');
  });

  it('passes both health lines and 911 when the region is unknown', async () => {
    const { writer, write } = scriptedWriter(['811 or 911.']);
    await deliverMedicalReply({
      kind: 'health',
      parentWords: 'fever',
      where: 'intake health',
      region: null,
      writer,
    });
    const facts = write.mock.calls[0]?.[0].facts;
    expect(facts.region).toBeNull();
    expect(facts.healthLine).toContain('Health811 (Ontario), call 811, any time');
    expect(facts.healthLine).toContain('HealthLink BC, call 8-1-1, any time');
    expect(facts.emergency).toBe('911');
  });

  it('accepts dashes and spaces, and requires only 911 on an emergency', async () => {
    const { writer, write } = scriptedWriter(['Call 9-1-1 now.']);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverMedicalReply({
      kind: 'emergency',
      parentWords: 'she is not breathing',
      where: 'off-domain medical',
      region: null,
      writer,
    });
    expect(body).toBe('Call 9-1-1 now.');
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ mustInclude: ['911'] }));
    expect(error).not.toHaveBeenCalled();
  });

  it('retries the writer once when the first reply misses a required number', async () => {
    const { writer, write } = scriptedWriter(['Call 811.', 'Call 811 or 9 1 1.']);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverMedicalReply({
      kind: 'health',
      parentWords: 'fever',
      where: 'intake health',
      region: 'ON',
      writer,
    });
    expect(body).toBe('Call 811 or 9 1 1.');
    expect(write).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });

  it('sends nothing and pages when the retry still lacks the number', async () => {
    const { writer, write } = scriptedWriter(['I am not sure.', 'Call 811.']);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverMedicalReply({
      kind: 'emergency',
      parentWords: 'not breathing',
      where: 'off-domain medical',
      region: null,
      writer,
    });
    expect(body).toBeNull();
    expect(write).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ urgent: true, kind: 'emergency', where: 'off-domain medical' }),
      PAGE,
    );
  });

  it('sends nothing and pages when no writer is wired', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverMedicalReply({
      kind: 'health',
      parentWords: 'fever',
      where: 'intake health',
      region: null,
      writer: null,
    });
    expect(body).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ urgent: true, kind: 'health', where: 'intake health' }),
      PAGE,
    );
  });

  it('sends nothing and pages when the writer returns nothing twice', async () => {
    const { writer, write } = scriptedWriter([null, null]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await deliverMedicalReply({
      kind: 'health',
      parentWords: 'fever',
      where: 'intake health',
      region: 'BC',
      writer,
    });
    expect(body).toBeNull();
    expect(write).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
