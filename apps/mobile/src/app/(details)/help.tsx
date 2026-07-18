import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';

/** The FAQ answers are honest, product-true statements — approval-first agency, the
 * Canadian data + teen-privacy posture, and where to disconnect a connector — not
 * marketing copy. Each maps to a real behaviour a parent can verify in the app. */
const FAQS: { q: string; a: string }[] = [
  {
    q: 'How do approvals work?',
    a: 'Hale drafts actions and holds them for you. Nothing — a log, an email, a calendar event — happens until you tap Approve. You can reject or edit any draft, and every action is recorded.',
  },
  {
    q: "Is my family's data private?",
    a: "Yes. Your family's data is stored in Canada (PIPEDA / Quebec Law 25). For a child 13 or older, only a category or summary is shared with you by default — raw content stays private. Nothing goes to a third party unless you connect one.",
  },
  {
    q: 'How do I disconnect Google?',
    a: 'Open Settings → Connected accounts and tap Disconnect on Calendar, Gmail, or Drive. Hale stops reading from it right away, and you can reconnect any time.',
  },
];

function FaqRow({ q, a, last }: { q: string; a: string; last?: boolean }) {
  const [open, setOpen] = useState(false);
  const chevron = useMeadowColor('ink3');
  return (
    <View className={last ? '' : 'border-b border-hairline'}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={q}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((s) => !s)}
        className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-80"
      >
        <AppText className="flex-1 text-[13.5px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
          {q}
        </AppText>
        <Icon name={open ? 'chevron-up' : 'chevron-right'} size={15} color={chevron} />
      </Pressable>
      {open ? (
        <AppText variant="meta" className="px-4 pb-4 text-ink-2">
          {a}
        </AppText>
      ) : null}
    </View>
  );
}

/**
 * Help & support (handoff), reached from Settings → Other. Support is Hale itself —
 * the "Ask Hale" row opens the Ask tab (the real in-app help channel). The prototype's
 * "hello@hale.family" support mailbox is fiction (no such address exists in the app),
 * so it is NOT shown — an unmonitored email would be a dead, dishonest affordance. The
 * FAQ answers are real, product-true statements a parent can verify.
 */
export default function HelpScreen() {
  const chevron = useMeadowColor('ink3');
  return (
    <Screen scroll className="gap-4">
      <DetailHeader title="Help &amp; support" />

      <Card className="gap-0 p-0">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ask Hale for help"
          onPress={() => router.push('/ask')}
          className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-80"
        >
          <TintChip icon="sparkles" tone="blue" />
          <View className="flex-1">
            <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
              Ask Hale
            </AppText>
            <AppText variant="meta" className="text-caption">
              Your in-app helper, any time
            </AppText>
          </View>
          <Icon name="chevron-right" size={15} color={chevron} />
        </Pressable>
      </Card>

      <View className="gap-2.5">
        <AppText variant="eyebrow">Common questions</AppText>
        <Card className="gap-0 p-0">
          {FAQS.map((faq, i) => (
            <FaqRow key={faq.q} q={faq.q} a={faq.a} last={i === FAQS.length - 1} />
          ))}
        </Card>
      </View>
    </Screen>
  );
}
