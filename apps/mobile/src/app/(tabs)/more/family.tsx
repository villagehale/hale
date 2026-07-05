import { useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Pill } from '@/components/ui/pill';
import { useTintedRefresh } from '@/components/ui/pull-refresh';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { Tag } from '@/components/ui/tag';
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
    <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
      {children}
    </AppText>
  );
}

function coarseArea(location: FamilyLocationView): string {
  const parts = [location.city, location.province, location.postalCode].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Not set';
}

function ParentRow({ member }: { member: MemberView }) {
  return (
    <View className="flex-row items-center justify-between">
      <View className="flex-1">
        <AppText variant="body" className="text-ink">
          {member.name ?? member.email}
        </AppText>
        <AppText variant="meta">{member.email}</AppText>
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

function ChildCard({ child, onSaved }: { child: FamilyChildBasics; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(child.name);
  const [dob, setDob] = useState(child.dateOfBirth);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <Card className="flex-row items-center justify-between">
        <View className="flex-1">
          <AppText variant="body" className="text-ink">
            {child.name}
          </AppText>
          <AppText variant="meta">{child.dateOfBirth}</AppText>
        </View>
        <View className="flex-row items-center gap-2">
          <Tag label={child.stageLabel} tone="coach" />
          <Pill label="Edit" icon="pencil" onPress={() => setEditing(true)} />
        </View>
      </Card>
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateFamily({ action: 'editChild', childId: child.id, name, dateOfBirth: dob });
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
        label="Date of birth"
        value={dob}
        onChangeText={setDob}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        hint="Birthday sets the stage Hale tailors to."
      />
      <FormError message={error} />
      <View className="flex-row gap-3">
        <Button label={saving ? 'Saving…' : 'Save changes'} onPress={save} className="flex-1" />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={() => {
            setName(child.name);
            setDob(child.dateOfBirth);
            setError(null);
            setEditing(false);
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
        <Pill label="Set your area" icon="mappin.and.ellipse" onPress={() => setEditing(true)} />
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
        <SectionTitle>Parents</SectionTitle>
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
      </View>

      <View className="gap-2">
        <SectionTitle>Your area</SectionTitle>
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
      <ScreenHeader title="Family" back />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && data ? <FamilyBody data={data} onSaved={reload} /> : null}
    </Screen>
  );
}
