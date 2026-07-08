import { useState } from 'react';
import { Linking, Platform, Pressable, Share, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { VillageCandidateView } from '@/lib/api-types';
import { foundStamp } from '@/lib/format';

/** Maps a failed action (accept / endorse / share) to an honest, parent-facing
 * line (mirrors web + the Village ShareRow). A 401 never lands here — api()
 * redirects to sign-in. */
function actionErrorMessage(status: number): string {
  if (status === 404) return 'This one is no longer available.';
  if (status === 403 || status === 501) return "That isn't available for this one.";
  return "Couldn't do that just now — try again in a moment.";
}

/** A pill-style action row (Accept / Endorse / Share / Maps / Source), matching the
 * Village ShareRow shape. `filled` marks the primary Accept. */
function ActionButton({
  icon,
  label,
  onPress,
  disabled = false,
  filled = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
}) {
  const inkIcon = useMeadowColor('ink2');
  const onInk = useMeadowColor('onAccent');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 flex-row items-center gap-2 rounded-full border px-4 py-2.5 ${
        filled ? 'border-ink bg-ink' : 'border-rule bg-raised'
      } ${disabled ? 'opacity-50' : 'active:opacity-80'}`}
    >
      <Icon name={icon} size={15} color={filled ? onInk : inkIcon} />
      <AppText variant="meta" className={filled ? 'text-on-ink' : 'text-ink-2'}>
        {label}
      </AppText>
    </Pressable>
  );
}

/**
 * The shared Village detail sheet — one component behind BOTH Home's "from the
 * village" card and the Village tab's RecCard. Shows the pick's title / kind /
 * cadence / seasons / summary / coverage / venue, then the actions wired EXACTLY
 * like the Village ShareRow: Accept and Endorse POST their hrefs via api(); Share
 * mints a link then hands it to the native Share sheet; "Open in Maps" opens the
 * public venue coordinates via Linking (never the family's address — rule #1); the
 * sourceUrl opens as an external link. Accepting does NOT add the activity to the
 * week — it re-enters the pipeline as a draft the parent must approve (rule #4), so
 * the post-accept pill reads "Sent for your approval", never "added to your week"
 * (mirrors the web AcceptButton). A teen-redacted card never opens a detail (guarded
 * at the call site AND here as a fail-closed backstop — rule #1).
 */
export function VillageDetailSheet({
  rec,
  visible,
  onClose,
  onChanged,
}: {
  rec: VillageCandidateView | null;
  visible: boolean;
  onClose: () => void;
  /** Called after a successful accept/endorse so the caller can refresh its feed. */
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [endorsed, setEndorsed] = useState(false);
  const accentIcon = useMeadowColor('accentFill');

  // Fail closed: a redacted card carries no raw fields, so never render a detail
  // for it even if a caller slips one through (rule #1).
  if (!rec || rec.teenAttributed) return null;

  const isAccepted = accepted || rec.accepted;
  const isEndorsed = endorsed || rec.endorsedByFamily;
  const hasPin = rec.lat !== null && rec.lng !== null;

  const runAction = async (href: string, onOk: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await api(href, { method: 'POST' });
      onOk();
      onChanged?.();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError(actionErrorMessage(e instanceof ApiError ? e.status : 0));
      }
    } finally {
      setBusy(false);
    }
  };

  const onShare = async () => {
    setBusy(true);
    setError(null);
    let link: string;
    try {
      ({ link } = await api<{ link: string }>(rec.shareHref, { method: 'POST' }));
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError(actionErrorMessage(e instanceof ApiError ? e.status : 0));
      }
      setBusy(false);
      return;
    }
    try {
      await Share.share(Platform.OS === 'ios' ? { url: link } : { message: link });
    } catch {
      setError("Couldn't open the share sheet — try again.");
    } finally {
      setBusy(false);
    }
  };

  const openMaps = () => {
    // A geo: URI on Android, an Apple Maps URL on iOS — the public venue point only.
    const label = encodeURIComponent(rec.venueName ?? rec.title);
    const url =
      Platform.OS === 'ios'
        ? `http://maps.apple.com/?ll=${rec.lat},${rec.lng}&q=${label}`
        : `geo:${rec.lat},${rec.lng}?q=${rec.lat},${rec.lng}(${label})`;
    Linking.openURL(url).catch(() => setError("Couldn't open Maps."));
  };

  const openSource = () => {
    if (rec.sourceUrl) Linking.openURL(rec.sourceUrl).catch(() => setError("Couldn't open the link."));
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View className="mb-3 flex-row items-start justify-between gap-3">
        <AppText variant="title" className="flex-1">
          {rec.title}
        </AppText>
        <Tag label={rec.kind} tone="coach" />
      </View>

      <AppText variant="meta" className="mb-3 text-ink-3">
        {foundStamp(rec.discoveredAt)}
        {rec.cadence ? ` · ${rec.cadence}` : ''}
        {rec.seasons && rec.seasons.length > 0 ? ` · ${rec.seasons.join(', ')}` : ''}
      </AppText>

      {rec.endorsementCount > 0 ? (
        <AppText variant="meta" className="mb-3">
          Recommended by {rec.endorsementCount}{' '}
          {rec.endorsementCount === 1 ? 'family' : 'families'}
        </AppText>
      ) : null}

      <AppText variant="body" className="mb-4">
        {rec.summary}
      </AppText>

      {rec.venueName ? (
        <View className="mb-3 flex-row items-center gap-2">
          <Icon name="mappin.and.ellipse" size={15} color={accentIcon} />
          <AppText variant="meta" className="flex-1 text-ink-2">
            {rec.venueName}
          </AppText>
        </View>
      ) : null}

      {rec.coverageNote ? (
        <AppText variant="meta" className="mb-4 text-ink-3">
          {rec.coverageNote}
        </AppText>
      ) : null}

      {isAccepted ? (
        <View className="mb-4 h-7 items-center justify-center self-start rounded-full bg-sage-tint px-3">
          <AppText variant="meta" className="leading-none text-sage">
            Sent for your approval
          </AppText>
        </View>
      ) : null}

      <View className="flex-row flex-wrap gap-2">
        {!isAccepted ? (
          <ActionButton
            icon="checkmark"
            label={busy ? 'Working…' : 'Accept'}
            filled
            disabled={busy}
            onPress={() => runAction(rec.acceptHref, () => setAccepted(true))}
          />
        ) : null}
        <ActionButton
          icon="checkmark.circle"
          label={isEndorsed ? 'Endorsed' : 'Endorse'}
          disabled={busy || isEndorsed}
          onPress={() => runAction(rec.endorseHref, () => setEndorsed(true))}
        />
        <ActionButton
          icon="square.and.arrow.up"
          label={busy ? 'Making a link…' : 'Share'}
          disabled={busy}
          onPress={onShare}
        />
        {hasPin ? (
          <ActionButton icon="map" label="Open in Maps" onPress={openMaps} />
        ) : null}
        {rec.sourceUrl ? (
          <ActionButton icon="arrow.up.right.square" label="Source" onPress={openSource} />
        ) : null}
      </View>

      {error ? (
        <AppText variant="meta" className="mt-3 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
    </Sheet>
  );
}
