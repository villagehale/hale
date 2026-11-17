import type { AgentClient } from '@hale/agent';
import { isEnabled } from '@hale/flags';
import { type InboundMediaPart, readInboundMedia } from '~/lib/channel/inbound-media';
import { extractInboundPhotoFacts } from '~/lib/channel/inbound-photo-facts';
import type { PhotoFacts } from '~/lib/channel/inbound-photo-facts-read';
import { heicToJpeg } from './heic-jpeg';

/**
 * VIL-413 — a photo a parent sends during intake, including an iPhone HEIC.
 *
 * Dark (`INTAKE_PHOTO_READ_ENABLED` unset): intake does not fetch the image.
 * Lit, on a 1:1 turn, the bytes are read (HEIC becomes JPEG first) and the
 * same photo-facts tool the coach uses returns what is visible. This writes
 * no sentence. A miss is `{ unread: true }` and the friend voice is told that.
 */

export const INTAKE_PHOTO_READ_ENABLED_ENV = 'INTAKE_PHOTO_READ_ENABLED';

/** Exact `true`. A trailing newline stays off. */
export function intakePhotoReadEnabled(): boolean {
  return isEnabled('intake-photo-read');
}

export type IntakePhotoForVoice = { read: 'facts'; facts: PhotoFacts } | { read: 'unread' };

export async function readIntakePhoto(input: {
  media: readonly InboundMediaPart[];
  parentWords: string;
  now: Date;
  timeZone: string | null;
  client: AgentClient;
  fetchImpl?: typeof fetch;
}): Promise<IntakePhotoForVoice> {
  const images = input.media.some((part) => part.kind === 'image');
  if (!images) return { read: 'unread' };
  let blocks: Awaited<ReturnType<typeof readInboundMedia>>['blocks'] = [];
  try {
    const read = await readInboundMedia(input.media, input.fetchImpl, undefined, undefined, {
      convertHeic: heicToJpeg,
    });
    blocks = read.blocks;
  } catch (err) {
    console.info(
      { reason: 'fetch_failed', err: err instanceof Error ? err.name : 'unknown' },
      'intake photo: unread',
    );
    return { read: 'unread' };
  }
  if (blocks.length === 0) return { read: 'unread' };
  try {
    const facts = await extractInboundPhotoFacts({
      client: input.client,
      blocks,
      parentWords: input.parentWords,
      now: input.now,
      timeZone: input.timeZone,
    });
    if (!facts) return { read: 'unread' };
    return { read: 'facts', facts };
  } catch (err) {
    console.info(
      { reason: 'extract_failed', err: err instanceof Error ? err.name : 'unknown' },
      'intake photo: unread',
    );
    return { read: 'unread' };
  }
}
