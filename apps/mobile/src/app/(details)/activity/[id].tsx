import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, Pressable, Share, View } from 'react-native';

import { DetailSuccess } from '@/components/hale/detail-success';
import { VillageMap } from '@/components/hale/village-map';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader, type OverflowAction } from '@/components/ui/detail-header';
import { Icon, type IconName } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { MobileVillageCandidateResponse, VillageCandidateView } from '@/lib/api-types';
import { foundStamp, indoorOutdoorLabel, priceBandLabel } from '@/lib/format';
import { registerLinkHref } from '@/lib/register-link';
import { useApi } from '@/lib/use-api';
import { useMapThumbnail } from '@/lib/use-map-thumbnail';

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
 * The honest, presence-gated metadata row: a VERIFIED Places rating (a real number
 * + count, never fabricated stars), then the model's coarse price band, age hint,
 * and indoor/outdoor tag — each a small Tag ONLY when a real value is present.
 * Renders nothing when every field is null. A teen-redacted card never reaches
 * here (guarded above), and its fields are nulled at the mapper anyway (rule #1).
 */
function MetaChips({ rec }: { rec: VillageCandidateView }) {
  const price = priceBandLabel(rec.priceLevel);
  const place = indoorOutdoorLabel(rec.indoorOutdoor);
  const hasRating = rec.rating !== null;
  if (!hasRating && !price && !rec.ageRange && !place) return null;
  return (
    <View className="mb-4 flex-row flex-wrap gap-2">
      {hasRating ? (
        <Tag
          label={
            rec.ratingCount !== null ? `★ ${rec.rating} (${rec.ratingCount})` : `★ ${rec.rating}`
          }
          tone="accent"
        />
      ) : null}
      {price ? <Tag label={price} /> : null}
      {rec.ageRange ? <Tag label={rec.ageRange} /> : null}
      {place ? <Tag label={place} /> : null}
    </View>
  );
}

/** A follow-up row inside the "You're interested!" success card (prototype: label +
 * trailing chevron). A completed row (a drafted approval) swaps the chevron for a
 * green check and reads its honest resolved label — never a fake "done". */
function SuccessRow({
  label,
  onPress,
  disabled = false,
  done = false,
  divider = true,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  done?: boolean;
  divider?: boolean;
}) {
  const chevron = useMeadowColor('ink3');
  const check = useMeadowColor('chipGreenIcon');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 flex-row items-center gap-3 px-4 py-3.5 active:opacity-70 ${
        divider ? 'border-b border-hairline' : ''
      } ${disabled && !done ? 'opacity-50' : ''}`}
    >
      <AppText
        className="flex-1 text-[14px] text-ink"
        style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
      >
        {label}
      </AppText>
      <Icon
        name={done ? 'circle-check' : 'chevron-right'}
        size={done ? 15 : 14}
        color={done ? check : chevron}
      />
    </Pressable>
  );
}

/**
 * The Activity detail body (moved from VillageDetailSheet): the pick's title / kind /
 * cadence / seasons / summary / coverage / venue, then the actions wired EXACTLY like
 * the Village ShareRow — Accept and Endorse POST their hrefs via api(); "I'm
 * interested" privately toggles a save (never surfaced, neither enrolls nor sends for
 * approval); Share mints a link then hands it to the native Share sheet; "Open in
 * Maps" opens the PUBLIC venue coordinates (never the family's address — rule #1);
 * Register always resolves (source URL or a Google-search fallback). Accepting does
 * NOT add the activity to the week — it re-enters the pipeline as a draft the parent
 * must approve (rule #4), so the post-accept line reads "Sent for your approval". Only
 * ever mounted for a non-teen rec (the route guards teenAttributed above — rule #1).
 */
function ActivityBody({ rec }: { rec: VillageCandidateView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [endorsed, setEndorsed] = useState(false);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [interested, setInterested] = useState(false);
  const accentIcon = useMeadowColor('accentFill');
  // Web-only: native renders the interactive expo-maps view and ignores the static
  // thumbnail. This body only mounts for a non-teen rec, so the id is safe to fetch.
  const mapUri = useMapThumbnail(Platform.OS === 'web' ? rec.id : null);

  const isAccepted = accepted || rec.accepted;
  const isEndorsed = endorsed || rec.endorsedByFamily;
  const isSaved = saved ?? rec.saved;
  const hasPin = rec.lat !== null && rec.lng !== null;
  const registerUrl = registerLinkHref(rec.sourceUrl, rec.title);

  const runAction = async (href: string, onOk: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await api(href, { method: 'POST' });
      onOk();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError(actionErrorMessage(e instanceof ApiError ? e.status : 0));
      }
    } finally {
      setBusy(false);
    }
  };

  // "I'm interested" is the real save (rec.saveHref, a private bookmark — never an
  // enrollment or an approval). A FRESH save opens the inline "You're interested!"
  // state; tapping again on an already-saved pick un-saves it (the toggle survives).
  const onInterested = async () => {
    setBusy(true);
    setError(null);
    try {
      const { saved: nowSaved } = await api<{ saved: boolean }>(rec.saveHref, { method: 'POST' });
      setSaved(nowSaved);
      if (nowSaved) setInterested(true);
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
    const label = encodeURIComponent(rec.venueName ?? rec.title);
    const url =
      Platform.OS === 'ios'
        ? `http://maps.apple.com/?ll=${rec.lat},${rec.lng}&q=${label}`
        : `geo:${rec.lat},${rec.lng}?q=${rec.lat},${rec.lng}(${label})`;
    Linking.openURL(url).catch(() => setError("Couldn't open Maps."));
  };

  const openRegister = () => {
    Linking.openURL(registerUrl).catch(() => setError("Couldn't open the link."));
  };

  if (interested) {
    return (
      <DetailSuccess
        headline="You're interested!"
        subcopy="Saved to your list — find it anytime under Saved."
        primaryLabel="Done"
        onPrimary={() => router.back()}
      >
        <Card className="gap-0 overflow-hidden p-0">
          {/* "Add to calendar" runs the real Accept — it re-enters the pipeline as a
              draft the parent must approve (rule #4), so its resolved label is the
              honest "Sent for your approval", never a fake calendar write. */}
          <SuccessRow
            label={isAccepted ? 'Sent for your approval' : 'Add to calendar'}
            done={isAccepted}
            disabled={busy || isAccepted}
            onPress={() => runAction(rec.acceptHref, () => setAccepted(true))}
          />
          <SuccessRow
            label="Share with a friend"
            disabled={busy}
            divider={false}
            onPress={onShare}
          />
        </Card>
        {error ? (
          <AppText variant="meta" className="mt-3 text-berry" accessibilityLiveRegion="polite">
            {error}
          </AppText>
        ) : null}
      </DetailSuccess>
    );
  }

  return (
    <>
      <View className="mb-3 flex-row items-start justify-between gap-3">
        <AppText variant="title" className="flex-1">
          {rec.title}
        </AppText>
        <Tag label={rec.kind} tone="coach" />
      </View>

      {/* The venue map: on native an INTERACTIVE expo-maps view plotting the PUBLIC
          venue pin (rule #1: a public place, never the family's home); on RN-web it
          degrades to the static thumbnail. Renders NOTHING when there is no coordinate
          or thumbnail — never a broken/empty map box. */}
      <VillageMap candidate={rec} staticMapUri={mapUri} />

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

      <MetaChips rec={rec} />

      {rec.venueName ? (
        <View className="mb-3 flex-row items-center gap-2">
          <Icon name="map-pin" size={15} color={accentIcon} />
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
        <AppText variant="meta" className="mb-4 self-start text-ink-3">
          Sent for your approval
        </AppText>
      ) : null}

      <View className="flex-row flex-wrap gap-2">
        {!isAccepted ? (
          <ActionButton
            icon="check"
            label={busy ? 'Working…' : 'Accept'}
            filled
            disabled={busy}
            onPress={() => runAction(rec.acceptHref, () => setAccepted(true))}
          />
        ) : null}
        <ActionButton
          icon={isSaved ? 'bookmark-check' : 'bookmark'}
          label={isSaved ? 'Saved' : "I'm interested"}
          disabled={busy}
          onPress={onInterested}
        />
        <ActionButton
          icon="circle-check"
          label={isEndorsed ? 'Endorsed' : 'Endorse'}
          disabled={busy || isEndorsed}
          onPress={() => runAction(rec.endorseHref, () => setEndorsed(true))}
        />
        <ActionButton
          icon="share"
          label={busy ? 'Making a link…' : 'Share'}
          disabled={busy}
          onPress={onShare}
        />
        {hasPin ? <ActionButton icon="map" label="Open in Maps" onPress={openMaps} /> : null}
        <ActionButton icon="square-arrow-out-up-right" label="Register" onPress={openRegister} />
      </View>

      {isSaved ? (
        <AppText variant="meta" className="mt-3 text-ink-3">
          Saved privately — just for you. It&rsquo;s not enrolled or sent for approval.
        </AppText>
      ) : null}

      {error ? (
        <AppText variant="meta" className="mt-3 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
    </>
  );
}

/** The fail-closed teen state (rule #1): a 13+ child's activity surfaces its category
 * only — never the raw title/summary/venue — even on a direct deep-link. Mirrors the
 * Saved screen's locked card copy. This is the route's guard: raw content is NEVER
 * rendered for a teen-attributed id. */
function TeenRedactedCard({ rec }: { rec: VillageCandidateView }) {
  return (
    <Card className="gap-2">
      <Tag label="Redacted · teen privacy" tone="attention" />
      <AppText variant="meta">
        Category: {rec.kind}. Raw content is hidden by default to protect a teen&rsquo;s privacy.
      </AppText>
    </Card>
  );
}

/**
 * The pushed Activity-details route (sheet→stack conversion). Takes the candidate id
 * and re-reads /api/mobile/village/:id — one canonical, teen-redacted read (rule #1),
 * so any opener (Home, Village, Saved, the week) resolves the SAME way and a bad /
 * unknown id lands on an honest empty state, never a crash. The teenAttributed
 * fail-close survives as this route's guard: a redacted id renders category only,
 * deep-link included.
 */
export default function ActivityDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { status, data, error, reload } = useApi<MobileVillageCandidateResponse>(
    `/api/mobile/village/${id}`,
  );
  const rec = data?.candidate ?? null;
  const [menuError, setMenuError] = useState<string | null>(null);

  // A menu action's failure surfaces inline (mirroring the in-body Share), never
  // swallowed — except a 401, which the client already redirected on.
  const surface = (e: unknown, message: string) => {
    if (!(e instanceof ApiError) || e.status !== 401) setMenuError(message);
  };

  const helpItem: OverflowAction = {
    label: 'Get help',
    icon: 'circle-help',
    onPress: () => router.push('/ask'),
  };
  // Share/Save act on the pick's real content, so they're offered only for a
  // non-teen rec (rule #1 — a redacted item never gets a shareable link or a save).
  const menu: OverflowAction[] =
    rec && !rec.teenAttributed
      ? [
          {
            label: 'Share',
            icon: 'share',
            onPress: () => {
              void (async () => {
                try {
                  const { link } = await api<{ link: string }>(rec.shareHref, { method: 'POST' });
                  await Share.share(Platform.OS === 'ios' ? { url: link } : { message: link });
                } catch (e) {
                  surface(e, "Couldn't share just now — try again.");
                }
              })();
            },
          },
          {
            label: 'Save',
            icon: 'bookmark',
            onPress: () => {
              void api(rec.saveHref, { method: 'POST' }).catch((e) =>
                surface(e, "Couldn't save just now — try again."),
              );
            },
          },
          helpItem,
        ]
      : [helpItem];

  return (
    <Screen scroll className="gap-5">
      <DetailHeader title="Activity details" menu={menu} />
      {menuError ? (
        <AppText variant="meta" className="-mt-2 text-berry" accessibilityLiveRegion="polite">
          {menuError}
        </AppText>
      ) : null}
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && rec && rec.teenAttributed ? <TeenRedactedCard rec={rec} /> : null}
      {status === 'ready' && rec && !rec.teenAttributed ? <ActivityBody rec={rec} /> : null}
      {status === 'ready' && !rec ? (
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">Not available</AppText>
          <AppText variant="meta" className="text-center">
            This activity is no longer available. Head back to explore your village.
          </AppText>
        </Card>
      ) : null}
    </Screen>
  );
}
