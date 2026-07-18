import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { ChatBubble } from '@/components/onboarding/chat-bubble';
import { VillageHouses } from '@/components/illustrations/village-houses';
import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import { useReducedMotion } from '@/lib/use-reduced-motion';

/**
 * Step 11 — "Hale is getting things ready…" The POST-auth getting-ready screen. By
 * the time it renders the root layout's resume effect has already run the atomic
 * submitOnboarding (family + children + the 4 consents + first-village discovery),
 * so every line below is a REAL completed step — the stagger only PACES the reveal
 * of work that genuinely happened, it is not a fake progress bar pretending work is
 * in flight (honest over literal). Reaching this route at all means the submit
 * succeeded (the resume effect routes to the tabs on failure). Auto-advances into
 * the connect step once the last line lands.
 */
const STEPS = [
  'Created your family space',
  "Saved your family's details",
  'Recorded your privacy choices',
  'Started finding your village',
  'Getting your home ready',
];

const STAGGER_MS = 420;
const HOLD_MS = 700;

export default function PreviewScreen() {
  const reduced = useReducedMotion();
  const [lit, setLit] = useState(0);
  const advanced = useRef(false);

  useEffect(() => {
    if (reduced) {
      setLit(STEPS.length);
      return;
    }
    if (lit >= STEPS.length) return;
    const timer = setTimeout(() => setLit((n) => n + 1), STAGGER_MS);
    return () => clearTimeout(timer);
  }, [lit, reduced]);

  useEffect(() => {
    if (lit < STEPS.length || advanced.current) return;
    advanced.current = true;
    const timer = setTimeout(() => router.replace('/connect'), HOLD_MS);
    return () => clearTimeout(timer);
  }, [lit]);

  return (
    <Screen>
      <ChatBubble prompt="Hale is getting things ready…" />

      <View className="mt-7 gap-4" accessibilityLiveRegion="polite">
        {STEPS.map((label, i) => (
          <ReadyRow key={label} label={label} lit={i < lit} />
        ))}
      </View>

      <View className="flex-1 items-center justify-end">
        <VillageHouses width={260} />
      </View>
    </Screen>
  );
}

function ReadyRow({ label, lit }: { label: string; lit: boolean }) {
  const onGreen = useMeadowColor('onAccent');
  return (
    <View className={`flex-row items-center gap-3 ${lit ? 'opacity-100' : 'opacity-30'}`}>
      <View className="h-5 w-5 items-center justify-center rounded-full bg-success">
        <Icon name="check" size={12} color={onGreen} />
      </View>
      <AppText variant="section" className="text-[14px]">
        {label}
      </AppText>
    </View>
  );
}
