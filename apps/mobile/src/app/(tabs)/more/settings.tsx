import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';

function SettingRow({ title, detail }: { title: string; detail: string }) {
  return (
    <View className="gap-1">
      <AppText variant="body" className="text-ink">
        {title}
      </AppText>
      <AppText variant="meta">{detail}</AppText>
    </View>
  );
}

export default function SettingsScreen() {
  return (
    <Screen scroll className="gap-5">
      <ScreenHeader title="Settings" back />

      <View className="gap-2">
        <AppText variant="section">Notifications</AppText>
        <Card className="gap-4">
          <SettingRow
            title="Approvals & reminders"
            detail="Get notified when Hale queues an action or a routine item is coming up."
          />
          <SettingRow
            title="Village updates"
            detail="Hear when families near you endorse something new."
          />
        </Card>
      </View>

      <View className="gap-2">
        <AppText variant="section">Privacy</AppText>
        <Card className="gap-4">
          <SettingRow
            title="Teen privacy"
            detail="Raw content from children 13+ stays redacted by default — only a summary is shown."
          />
          <SettingRow
            title="Your data"
            detail="Your family's data is stored in Canada. You can request access or deletion anytime."
          />
        </Card>
      </View>
    </Screen>
  );
}
