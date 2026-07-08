import { router } from 'expo-router';
import { View } from 'react-native';

import { StoryButton, StoryScreen, StoryText } from '@/components/onboarding/story-screen';

/**
 * Screen 3 — the promise. A single reassuring line on the Prussian field: the
 * village Hale rebuilds is the point, not the tooling. Continues into the
 * capabilities preview (screen 4).
 */
export default function PromiseScreen() {
  return (
    <StoryScreen
      footer={
        <StoryButton
          label="Continue"
          onPress={() => router.push('/(onboarding)/capabilities')}
        />
      }
    >
      <View className="gap-5">
        <StoryText variant="display" className="text-[30px] leading-[38px]">
          Parenting was never meant to be done alone.
        </StoryText>
        <StoryText variant="body" muted className="text-[17px] leading-[26px]">
          It used to take a village — neighbours, grandparents, the family down the street. Hale
          gathers that quiet support back around you.
        </StoryText>
      </View>
    </StoryScreen>
  );
}
