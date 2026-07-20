import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { useMeadowColor } from '@/constants/meadow';
import { requestMagicLink } from '@/lib/auth-api';
import { isPlausibleEmail } from '@/lib/magic-link';

const INVALID_EMAIL = 'Enter a valid email address.';
const GENERIC_ERROR = "Couldn't send the link just now. Please try again.";

/**
 * The passwordless email → magic-link request form: an email field, the request
 * button, and the reassurance line. Shared by the returning-user sign-in screen and
 * the onboarding save step. On a successful request it calls onSent(email) — the
 * parent swaps in the "check your email" confirmation — so this only owns the
 * pre-send UX (validation, in-flight lock, inline error). `disabled` is the onboarding
 * consent gate: no send before the parent has captured consent.
 */
export function MagicLinkForm({
  onSent,
  disabled = false,
}: {
  onSent: (email: string) => void;
  disabled?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placeholderColor = useMeadowColor('ink3');
  const inputColor = useMeadowColor('ink');

  const submit = async () => {
    setError(null);
    const trimmed = email.trim();
    if (!isPlausibleEmail(trimmed)) {
      setError(INVALID_EMAIL);
      return;
    }
    setBusy(true);
    try {
      await requestMagicLink(trimmed);
      onSent(trimmed); // parent swaps to the confirmation — this form unmounts
    } catch {
      setError(GENERIC_ERROR);
      setBusy(false); // the success path unmounts us; only the error path returns here
    }
  };

  return (
    <View className="gap-3">
      <TextInput
        accessibilityLabel="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@email.com"
        placeholderTextColor={placeholderColor}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        textContentType="emailAddress"
        editable={!busy}
        onSubmitEditing={submit}
        returnKeyType="go"
        style={{ color: inputColor, fontFamily: 'InstrumentSans_400Regular' }}
        className="rounded-md border border-input-border bg-card px-4 py-3.5 text-[16px]"
      />
      {error ? (
        <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
      <Button
        label={busy ? 'Sending…' : 'Email me a magic link'}
        variant="secondary"
        onPress={submit}
        disabled={disabled || busy}
      />
      <AppText variant="meta" className="text-center text-caption">
        We&rsquo;ll email you a secure sign-in link — no password needed.
      </AppText>
    </View>
  );
}
