import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';

import { VillageDetailSheet } from '@/components/hale/village-detail-sheet';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import type {
  AuthoredPlanView,
  MobilePlanResponse,
  ScopeChild,
  VillageCandidateView,
} from '@/lib/api-types';
import { ApiError } from '@/lib/api-client';
import { completePlan, createPlan, deletePlan } from '@/lib/plan-api';
import { composeCreatePlan } from '@/lib/plan-compose';
import { buildPlanSpine } from '@/lib/plan-spine';
import { useApi } from '@/lib/use-api';

function SectionTitle({ children }: { children: string }) {
  return (
    <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
      {children}
    </AppText>
  );
}

/** The scope chip on a plan card — whole-family or the child's given name (teen-safe:
 * a scope chip disambiguates WHICH child, policy 1). */
function ScopeTag({ childId, childName }: { childId: string | null; childName: string | null }) {
  return <Tag label={childId === null ? 'whole family' : (childName ?? 'your teen')} tone="neutral" />;
}

/** A plan's bare-calendar date, read in UTC (scheduledFor is stored UTC-midnight, so
 * reading it in the local zone would shift the day). "Jul 10". */
function planDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A parent-authored plan card. An OPEN plan carries the "done" + delete affordances;
 * a SETTLED plan renders dimmed with delete only (it has left the active week and is
 * kept for the record). Orange is reserved for the primary "add" — the done/delete
 * here are ink / berry (berry only for the destructive delete). The teen-name
 * exemption holds: a parent's own plan about their teen renders in full (policy 2).
 */
function AuthoredPlanCard({
  plan,
  settled,
  busy,
  onComplete,
  onDelete,
}: {
  plan: AuthoredPlanView;
  settled?: boolean;
  busy: boolean;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const inkIcon = useMeadowColor('ink2');
  const deleteIcon = useMeadowColor('ink3');
  const when = plan.scheduledFor ? planDateLabel(plan.scheduledFor) : null;
  return (
    <Card className={`gap-2 ${settled ? 'opacity-60' : ''}`}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-row flex-wrap items-center gap-2">
          <ScopeTag childId={plan.childId} childName={plan.childName} />
          {when ? (
            <AppText variant="mono" className="text-ink-3">
              {when}
            </AppText>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete plan: ${plan.title}`}
          disabled={busy}
          onPress={() => onDelete(plan.id)}
          className="active:opacity-70"
        >
          <Icon name="trash" size={16} color={deleteIcon} />
        </Pressable>
      </View>
      <AppText variant="title">{plan.title}</AppText>
      {plan.notes ? <AppText variant="meta">{plan.notes}</AppText> : null}
      {!settled ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Mark done: ${plan.title}`}
          disabled={busy}
          onPress={() => onComplete(plan.id)}
          className="mt-1 min-h-11 flex-row items-center gap-2 self-start rounded-full border border-rule bg-card px-4 active:opacity-80"
        >
          <Icon name="checkmark" size={14} color={inkIcon} />
          <AppText variant="meta" className="text-ink-2">
            Mark done
          </AppText>
        </Pressable>
      ) : null}
    </Card>
  );
}

/** The inline "who is this for" scope selector: whole-family first, then each child.
 * Mirrors the growth sheet's segmented control — active = ink fill, read by label. */
