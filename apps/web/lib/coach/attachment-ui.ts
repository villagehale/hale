/**
 * Ask composer attachment UI helpers (client-side display only — the bytes upload
 * to POST /api/coach/attachments and ride the send as attachmentIds).
 *
 * The attach affordance is gated behind ATTACHMENTS_ENABLED so this surface is
 * mergeable before the B4 attachments backend (feat/b4-chat-attachments) lands:
 * with it off the paperclip never renders and no upload is attempted; flip it to
 * true once the /api/coach/attachments route + attachmentIds param are on main.
 */
export const ATTACHMENTS_ENABLED = false;

/** Bytes → the chip's human size: ≥1,000,000 → "X.X MB" (one decimal); else KB,
 *  rounded and floored to at least 1 (design handoff §4.4 / mobile-diff §4). */
export function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The four matched icon-tint tones cycled per attachment index (design handoff
 *  §2.1 file-chip palette): terracotta, blue, green, amber — each a role token
 *  with a dark-mode value, so the chip is theme-safe (class → globals.css). */
export const ATTACHMENT_CHIP_TONES = ['berry', 'apricot', 'sage', 'amber'] as const;
export type AttachmentChipTone = (typeof ATTACHMENT_CHIP_TONES)[number];

export function attachmentChipTone(index: number): AttachmentChipTone {
  // index % length is always in [0, length), so the lookup is total.
  return ATTACHMENT_CHIP_TONES[index % ATTACHMENT_CHIP_TONES.length] as AttachmentChipTone;
}
