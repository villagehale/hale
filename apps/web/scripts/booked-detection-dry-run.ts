#!/usr/bin/env tsx
// Offline dry-run for booked detection. Reads a JSON file of synthetic email
// envelopes and prints one verdict per email.
//
//   pnpm --filter @hale/web booked-detection:dry-run scripts/fixtures/booked-detection/envelopes.json
//
// ANTHROPIC_API_KEY must be set — this calls the real classifyChildEventEmail
// extractor (skills off disk). It writes no booking row and sends no SMS. Do not
// point it at a real mailbox export; the fixture set is invented providers only.

import { readFileSync } from 'node:fs';
import {
  type DryRunEnvelope,
  runBookedDetectionDryRun,
} from '../lib/integrations/booked-detection-dry-run';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '../lib/pipeline/client';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx scripts/booked-detection-dry-run.ts <envelopes.json>');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    'ANTHROPIC_API_KEY is not set. This dry-run calls the extractor and writes nothing.',
  );
  process.exit(1);
}

const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
const emails = envelopesFrom(parsed);
const client = budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS);

try {
  const verdicts = await runBookedDetectionDryRun(emails, { client });
  console.info(JSON.stringify(verdicts, null, 2));
} catch (err) {
  const name = err instanceof Error ? err.constructor.name : 'unknown';
  console.error(`dry-run failed: ${name}`);
  process.exit(1);
}

function envelopesFrom(parsed: unknown): DryRunEnvelope[] {
  if (parsed === null || typeof parsed !== 'object' || !('emails' in parsed)) {
    throw new Error('fixture must be { emails: [...] }');
  }
  const emails = (parsed as { emails: unknown }).emails;
  if (!Array.isArray(emails)) throw new Error('fixture emails must be an array');
  return emails.map((row, index) => {
    if (row === null || typeof row !== 'object') {
      throw new Error(`email ${index} is not an object`);
    }
    const email = row as Record<string, unknown>;
    for (const key of ['id', 'sender', 'subject', 'snippet', 'date'] as const) {
      if (typeof email[key] !== 'string' || email[key] === '') {
        throw new Error(`email ${index} is missing ${key}`);
      }
    }
    const body = email.body;
    if (body !== undefined && typeof body !== 'string') {
      throw new Error(`email ${index} body must be a string`);
    }
    return {
      id: email.id as string,
      sender: email.sender as string,
      subject: email.subject as string,
      snippet: email.snippet as string,
      date: email.date as string,
      ...(typeof body === 'string' ? { body } : {}),
    };
  });
}
