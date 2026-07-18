import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Pill } from '@/components/ui/pill';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError } from '@/lib/api-client';
import type {
  FamilyChildBasics,
  FamilyLocationView,
  MemberView,
  MobileFamilyResponse,
} from '@/lib/api-types';
import { updateFamily } from '@/lib/family-api';
import { useApi } from '@/lib/use-api';

const ROLE_LABEL: Record<string, string> = {
  primary_parent: 'You',
  co_parent: 'Co-parent',
};

// Mirror of @hale/types CHILD_GENDERS — the native bundle can't import package code,
// so the value/label pairs are hand-copied (same pattern as INTENT_LABEL). Gender is
// OPTIONAL and sensitive (rule #1): 'unspecified' is the honest "prefer not to say".
const GENDERS: { value: string; label: string }[] = [
  { value: 'boy', label: 'Boy' },
  { value: 'girl', label: 'Girl' },
  { value: 'nonbinary', label: 'Non-binary' },
  { value: 'unspecified', label: 'Prefer not to say' },
];

/** Joins an interests array back into the comma-separated field the form edits (and
 * the server splits again with parseInterests). */
function interestsToField(interests: string[]): string {
  return interests.join(', ');
}

// Mirrored from @hale/types ONBOARDING_INTENTS — the intents come back as their
// stored values; show the same labels the web wizard/settings use.
const INTENT_LABEL: Record<string, string> = {
  activities: 'Activities & classes',
  childcare: 'Childcare',
  milestones: 'Milestones & development',
  planning: 'Weekly planning & routine',
  sitter: 'Trusted sitter/nanny',
  health: 'Health & specialists',
  community: 'Meeting other families',
  exploring: 'Just exploring',
};

// Mirror of the web ERROR_COPY (family-children.tsx): the child-validation error
// codes the shared server action returns, mapped to the same parent-facing copy.
const ERROR_COPY: Record<string, string> = {
  name_required: 'A name (or nickname) is needed.',
  dob_required: 'A date of birth is needed.',
  dob_invalid: "That date doesn't look right — use YYYY-MM-DD.",
  dob_future: "That's in the future — check the year.",
  dob_too_old: 'Hale is for children under eighteen.',
  preview: "Sign-in isn't configured in this preview, so nothing was saved.",
  not_found: 'That is no longer in your family.',
};

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return ERROR_COPY[e.message] ?? e.message;
  }
  return "Couldn't save just now — please try again.";
}

function SectionTitle({ children }: { children: string }) {
  return (
    <AppText variant="eyebrow">
      {children}
    </AppText>
  );
}

function coarseArea(location: FamilyLocationView): string {
  const parts = [location.city, location.province, location.postalCode].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Not set';
}

