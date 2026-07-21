import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { useMeadowColor } from '@/constants/meadow';

// Matches the resend cooldown the password verify screen uses (10/min poll headroom
// under the auth route's per-IP cap).
const RESEND_COOLDOWN_MS = 30_000;

/**
 * The calm "check your email" state after a magic-link request — shared by the
 * returning-user sign-in screen and the onboarding save step. The link is redeemed
 * out-of-app (it deep-links back into /magic-link), so unlike the password verify
 * screen this one does NOT poll: it confirms, offers a rate-limited resend, and a way
 * back to the form to fix a mistyped address.
 */
export function MagicLinkSent({
  email,
  onResend,
  onUseDifferentEmail,
}: {
  email: string;
  onResend: () => Promise<void>;
  onUseDifferentEmail: () => void;
}) {
  const accent = useMeadowColor('accentFill');
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  // 'error' is re-tappable (unlike the in-flight/cooldown states) so a failed resend
  // surfaces an inline reason and lets the parent try again — never a silent no-op.
  const locked = resendState === 'sending' || resendState === 'sent';

  const resend = async () => {
    if (locked) return;
    setResendState('sending');
    try {
      await onResend();
    } catch {
      setResendState('error');
      return;
    }
    setResendState('sent');
    setTimeout(() => setResendState('idle'), RESEND_COOLDOWN_MS);
  };

  return (
    <View className="gap-6">
      <View className="items-center gap-5">
        <View className="h-20 w-20 items-center justify-center rounded-full bg-accent-tint">
          <Icon name="mail" size={32} color={accent} />
        </View>
        <View className="items-center gap-3">
          <AppText variant="display" className="text-center">
            Check your email
          </AppText>
          <AppText variant="body" className="max-w-[320px] text-center">
            We sent a sign-in link to {email}.
          </AppText>
        </View>
      </View>
      <View className="gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Resend the sign-in link"
          accessibilityState={{ disabled: locked }}
          onPress={resend}
          disabled={locked}
          className="items-center py-1 active:opacity-70"
        >
          <AppText variant="meta" className="text-ink-3">
            {resendState === 'sent'
              ? 'Sent — check your inbox'
              : resendState === 'sending'
                ? 'Sending…'
                : 'Resend the link'}
          </AppText>
        </Pressable>
        {resendState === 'error' ? (
          <AppText
            variant="meta"
            className="text-center text-berry"
            accessibilityLiveRegion="polite"
          >
            Couldn&rsquo;t resend the link. Please try again.
          </AppText>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Use a different email"
          onPress={onUseDifferentEmail}
          className="items-center py-1 active:opacity-70"
        >
          <AppText variant="meta" className="text-ink-3">
            Use a different email
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}
