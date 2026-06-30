import { Share, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { Tag } from '@/components/ui/tag';
import { FAMILY } from '@/constants/family-data';

function SectionTitle({ children }: { children: string }) {
  return (
    <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
      {children}
    </AppText>
  );
}

export default function FamilyScreen() {
  const shareInvite = () =>
    Share.share({ message: `Join our family on Hale: https://${FAMILY.inviteLink}` });

  return (
    <Screen scroll className="gap-6">
      <ScreenHeader title="Family" back />

      <View className="gap-2">
        <SectionTitle>Parents</SectionTitle>
        <Card className="gap-3">
          {FAMILY.parents.map((parent) => (
            <View key={parent.id} className="flex-row items-center justify-between">
              <View>
                <AppText variant="body" className="text-ink">
                  {parent.name}
                </AppText>
                <AppText variant="meta">{parent.email}</AppText>
              </View>
              <Tag label={parent.role} tone="neutral" />
            </View>
          ))}
          <View className="gap-1.5 border-t border-rule pt-3">
            <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
              Co-parent invite link
            </AppText>
            <AppText variant="mono" className="text-ink-2">
              {FAMILY.inviteLink}
            </AppText>
            <Button
              label="Share invite"
              variant="secondary"
              onPress={shareInvite}
              className="mt-1 self-start"
            />
          </View>
        </Card>
      </View>

      <View className="gap-2">
        <SectionTitle>Children</SectionTitle>
        {FAMILY.children.map((child) => (
          <Card key={child.id} className="gap-3">
            <Field label="Name" defaultValue={child.name} autoCapitalize="words" />
            <Field
              label="Birthday"
              defaultValue={child.birthday}
              placeholder="YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
            />
            <Field
              label="Stage"
              defaultValue={child.stage}
              editable={false}
              hint="Set from birthday"
            />
            <Field label="Interests" defaultValue={child.interests} autoCapitalize="sentences" />
          </Card>
        ))}
      </View>

      <View className="gap-2">
        <SectionTitle>Your area</SectionTitle>
        <Card className="gap-3">
          <Field
            label="Postal code"
            defaultValue={FAMILY.postalCode}
            autoCapitalize="characters"
            keyboardType="default"
            hint="Drives local discovery using a coarse area only — never your exact address."
          />
        </Card>
      </View>

      <View className="gap-2">
        <SectionTitle>What you're hoping for</SectionTitle>
        <Card className="gap-3">
          <View className="flex-row flex-wrap gap-2">
            {FAMILY.intents.map((intent) => (
              <Tag key={intent} label={intent} tone="coach" />
            ))}
          </View>
          <Button label="Add an intent" variant="secondary" className="self-start" />
        </Card>
      </View>
    </Screen>
  );
}
