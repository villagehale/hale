import type { ChipTone } from '@/components/ui/tint-chip';

/**
 * The pure logic behind Ask-Hale composer attachments (handoff Feature 4),
 * REPLICATED from the prototype's `addAttach`/`send` so the native bundle carries no
 * server code. Everything here is framework-free and unit-tested; the screen wires
 * the React state and the upload transport.
 */

/** At most 5 attachments per send — mirrors the web MAX_ATTACHMENTS_PER_REQUEST and
 * the /api/coach attachmentIds cap (apps/web/lib/coach/attachments.ts). */
export const MAX_ATTACHMENTS = 5;

/** The four doc-glyph tile tints, cycled by attachment index (handoff palette). */
const ATTACHMENT_TONES = ['red', 'blue', 'green', 'yellow'] as const satisfies readonly ChipTone[];

/** One composer attachment as it moves from picked → uploaded (or errored). */
export interface PendingAttachment {
  /** Stable per-chip key. */
  localId: string;
  /** The pick that produced this chip — a whole batch uploads (and retries) together. */
  batchId: string;
  name: string;
  sizeBytes: number;
  tone: ChipTone;
  status: 'uploading' | 'ready' | 'error';
  /** The picked file, kept so an errored batch can be re-uploaded. */
  file: { uri: string; name: string; type: string };
  /** Set once the upload lands — the id passed to /api/coach as attachmentIds. */
  serverId?: string;
  /** True when re-uploading could succeed (network/rate-limit), false for a
   * type/size rejection where the same file will always fail. */
  retryable?: boolean;
}

/** The tile tint for the Nth attachment, cycling the four handoff tones. */
export function attachmentTone(index: number): ChipTone {
  return ATTACHMENT_TONES[index % ATTACHMENT_TONES.length];
}

/** Human file size: ≥ 1,000,000 bytes → "X.X MB" (one decimal); else whole KB
 * (rounded, floored to 1 so a tiny file never reads "0 KB"). */
export function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The server ids of the attachments that finished uploading, in order. */
export function readyAttachmentIds(attachments: PendingAttachment[]): string[] {
  const ids: string[] = [];
  for (const a of attachments) {
    if (a.status === 'ready' && a.serverId) ids.push(a.serverId);
  }
  return ids;
}

/** Send is allowed with text OR at least one ready attachment — but never while an
 * upload is still in flight (no racing a half-uploaded send). */
export function canSendAsk(text: string, attachments: PendingAttachment[]): boolean {
  if (attachments.some((a) => a.status === 'uploading')) return false;
  return text.trim().length > 0 || attachments.some((a) => a.status === 'ready');
}

/** The /api/coach body fields for a send: the trimmed question (omitted when empty,
 * so an attachments-only send carries no fabricated placeholder) and the attachment
 * ids (omitted when none). */
export function buildCoachSendPayload(
  text: string,
  attachmentIds: string[],
): { question?: string; attachmentIds?: string[] } {
  const question = text.trim();
  return {
    ...(question ? { question } : {}),
    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
  };
}

/** Maps an upload failure to an honest inline note + whether a retry can help. A
 * type/size rejection is terminal (the same bytes always fail); a rate-limit or
 * transport failure is worth another try. */
export function uploadErrorMessage(
  status: number,
  code?: string,
): { note: string; retryable: boolean } {
  if (status === 415) {
    return {
      note: "That file type isn't supported yet — JPEG, PNG, WebP or PDF.",
      retryable: false,
    };
  }
  if (status === 413) {
    if (code === 'too_many_files') return { note: 'You can attach up to 5 files.', retryable: false };
    return { note: 'That file is over 10 MB.', retryable: false };
  }
  if (status === 429) {
    return { note: 'Too many uploads — try again in a minute.', retryable: true };
  }
  return { note: 'Upload failed — check your connection and try again.', retryable: true };
}
