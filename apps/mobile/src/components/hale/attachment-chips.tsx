import { ActivityIndicator, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { TONE_BG, TONE_ICON } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import { type PendingAttachment, formatAttachmentSize } from '@/lib/ask-attachments';

/**
 * The composer attachment tray (handoff Feature 4): a wrapping row of pills, each a
 * tinted doc-glyph tile + middle-ellipsized name + human size + a ✕ remove. The tile
 * carries the upload state — a spinner while it uploads, the doc glyph once it lands,
 * a retry glyph (or a terminal ✕) if it failed. Hidden entirely when the tray is
 * empty. All file bytes stay on the device until the picker uploads them; this only
 * renders the name/size the picker reported (or the server confirmed).
 */
export function AttachmentChips({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: PendingAttachment[];
  onRemove: (localId: string) => void;
  onRetry: (batchId: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <View className="mb-2.5 flex-row flex-wrap gap-2">
      {attachments.map((a) => (
        <AttachmentChipRow
          key={a.localId}
          attachment={a}
          onRemove={() => onRemove(a.localId)}
          onRetry={() => onRetry(a.batchId)}
        />
      ))}
    </View>
  );
}

function AttachmentChipRow({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const toneColor = useMeadowColor(TONE_ICON[attachment.tone]);
  const removeColor = useMeadowColor('ink3');
  const { name, status, retryable } = attachment;

  const sub =
    status === 'uploading'
      ? 'Uploading…'
      : status === 'error'
        ? retryable
          ? 'Tap to retry'
          : "Couldn't add"
        : formatAttachmentSize(attachment.sizeBytes);

  const tile = (
    <View
      className={`h-[26px] w-[26px] items-center justify-center rounded-[8px] ${TONE_BG[attachment.tone]}`}
    >
      {status === 'uploading' ? (
        <ActivityIndicator size="small" color={toneColor} />
      ) : status === 'error' ? (
        <Icon name={retryable ? 'rotate-ccw' : 'circle-x'} size={retryable ? 13 : 14} color={toneColor} />
      ) : (
        <Icon name="file" size={13} color={toneColor} />
      )}
    </View>
  );

  return (
    <View
      className="flex-row items-center gap-2 rounded-[12px] border border-rule bg-card py-[7px] pl-[10px] pr-[9px]"
      style={{ maxWidth: 210 }}
    >
      {status === 'error' && retryable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Retry uploading ${name}`}
          onPress={onRetry}
          hitSlop={6}
          className="active:opacity-70"
        >
          {tile}
        </Pressable>
      ) : (
        tile
      )}
      <View className="min-w-0 flex-1">
        <AppText
          variant="body"
          numberOfLines={1}
          ellipsizeMode="middle"
          className="text-[12.5px] text-ink"
          style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
        >
          {name}
        </AppText>
        <AppText
          variant="meta"
          numberOfLines={1}
          className={`text-[10.5px] ${status === 'error' ? 'text-berry' : 'text-caption'}`}
        >
          {sub}
        </AppText>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${name}`}
        onPress={onRemove}
        hitSlop={6}
        className="active:opacity-70"
      >
        <Icon name="x" size={13} color={removeColor} />
      </Pressable>
    </View>
  );
}
