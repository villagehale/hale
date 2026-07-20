import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import { useAuth } from '@/lib/auth';
import { verifyMagicLink } from '@/lib/auth-api';
import { type MagicPhase, initialMagicPhase, magicTokenFromParams } from '@/lib/magic-link';
import { setPostAuthHold } from '@/lib/post-auth-hold';

/**
 * Deep-link redemption for a magic link (hale://magic-link?token=…). Extracts the
 * token, exchanges it for a session, then hands off to the SAME resume machinery the
 * OAuth buttons use: setPostAuthHold(true) before signIn means a just-onboarded parent
 * (a saved draft) is routed into the post-auth tail (/preview), while a returning user
 * (no draft) is dropped into the tabs — the root layout's resume effect decides both
 * (see resume-destination.ts). A missing / expired / consumed token shows an inline
 * failure with a way back to request a fresh link.
 */
export default function MagicLinkScreen() {
  const { token: tokenParam } = useLocalSearchParams<{ token?: string }>();
  const { signIn } = useAuth();
  const token = magicTokenFromParams(tokenParam);
  const [phase, setPhase] = useState<MagicPhase>(() => initialMagicPhase(token));
  const attempted = useRef(false);
  const accent = useMeadowColor('accentFill');
  const danger = useMeadowColor('chipRedIcon');

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;
    verifyMagicLink(token)
      .then(({ token: bearer }) => {
        // Hand routing to the resume effect: it submits a saved onboarding draft →
        // /preview, or drops a returning user into /(tabs). The hold suppresses the
        // gate's own bounce until that decision lands.
        setPostAuthHold(true);
        return signIn(bearer);
      })
      .catch(() => setPhase('failed'));
  }, [token, signIn]);

  if (phase === 'failed') {
    return (
      <Screen className="justify-center gap-6">
        <View className="items-center gap-5">
          <View className="h-20 w-20 items-center justify-center rounded-full bg-chip-red">
            <Icon name="circle-x" size={32} color={danger} />
          </View>
          <View className="items-center gap-3">
            <AppText variant="display" className="text-center">
              Link didn&rsquo;t work
            </AppText>
            <AppText variant="body" className="max-w-[320px] text-center">
              This sign-in link is invalid or has expired. Request a fresh one — it only takes a
              moment.
            </AppText>
          </View>
        </View>
        <Button label="Request a new link" onPress={() => router.replace('/sign-in')} />
      </Screen>
    );
  }

  return (
    <Screen className="justify-center gap-6">
      <View className="items-center gap-5">
        <View className="h-20 w-20 items-center justify-center rounded-full bg-accent-tint">
          <Icon name="mail" size={32} color={accent} />
        </View>
        <AppText variant="display" className="text-center">
          Signing you in&hellip;
        </AppText>
      </View>
    </Screen>
  );
}
