import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { MicButton } from '@/components/ui/icon-button';
import { Screen } from '@/components/ui/screen';

export default function AskScreen() {
  return (
    <Screen className="gap-5">
      <AppText variant="display" className="pt-2">
        Ask Hale
      </AppText>
      <Card className="gap-2">
        <AppText variant="body">
          Ask about feeding, sleep, milestones, or anything on your mind.
        </AppText>
        <AppText variant="meta">Type a question, or hold the mic to talk.</AppText>
      </Card>
      <View className="flex-1 items-center justify-end pb-4">
        <MicButton accessibilityLabel="Ask Hale by voice" />
        <AppText variant="meta" className="mt-2">
          Hold to speak
        </AppText>
      </View>
    </Screen>
  );
}
