import { invokeTool } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { readRegistrationPageTool } from './registration-tool';

const WATCH = {
  id: '44444444-4444-4444-8444-444444444444',
  town: 'Richmond Hill',
  programs: 'Winter 2026-2027',
  sourceUrl: 'https://www.richmondhill.ca/recreation',
  optIn: 'opted_in' as const,
  outcome: null,
};
const READING = {
  town: WATCH.town,
  programs: WATCH.programs,
  opensFor: '2026-12-01 (opening time not published) America/Toronto',
  residentsFirst: false,
  residentOpens: '2026-11-24 (opening time not published) America/Toronto',
  generalOpens: '2026-12-01 (opening time not published) America/Toronto',
  ageApproximate: false,
  watching: true,
  sourceUrl: WATCH.sourceUrl,
};

function harness() {
  const read = vi.fn(async () => READING);
  const onRead = vi.fn();
  const tool = readRegistrationPageTool({ watches: [WATCH], read, onRead });
  const call = (watchId: string) =>
    invokeTool(
      tool,
      { watchId },
      { familyId: 'family', actor: 'parent' },
      { writeAudit: async () => {} },
    );
  return { read, onRead, tool, call };
}

describe('read_registration_page', () => {
  it('does no network I/O until invoked, then returns live facts and protects their source', async () => {
    const h = harness();
    expect(h.read).not.toHaveBeenCalled();
    expect(await h.call(WATCH.id)).toEqual({ registrationWindows: [READING] });
    expect(h.read).toHaveBeenCalledWith(WATCH.id);
    expect(h.onRead).toHaveBeenCalledWith(READING);
  });

  it('rejects a watch not in this family before reading or reporting a source', async () => {
    const h = harness();
    await expect(h.call('55555555-5555-4555-8555-555555555555')).rejects.toThrow('this family');
    expect(h.read).not.toHaveBeenCalled();
    expect(h.onRead).not.toHaveBeenCalled();
  });

  it('reuses a read within this turn, but reads fresh on the next turn', async () => {
    const h = harness();
    await Promise.all([h.call(WATCH.id), h.call(WATCH.id)]);
    expect(h.read).toHaveBeenCalledTimes(1);
    const next = readRegistrationPageTool({ watches: [WATCH], read: h.read, onRead: h.onRead });
    await invokeTool(
      next,
      { watchId: WATCH.id },
      { familyId: 'family', actor: 'parent' },
      { writeAudit: async () => {} },
    );
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('surfaces a disappeared watch rather than reusing an earlier date', async () => {
    const onRead = vi.fn();
    const tool = readRegistrationPageTool({ watches: [WATCH], read: async () => null, onRead });
    await expect(
      invokeTool(
        tool,
        { watchId: WATCH.id },
        { familyId: 'family', actor: 'parent' },
        { writeAudit: async () => {} },
      ),
    ).rejects.toThrow('no longer active');
    expect(onRead).not.toHaveBeenCalled();
  });

  it('returns a failed verification with its source, not a cached opening date', async () => {
    const reading = {
      ...READING,
      opensFor: 'Current date could not be verified (unreadable). Do not use a cached date.',
      residentOpens: null,
      generalOpens: null,
      reminderState: 'paused' as const,
    };
    const onRead = vi.fn();
    const tool = readRegistrationPageTool({ watches: [WATCH], read: async () => reading, onRead });
    const result = await invokeTool(
      tool,
      { watchId: WATCH.id },
      { familyId: 'family', actor: 'parent' },
      { writeAudit: async () => {} },
    );
    expect(result).toEqual({ registrationWindows: [reading] });
    expect(onRead).toHaveBeenCalledWith(reading);
  });
});
