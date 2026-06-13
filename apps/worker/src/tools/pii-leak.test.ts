import { describe, expect, it } from 'vitest';
import { invokeReviewerTool } from './registry.js';
import type { PiiLeakOutput } from '@haru/tools-contracts';

/**
 * Rule #1 — check_pii_leak must detect all six declared kinds, not just SIN +
 * DOB. Hand-derived cases per kind, both directions: a positive that must trip
 * the detector and a clean control that must pass. check_pii_leak does no I/O,
 * so it runs without a DB.
 */

const FAMILY_ID = '00000000-0000-0000-0000-000000000001';

async function scan(content: string, knownChildNames?: string[]): Promise<PiiLeakOutput> {
  const result = await invokeReviewerTool('check_pii_leak', {
    familyId: FAMILY_ID,
    content,
    allowedRecipients: [],
    ...(knownChildNames ? { knownChildNames } : {}),
  });
  return result.result as PiiLeakOutput;
}

function kinds(out: PiiLeakOutput): string[] {
  return out.detections.map((d) => d.kind);
}

describe('check_pii_leak — phone (NANP)', () => {
  it('detects a NANP number with dashes', async () => {
    const out = await scan('call me at 416-555-0182 tomorrow');
    expect(kinds(out)).toContain('phone');
  });

  it('detects a NANP number in (xxx) xxx-xxxx form', async () => {
    const out = await scan('reach the clinic on (604) 555 0199');
    expect(kinds(out)).toContain('phone');
  });

  it('passes clean text with no phone number', async () => {
    const out = await scan('the appointment is confirmed for next week');
    expect(kinds(out)).not.toContain('phone');
  });
});

describe('check_pii_leak — address (CA postal code + street heuristic)', () => {
  it('detects a Canadian postal code', async () => {
    const out = await scan('we live at K1A 0B1 now');
    expect(kinds(out)).toContain('address');
  });

  it('detects a street address pattern', async () => {
    const out = await scan('drop it at 123 Maple Street');
    expect(kinds(out)).toContain('address');
  });

  it('passes text with a bare number that is not an address', async () => {
    const out = await scan('the baby is 8 weeks old and 5 kg');
    expect(kinds(out)).not.toContain('address');
  });
});

describe('check_pii_leak — medical_record (MRN / health card / OHIP)', () => {
  it('detects an OHIP number (#### ### ### format)', async () => {
    const out = await scan('health card 1234 567 890 on file');
    expect(kinds(out)).toContain('medical_record');
  });

  it('detects an MRN-labelled record number', async () => {
    const out = await scan('see chart MRN: 88213394');
    expect(kinds(out)).toContain('medical_record');
  });

  it('passes clean clinical prose with no record number', async () => {
    const out = await scan('the pediatrician recommends a follow-up in two weeks');
    expect(kinds(out)).not.toContain('medical_record');
  });
});

describe('check_pii_leak — child_full_name (case-insensitive whole word)', () => {
  it('detects a known child name regardless of case', async () => {
    const out = await scan('forwarding the note about EMMA to grandma', ['Emma']);
    expect(kinds(out)).toContain('child_full_name');
  });

  it('does not match a name substring inside another word', async () => {
    const out = await scan('the dilemma is what to cook', ['Emma']);
    expect(kinds(out)).not.toContain('child_full_name');
  });

  it('passes when the content does not contain the child name', async () => {
    const out = await scan('the order shipped today', ['Emma']);
    expect(kinds(out)).not.toContain('child_full_name');
  });

  it('flags namesUnavailable when no child names are supplied', async () => {
    const out = await scan('forwarding the note about Emma to grandma');
    expect(out.namesUnavailable).toBe(true);
    expect(kinds(out)).not.toContain('child_full_name');
  });
});

describe('check_pii_leak — still detects SIN and DOB (regression)', () => {
  it('detects a SIN', async () => {
    const out = await scan('SIN is 123-456-789');
    expect(kinds(out)).toContain('sin');
  });

  it('detects a full DOB', async () => {
    const out = await scan('born 2025-01-15');
    expect(kinds(out)).toContain('child_dob');
  });
});

describe('check_pii_leak — ok flag tracks detections', () => {
  it('ok:false when anything is detected', async () => {
    const result = await invokeReviewerTool('check_pii_leak', {
      familyId: FAMILY_ID,
      content: 'SIN 123-456-789',
      allowedRecipients: [],
    });
    expect(result.ok).toBe(false);
  });

  it('ok:true on fully clean text', async () => {
    const result = await invokeReviewerTool('check_pii_leak', {
      familyId: FAMILY_ID,
      content: 'thanks, see you at the visit',
      allowedRecipients: [],
      knownChildNames: ['Emma'],
    });
    expect(result.ok).toBe(true);
  });
});
