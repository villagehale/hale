import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { LogoMark } from '@/components/ui/logo-mark';
import { StoryButton, StoryScreen, StoryText } from '@/components/onboarding/story-screen';

/**
 * Screen 2 — "Hi, I'm Hale." The first story beat on the Prussian field: the
 * turtle chip, a warm hello, and one line of what Hale quietly does. "Let's begin"
 * starts the story; "I already have an account" is the escape hatch to the existing
 * sign-in (reachable from the very start, per the routing gate). The animated
 * SplashLoader (screen 1) precedes this on app open.
 */
export default function WelcomeScreen() {
  return (
    <StoryScreen
      footer={
        <>
          <StoryButton label="Let's begin" onPress={() => router.push('/(onboarding)/promise')} />
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="I already have an account, sign in"
            onPress={() => router.push('/sign-in')}
            className="flex-row items-center justify-center active:opacity-70"
          >
            <StoryText variant="meta" muted>
              Already have an account?{' '}
            </StoryText>
            <StoryText variant="meta">Sign in</StoryText>
          </Pressable>
        </>
      }
    >
      <View className="gap-8">
        <LogoMark size={72} />
        <View className="gap-4">
          <StoryText variant="display" className="text-[34px] leading-[40px]">
            Hi 👋 — I'm Hale.
          </StoryText>
          <StoryText variant="body" muted className="max-w-[300px] text-[17px] leading-[26px]">
            I quietly keep watch over the little things — the shots, the sign-ups, the plans — so
            they don't fall to you alone.
          </StoryText>
        </View>
      </View>
    </StoryScreen>
  );
}