function ScopePicker({
  kids,
  value,
  onChange,
}: {
  kids: ScopeChild[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const options: Array<{ id: string | null; label: string }> = [
    { id: null, label: 'whole family' },
    ...kids.map((k) => ({ id: k.id, label: k.label ?? 'your teen' })),
  ];
  return (
    <View className="gap-2">
      <SectionTitle>Who is this for</SectionTitle>
      <View className="flex-row flex-wrap gap-2">
        {options.map((opt) => {
          const active = opt.id === value;
          return (
            <Pressable
              key={opt.id ?? 'whole-family'}
              accessibilityRole="button"
              accessibilityLabel={opt.label}
              accessibilityState={active ? { selected: true } : {}}
              onPress={() => onChange(opt.id)}
              className={`h-11 items-center justify-center rounded-full border px-4 ${
                active ? 'border-ink bg-ink' : 'border-rule bg-card'
              }`}
            >
              <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                {opt.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** "Jul 10" / "no date" — the resolved plan date read back to the parent. */
function composerWhenLabel(when: Date | null): string {
  if (!when) return 'no date';
  return when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The AddPlan composer: a title, optional notes, an optional date, and a child scope.
 * Collapsed to a single orange "Add a plan" button until opened (orange is the ONE
 * primary action here). On save it composes the create body (client guard), POSTs via
 * createPlan, then refreshes the screen. Mirrors the web AddPlan.
 */
function AddPlan({ kids, onCreated }: { kids: ScopeChild[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [when, setWhen] = useState<Date | null>(null);
  const [childId, setChildId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');
  const onAccent = useMeadowColor('onAccent');
  const iconColor = useMeadowColor('ink3');

  const reset = () => {
    setTitle('');
    setNotes('');
    setWhen(null);
    setChildId(null);
    setShowPicker(false);
    setError(null);
  };

  const onPickerChange = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setShowPicker(false);
    if (event.type === 'set' && picked) setWhen(picked);
  };

  const save = async () => {
    const composed = composeCreatePlan({
      title,
      notes,
      // A picked Date → its local YYYY-MM-DD; the composer re-encodes it UTC-midnight.
      scheduledFor: when ? toDateKey(when) : '',
      childId,
    });
    if (!composed.ok) {
      setError(
        composed.error === 'title_required' ? 'Give the plan a title.' : 'That date looks off.',
      );
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await createPlan(composed.body);
      reset();
      setOpen(false);
      onCreated();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add a plan"
        onPress={() => setOpen(true)}
        className="min-h-12 flex-row items-center justify-center gap-2 self-start rounded-full bg-accent px-5 active:opacity-90"
      >
        <Icon name="plus" size={15} color={onAccent} />
        <AppText variant="meta" style={{ color: onAccent }}>
          Add a plan
        </AppText>
      </Pressable>
    );
  }

  return (
    <Card className="gap-4">
      <View className="gap-1.5">
        <AppText variant="meta" className="text-ink-2">
          What's the plan
        </AppText>
        <TextInput
          accessibilityLabel="What's the plan"
          value={title}
          onChangeText={(t) => {
            setTitle(t);
            setError(null);
          }}
          placeholder="swimming registration"
          placeholderTextColor={placeholderColor}
          style={{ color: inputColor, fontFamily: 'Inter_400Regular' }}
          className="min-h-11 rounded-md border border-rule bg-canvas px-4 py-3 text-[16px]"
          autoFocus
        />
      </View>

      <View className="gap-1.5">
        <AppText variant="meta" className="text-ink-2">
          Notes
        </AppText>
        <TextInput
          accessibilityLabel="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="anything you want to remember"
          placeholderTextColor={placeholderColor}
          multiline
          style={{ color: inputColor, fontFamily: 'Inter_400Regular', minHeight: 72 }}
          className="rounded-md border border-rule bg-canvas px-4 py-3 text-[16px]"
        />
      </View>

      <View className="gap-2">
        <SectionTitle>When</SectionTitle>
        {Platform.OS === 'web' ? (
          <View className="h-12 flex-row items-center gap-2.5 rounded-md border border-rule bg-card px-4">
            <Icon name="calendar" size={16} color={iconColor} />
            <AppText variant="body" className="text-ink">
              {composerWhenLabel(when)}
            </AppText>
          </View>
        ) : (
          <>
            <View className="flex-row gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Set a date"
                onPress={() => setShowPicker((s) => !s)}
                className="min-h-11 flex-1 flex-row items-center gap-2.5 rounded-md border border-rule bg-card px-4 active:opacity-80"
              >
                <Icon name="calendar" size={16} color={iconColor} />
                <AppText variant="body" className="text-ink">
                  {composerWhenLabel(when)}
                </AppText>
              </Pressable>
              {when ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear date"
                  onPress={() => {
                    setWhen(null);
                    setShowPicker(false);
                  }}
                  className="min-h-11 items-center justify-center rounded-md border border-rule bg-card px-4 active:opacity-80"
                >
                  <AppText variant="meta" className="text-ink-2">
                    Clear
                  </AppText>
                </Pressable>
              ) : null}
            </View>
            {showPicker ? (
              <View className="items-center">
                <DateTimePicker
                  value={when ?? new Date()}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'inline' : 'default'}
                  onChange={onPickerChange}
                />
              </View>
            ) : null}
          </>
        )}
      </View>

      <ScopePicker kids={kids} value={childId} onChange={setChildId} />

      {error ? (
        <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save plan"
          disabled={saving}
          onPress={save}
          className={`min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-accent px-5 ${
            saving ? 'opacity-50' : 'active:opacity-90'
          }`}
        >
          <Icon name="plus" size={15} color={onAccent} />
          <AppText variant="meta" style={{ color: onAccent }}>
            {saving ? 'Saving…' : 'Save plan'}
          </AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => {
            reset();
            setOpen(false);
          }}
          className="min-h-12 items-center justify-center rounded-full border border-rule bg-card px-5 active:opacity-80"
        >
          <AppText variant="meta" className="text-ink-2">
            Cancel
          </AppText>
        </Pressable>
      </View>
    </Card>
  );
}

/** A local Date → its local YYYY-MM-DD calendar key (the day the parent tapped),
 * which the composer re-encodes at UTC-midnight — the bare-calendar-date convention. */
function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function PlanBody({ data, onRefresh }: { data: MobilePlanResponse; onRefresh: () => void }) {
  const { authoredPlans, timeZone, scopeChildren, addedActivities, routine, childItems, hasPlan } =
    data;
  const [openRec, setOpenRec] = useState<VillageCandidateView | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const chevron = useMeadowColor('ink3');

  const spine = buildPlanSpine(authoredPlans, new Date(), timeZone);
  const datedDays = spine.days.filter((d) => d.plans.length > 0);
  const hasAuthored = datedDays.length > 0 || spine.undated.length > 0;

  const mutate = async (id: string, run: () => Promise<void>) => {
    setBusyPlanId(id);
    try {
      await run();
      onRefresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
    } finally {
      setBusyPlanId(null);
    }
  };
  const onComplete = (id: string) => mutate(id, () => completePlan(id));
  const onDelete = (id: string) => mutate(id, () => deletePlan(id));

  return (
    <>
      {/* ── Your own plans — the composer leads the surface ── */}
      <View className="gap-2">
        <SectionTitle>Your own plans</SectionTitle>
        <AddPlan kids={scopeChildren} onCreated={onRefresh} />
      </View>

      {/* ── Plans you've written — a Mon–Sun week spine ── */}
      {hasAuthored ? (
        <View className="gap-4">
          {datedDays.map((day) => (
            <View key={day.dateKey} className="gap-2">
              <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
                {day.weekday}
              </AppText>
              <View className="gap-3">
                {day.plans.map((plan) => (
                  <AuthoredPlanCard
                    key={plan.id}
                    plan={plan}
                    busy={busyPlanId === plan.id}
                    onComplete={onComplete}
                    onDelete={onDelete}
                  />
                ))}
              </View>
            </View>
          ))}

          {spine.undated.length > 0 ? (
            <View className="gap-2">
              <SectionTitle>Sometime this week</SectionTitle>
              <View className="gap-3">
                {spine.undated.map((plan) => (
                  <AuthoredPlanCard
                    key={plan.id}
                    plan={plan}
                    busy={busyPlanId === plan.id}
                    onComplete={onComplete}
                    onDelete={onDelete}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* ── Settled — completed or past, dimmed and kept in the trail ── */}
      {spine.settled.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>Settled</SectionTitle>
          <View className="gap-3">
            {spine.settled.map((plan) => (
              <AuthoredPlanCard
                key={plan.id}
                plan={plan}
                settled
                busy={busyPlanId === plan.id}
                onComplete={onComplete}
                onDelete={onDelete}
              />
            ))}
          </View>
        </View>
      ) : null}

      {!hasPlan ? (
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">A quiet week ahead</AppText>
          <AppText variant="meta" className="text-center">
            Nothing is scheduled yet. Add a plan above, or add activities in Village.
          </AppText>
        </Card>
      ) : null}

      {addedActivities.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>Added to your week</SectionTitle>
          <View className="gap-3">
            {addedActivities.map((activity) => (
              // The added activity is a full VillageCandidateView (rich fields already
              // in /api/mobile/plan), so it opens the SAME detail sheet as the feed.
              <Pressable
                key={activity.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${activity.title}`}
                onPress={() => setOpenRec(activity)}
                className="active:opacity-80"
              >
                <Card className="gap-1">
                  <View className="flex-row items-start justify-between gap-3">
                    <Tag label={activity.kind} tone="coach" />
                    <Icon name="chevron.right" size={13} color={chevron} />
                  </View>
                  <AppText variant="title" className="mt-1">
                    {activity.title}
                  </AppText>
                </Card>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {routine && routine.items.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>A gentle routine</SectionTitle>
          <AppText variant="meta" className="-mt-1">
            Week of {routine.weekOf}
          </AppText>
          <View className="gap-3">
            {routine.items.map((item, i) => (
              <Card key={`${item.kind}-${i}`} className="gap-1">
                <View className="flex-row items-center justify-between">
                  <Tag label={item.kind} tone="neutral" />
                  {item.day ? (
                    <AppText variant="mono" className="capitalize text-ink-3">
                      {item.day}
                    </AppText>
                  ) : null}
                </View>
                <AppText variant="title" className="mt-1">
                  {item.title}
                </AppText>
                {item.stageNote ? <AppText variant="meta">{item.stageNote}</AppText> : null}
              </Card>
            ))}
          </View>
        </View>
      ) : null}

      {childItems.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>Coming up for your kids</SectionTitle>
          <View className="gap-3">
            {childItems.map((item) =>
              item.teenRedacted ? (
                // Rule #1 (policy 3): one locked line for a 13+ teen — no name, no
                // content, no "when"; the parent sees THAT a plan exists.
                <Card key={item.key} className="gap-1">
                  <Tag label="private" tone="attention" />
                  <AppText variant="title" className="mt-1">
                    {item.what}
                  </AppText>
                </Card>
              ) : (
                // A per-child item is a shallow computed fold — there is no deeper
                // view to fabricate, so the row links to the Companion tab where that
                // child's full picture lives.
                <Pressable
                  key={item.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.what} — open Companion`}
                  onPress={() => router.push('/companion')}
                  className="active:opacity-80"
                >
                  <Card className="gap-1">
                    <View className="flex-row items-center justify-between">
                      <Tag label={item.kindLabel} tone="coach" />
                      <View className="flex-row items-center gap-2">
                        <AppText variant="mono" className="text-ink-3">
                          {item.childName}
                        </AppText>
                        <Icon name="chevron.right" size={13} color={chevron} />
                      </View>
                    </View>
                    <AppText variant="title" className="mt-1">
                      {item.what}
                    </AppText>
                    <AppText variant="meta">{item.when}</AppText>
                  </Card>
                </Pressable>
              ),
            )}
          </View>
          <AppText variant="meta" className="mt-1 text-center">
            Timing is the standard Canadian schedule — confirm with your provider.
          </AppText>
        </View>
      ) : null}

      <VillageDetailSheet
        rec={openRec}
        visible={openRec !== null}
        onClose={() => setOpenRec(null)}
        onChanged={onRefresh}
      />
    </>
  );
}

export default function PlanScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobilePlanResponse>('/api/mobile/plan');

  return (
    <Screen scroll className="gap-5" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <ScreenHeader title="Plan" back />
      <AppText variant="meta" className="-mt-2">
        The week ahead — your own plans, endorsed activities, your routine, and what's coming up per
        child.
      </AppText>
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <PlanBody data={data} onRefresh={refresh} /> : null}
    </Screen>
  );
}
