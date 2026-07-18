import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Screen } from '@/components/ui/screen';
import { Tag } from '@/components/ui/tag';
import { STUB_BILLING } from '@/lib/stub-data';

/**
 * Billing & payments (handoff), reached from Plan & benefits. A 100% DISCLOSED
 * SAMPLE: Hale has no billing backend (Stripe is a 501 stub; launch is free-first),
 * so there is no real payment method, next charge, or invoice. The prototype's card
 * + invoice figures live in STUB_BILLING and render ONLY under the amber "billing
 * isn't live yet" banner below — no real Stripe call is ever made here (rule: honest
 * beats literal; a disclosed stub never blends with real account data).
 */
export default function BillingScreen() {
  return (
    <Screen scroll className="gap-4">
      <DetailHeader title="Billing & payments" />

      {/* The single disclosure that governs the whole page — every figure below is a
          preview, not a real card or charge. */}
      <Card variant="cream" className="gap-1">
        <AppText className="text-[14px] text-cream-accent" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
          Sample billing preview
        </AppText>
        <AppText variant="meta" className="text-cream-accent">
          Billing isn&rsquo;t set up yet — Hale is free while we&rsquo;re in early access. The card and
          charges below are examples, not real payments.
        </AppText>
      </Card>

      <View className="gap-2.5">
        <AppText variant="eyebrow">Payment method · sample</AppText>
        <Card className="flex-row items-center gap-3">
          <View className="h-7 w-10 items-center justify-center rounded-md bg-brand">
            <AppText
              className="text-[9px] uppercase tracking-eyebrow text-on-ink"
              style={{ fontFamily: 'InstrumentSans_700Bold' }}
            >
              {STUB_BILLING.brand}
            </AppText>
          </View>
          <View className="flex-1">
            <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
              {STUB_BILLING.brand} •••• {STUB_BILLING.last4}
            </AppText>
            <AppText variant="meta" className="text-caption">
              Expires {STUB_BILLING.expiry}
            </AppText>
          </View>
        </Card>
      </View>

      <Card className="flex-row items-center gap-3">
        <View className="flex-1">
          <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
            Next payment
          </AppText>
          <AppText variant="meta" className="text-caption">
            {STUB_BILLING.nextPaymentDate}
          </AppText>
        </View>
        <AppText className="text-[14px] text-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
          {STUB_BILLING.nextPaymentAmount}
        </AppText>
      </Card>

      <View className="gap-2.5">
        <AppText variant="eyebrow">History · sample</AppText>
        <Card className="gap-0 p-0">
          {STUB_BILLING.invoices.map((invoice, i) => (
            <View
              key={invoice.date}
              className={`flex-row items-center gap-3 px-4 py-3 ${
                i === 0 ? '' : 'border-t border-hairline'
              }`}
            >
              <AppText className="flex-1 text-[13.5px] text-ink" style={{ fontFamily: 'InstrumentSans_600SemiBold' }}>
                {invoice.date}
              </AppText>
              <AppText variant="meta" className="text-caption">
                {invoice.amount}
              </AppText>
              <Tag label="Paid" tone="done" />
            </View>
          ))}
        </Card>
      </View>
    </Screen>
  );
}
