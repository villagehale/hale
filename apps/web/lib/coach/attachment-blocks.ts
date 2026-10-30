import type Anthropic from '@anthropic-ai/sdk';

/**
 * The pure model-input helpers for Ask Hale attachments — bytes/mime → a native
 * Anthropic content block, and past-turn attachments → a plain-text marker. No LLM,
 * no DB, no I/O, so the mapping is unit-testable without a model (rule #8: the agent
 * loop's QUALITY is an eval; this deterministic plumbing is asserted directly).
 */

/** The image mimes the Anthropic image block can carry as base64 (heic is NOT one). */
const IMAGE_BLOCK_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * A single attachment as a content block for the CURRENT turn's user message.
 * Images the Anthropic block supports ride as native image blocks and PDFs as native
 * document blocks — the model sees the real bytes. A HEIC (stored + viewable via a
 * signed URL, but not a media_type the Anthropic image block accepts) degrades to a
 * text marker so a request never 400s and the raw bytes are never sent to the model.
 */
export function attachmentContentBlock(bytes: Buffer, mime: string): Anthropic.ContentBlockParam {
  const data = bytes.toString('base64');
  if (IMAGE_BLOCK_MIMES.has(mime)) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/png' | 'image/webp', data },
    };
  }
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'text', text: `[attachment: ${mime} — not viewable by the assistant]` };
}

/** The plain-text stand-in for a PAST turn's attachment — never the bytes (rule #1,
 * and to avoid re-sending the same image every turn). */
export function attachmentMarker(mime: string): string {
  return `[attachment: ${mime}]`;
}

interface TranscriptRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Enriches a replayed transcript with a `[attachment: <mime>]` marker per past
 * attachment, so the model knows a prior turn carried a file without the bytes being
 * re-sent. Pure: the message id is used only to look up its mimes and is dropped from
 * the returned turns. A message with no attachments passes through unchanged.
 */
export function applyAttachmentMarkers(
  rows: readonly TranscriptRow[],
  mimesByMessageId: ReadonlyMap<string, readonly string[]>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return rows.map((row) => {
    const mimes = mimesByMessageId.get(row.id);
    if (!mimes || mimes.length === 0) {
      return { role: row.role, content: row.content };
    }
    const markers = mimes.map(attachmentMarker).join(' ');
    const content = row.content.length > 0 ? `${row.content} ${markers}` : markers;
    return { role: row.role, content };
  });
}