// The API stores/returns DOB as 'YYYY-MM-DD'. Parse it as a local date (not UTC,
// which would shift the day for negative timezones) for the picker, and format it
// back to the wire shape after a pick.
function parseDob(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function toDobString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dobLabel(value: string): string {
  return parseDob(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** First letter of a name (or email) for an avatar disc — Hale has no uploaded photos,
 * so an initial stands in (mirrors the More profile card + Profile page). */
function initialOf(source: string): string {
  return source.trim().charAt(0).toUpperCase() || '?';
}

/** The tinted initial disc shared by the parent + child rows (prototype avatar slot). */
function AvatarDisc({ initial }: { initial: string }) {
  return (
    <View className="h-[38px] w-[38px] items-center justify-center rounded-full bg-chip-blue">
      <AppText className="text-[15px] text-brand" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
        {initial}
      </AppText>
    </View>
  );
}

function ParentRow({ member }: { member: MemberView }) {
  return (
    <View className="flex-row items-center gap-3">
      <AvatarDisc initial={initialOf(member.name ?? member.email)} />
      <View className="flex-1">
        <AppText variant="body" numberOfLines={1} className="text-ink">
          {member.name ?? member.email}
        </AppText>
        <AppText variant="meta" numberOfLines={1}>
          {member.email}
        </AppText>
      </View>
      <Tag label={ROLE_LABEL[member.role] ?? member.role} tone="neutral" />
    </View>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <AppText variant="meta" className="text-accent" accessibilityRole="alert">
      {message}
    </AppText>
  );
}

function ParentNameForm({ member, onSaved }: { member: MemberView; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <Card className="gap-3">
        <ParentRow member={member} />
        <Pill label="Edit your name" icon="pencil" onPress={() => setEditing(true)} />
      </Card>
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateFamily({ action: 'setParentName', name });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="gap-4">
      <Field
        label="Your name"
        value={name}
        onChangeText={setName}
        placeholder="Your name"
        autoCapitalize="words"
      />
      <AppText variant="meta">{member.email} · from your account, never re-entered.</AppText>
      <FormError message={error} />
      <View className="flex-row gap-3">
        <Button label={saving ? 'Saving…' : 'Save name'} onPress={save} className="flex-1" />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => {
            setName(member.name ?? '');
            setError(null);
            setEditing(false);
          }}
          className="flex-1"
        />
      </View>
    </Card>
  );
}

/** A single-select chip row (gender). Selection is carried by label + fill, never
 * colour alone (rule #1 / DESIGN.md). */
function ChipSelect({
  options,
  value,
  onSelect,
}: {
  options: { value: string; label: string }[];
  value: string;
  onSelect: (v: string) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(option.value)}
            className={`min-h-11 items-center justify-center rounded-full border px-4 py-2.5 ${
              active ? 'border-ink bg-ink' : 'border-rule bg-card'
            }`}
          >
            <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

function ChildCard({ child, onSaved }: { child: FamilyChildBasics; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(child.name);
  const [lastName, setLastName] = useState(child.lastName ?? '');
  const [dob, setDob] = useState(child.dateOfBirth);
  const [gender, setGender] = useState(child.gender);
  const [interests, setInterests] = useState(interestsToField(child.interests));
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink3');

  if (!editing) {
    return (
      <Card
        onPress={() => setEditing(true)}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${child.name}'s profile`}
        className="flex-row items-center gap-3"
      >
        <AvatarDisc initial={initialOf(child.name)} />
        <View className="flex-1">
          <AppText variant="body" className="text-ink">
            {child.name}
          </AppText>
          <AppText variant="meta">{dobLabel(child.dateOfBirth)}</AppText>
        </View>
        <Tag label={child.stageLabel} tone="coach" />
        <Icon name="chevron-right" size={15} color={iconColor} />
      </Card>
    );
  }

  // Android fires 'dismissed' on cancel and closes its own dialog; iOS keeps the
  // inline picker open until the parent hides it, so only Android toggles here.
  const onPickerChange = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setShowPicker(false);
    if (event.type === 'set' && picked) setDob(toDobString(picked));
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Send EVERY editable field — the server now persists gender/lastName/interests
      // (the masked-input bug that dropped them is fixed).
      await updateFamily({
        action: 'editChild',
        childId: child.id,
        name,
        dateOfBirth: dob,
        lastName,
        gender,
        interests,
      });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="gap-4">
      <Field
        label="Name or nickname"
        value={name}
        onChangeText={setName}
        placeholder="Maya"
        autoCapitalize="words"
      />
      <Field
        label="Last name (optional)"
        value={lastName}
        onChangeText={setLastName}
        placeholder="Rivera"
        autoCapitalize="words"
      />
      <View className="gap-1.5">
        <AppText variant="meta" className="text-ink-2">
          Date of birth
        </AppText>
        {/* The date picker is a native module (no web impl), so on the RN-web preview
            we show the resolved date read-only. */}
        {Platform.OS === 'web' ? (
          <View className="min-h-11 justify-center rounded-md border border-rule bg-canvas px-4 py-3">
            <AppText variant="body" className="text-ink">
              {dobLabel(dob)}
            </AppText>
          </View>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Date of birth: ${dobLabel(dob)}. Tap to change.`}
              accessibilityState={{ expanded: showPicker }}
              onPress={() => setShowPicker((s) => !s)}
              className="min-h-11 flex-row items-center justify-between rounded-md border border-rule bg-canvas px-4 py-3 active:opacity-80"
            >
              <AppText variant="body" className="text-ink">
                {dobLabel(dob)}
              </AppText>
              <Icon
                name={showPicker ? 'chevron-up' : 'chevron-down'}
                size={13}
                color={iconColor}
              />
            </Pressable>
            {showPicker ? (
              <View className="items-center">
                <DateTimePicker
                  value={parseDob(dob)}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'inline' : 'default'}
                  maximumDate={new Date()}
                  onChange={onPickerChange}
                />
              </View>
            ) : null}
          </>
        )}
        <AppText variant="meta">Birthday sets the stage Hale tailors to.</AppText>
      </View>
      <View className="gap-1.5">
        <AppText variant="meta" className="text-ink-2">
          Gender (optional)
        </AppText>
        <ChipSelect options={GENDERS} value={gender} onSelect={(g) => setGender(g as typeof gender)} />
      </View>
      <Field
        label="Interests (optional)"
        value={interests}
        onChangeText={setInterests}
        placeholder="swimming, music"
        autoCapitalize="none"
        hint="Comma-separated — helps Hale find local things."
      />
      <FormError message={error} />
      <View className="flex-row gap-3">
        <Button label={saving ? 'Saving…' : 'Save changes'} onPress={save} className="flex-1" />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => {
            setName(child.name);
            setLastName(child.lastName ?? '');
            setDob(child.dateOfBirth);
            setGender(child.gender);
            setInterests(interestsToField(child.interests));
            setShowPicker(false);
            setError(null);
            setEditing(false);
          }}
          className="flex-1"
        />
      </View>
    </Card>
  );
}

/** The add-a-child form: the SAME fields as edit, starting empty, dispatching the
 * `addChild` action (the mobile route delegates to the audited addChildAction). A
 * collapsed "Add a child" pill expands it. */
function AddChildForm({ onSaved }: { onSaved: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState('unspecified');
  const [interests, setInterests] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink3');

  function reset() {
    setName('');
    setLastName('');
    setDob('');
    setGender('unspecified');
    setInterests('');
    setShowPicker(false);
    setError(null);
  }

  if (!adding) {
    return <Pill label="Add a child" icon="plus" onPress={() => setAdding(true)} />;
  }

  const onPickerChange = (event: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS !== 'ios') setShowPicker(false);
    if (event.type === 'set' && picked) setDob(toDobString(picked));
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateFamily({ action: 'addChild', name, dateOfBirth: dob, lastName, gender, interests });
      reset();
      setAdding(false);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="gap-4">
      <SectionTitle>Add a child</SectionTitle>
      <Field
        label="Name or nickname"
        value={name}
        onChangeText={setName}
        placeholder="Maya"
        autoCapitalize="words"
      />
      <Field
        label="Last name (optional)"
        value={lastName}
        onChangeText={setLastName}
        placeholder="Rivera"
        autoCapitalize="words"
      />
      <View className="gap-1.5">
        <AppText variant="meta" className="text-ink-2">
          Date of birth
        </AppText>
        {Platform.OS === 'web' ? (
          <View className="min-h-11 justify-center rounded-md border border-rule bg-canvas px-4 py-3">
            <AppText variant="body" className={dob ? 'text-ink' : 'text-ink-3'}>
              {dob ? dobLabel(dob) : 'Pick a date (native only)'}
            </AppText>
          </View>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={dob ? `Date of birth: ${dobLabel(dob)}. Tap to change.` : 'Pick a date of birth'}
              accessibilityState={{ expanded: showPicker }}
              onPress={() => setShowPicker((s) => !s)}
              className="min-h-11 flex-row items-center justify-between rounded-md border border-rule bg-canvas px-4 py-3 active:opacity-80"
            >
              <AppText variant="body" className={dob ? 'text-ink' : 'text-ink-3'}>
                {dob ? dobLabel(dob) : 'Pick a date'}
              </AppText>
              <Icon name={showPicker ? 'chevron-up' : 'chevron-down'} size={13} color={iconColor} />
            </Pressable>
            {showPicker ? (
              <View className="items-center">
                <DateTimePicker
                  value={dob ? parseDob(dob) : new Date()}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'inline' : 'default'}
                  maximumDate={new Date()}
                  onChange={onPickerChange}
                />
              </View>
            ) : null}
          </>
        )}
        <AppText variant="meta">Birthday sets the stage Hale tailors to.</AppText>
      </View>
      <View className="gap-1.5">
        <AppText variant="meta" className="text-ink-2">
          Gender (optional)
        </AppText>
        <ChipSelect options={GENDERS} value={gender} onSelect={setGender} />
      </View>
      <Field
        label="Interests (optional)"
        value={interests}
        onChangeText={setInterests}
        placeholder="swimming, music"
        autoCapitalize="none"
        hint="Comma-separated — helps Hale find local things."
      />
      <FormError message={error} />
      <View className="flex-row gap-3">
        <Button label={saving ? 'Adding…' : 'Add child'} onPress={save} className="flex-1" />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => {
            reset();
            setAdding(false);
          }}
          className="flex-1"
        />
      </View>
    </Card>
  );
}

function LocationForm({
  location,
  onSaved,
}: {
  location: FamilyLocationView;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [country, setCountry] = useState(location.country ?? '');
  const [province, setProvince] = useState(location.province ?? '');
  const [city, setCity] = useState(location.city ?? '');
  const [postalCode, setPostalCode] = useState(location.postalCode ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <Card className="gap-3">
        <View className="gap-1">
          <AppText variant="body" className="text-ink">
            {coarseArea(location)}
          </AppText>
          <AppText variant="meta">
            Drives local discovery using a coarse area only — never your exact address.
          </AppText>
        </View>
        <Pill label="Set your area" icon="map-pin" onPress={() => setEditing(true)} />
      </Card>
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateFamily({ action: 'setLocation', country, province, city, postalCode });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="gap-4">
      <Field label="Country" value={country} onChangeText={setCountry} placeholder="Canada" />
      <Field
        label="Province / state"
        value={province}
        onChangeText={setProvince}
        placeholder="Ontario"
      />
      <Field label="City" value={city} onChangeText={setCity} placeholder="Toronto" />
      <Field
        label="Postal code"
        value={postalCode}
        onChangeText={setPostalCode}
        placeholder="M5V 2T6"
        autoCapitalize="characters"
        hint="Drives neighbourhood discovery — never a precise address."
      />
      <FormError message={error} />
      <View className="flex-row gap-3">
        <Button label={saving ? 'Saving…' : 'Save area'} onPress={save} className="flex-1" />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => {
            setCountry(location.country ?? '');
            setProvince(location.province ?? '');
            setCity(location.city ?? '');
            setPostalCode(location.postalCode ?? '');
            setError(null);
            setEditing(false);
          }}
          className="flex-1"
        />
      </View>
    </Card>
  );
}

function FamilyBody({ data, onSaved }: { data: MobileFamilyResponse; onSaved: () => void }) {
  const { members, basics } = data;
  return (
    <>
      <View className="gap-2">
        <SectionTitle>Parents &amp; guardians</SectionTitle>
        {members.primary ? (
          <ParentNameForm member={members.primary} onSaved={onSaved} />
        ) : null}
        {members.coParent ? (
          <Card>
            <ParentRow member={members.coParent} />
          </Card>
        ) : (
          <Card>
            <AppText variant="meta">
              Co-parent invite pending — a second parent can join to share this household.
            </AppText>
          </Card>
        )}
      </View>

      <View className="gap-2">
        <SectionTitle>Children</SectionTitle>
        {basics.children.length === 0 ? (
          <Card>
            <AppText variant="meta">No children added yet.</AppText>
          </Card>
        ) : (
          basics.children.map((child) => (
            <ChildCard key={child.id} child={child} onSaved={onSaved} />
          ))
        )}
        <AddChildForm onSaved={onSaved} />
      </View>

      <View className="gap-2">
        <SectionTitle>Family area</SectionTitle>
        <LocationForm location={basics.location} onSaved={onSaved} />
      </View>

      {basics.intents.length > 0 ? (
        <View className="gap-2">
          <SectionTitle>What you're hoping for</SectionTitle>
          <Card>
            <View className="flex-row flex-wrap gap-2">
              {basics.intents.map((intent) => (
                <Tag key={intent} label={INTENT_LABEL[intent] ?? intent} tone="coach" />
              ))}
            </View>
          </Card>
        </View>
      ) : null}
    </>
  );
}

export default function FamilyScreen() {
  const { status, data, error, refreshing, reload, refresh } =
    useApi<MobileFamilyResponse>('/api/mobile/family');

  return (
    <Screen scroll className="gap-6" refreshControl={useTintedRefresh(refreshing, refresh)}>
      <DetailHeader title="Family" />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <FamilyBody data={data} onSaved={reload} /> : null}
    </Screen>
  );
}
