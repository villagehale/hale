# Channel adapter live smokes (VIL-213 · A2)

One live send per adapter, to run **once pre-merge** with real (test-tier) provider
creds. Do NOT run in CI — these reach a provider. Each snippet goes in a throwaway
`apps/web/lib/channel/adapters/_smoke.test.ts` (vitest resolves the `~` alias and the
real env) and runs with `npx vitest run apps/web/lib/channel/adapters/_smoke.test.ts`.
Delete the scratch file after. Never paste real creds into a committed file.

## 1. Expo push — `createExpoPushChannelAdapter`

Prereqs: `PUSH_SEND_ENABLED=true`, `DATABASE_URL` set, and one row in `push_tokens`
for `USER_ID` holding a real (sandbox/dev) Expo token from a device you can watch.

```ts
import { defaultExpoChannelDeps, createExpoPushChannel } from '~/lib/push/channel';
import { db } from '~/lib/db';
import { createExpoPushChannelAdapter } from './expo-push';

const adapter = createExpoPushChannelAdapter({ push: createExpoPushChannel(defaultExpoChannelDeps(db())) });
console.log(await adapter.send({ userId: USER_ID, rendered: { kind: 'push', title: 'Hale smoke', body: 'push leg live' } }));
// expect: { status: 'sent', providerMessageId: null }  + the device buzzes
```

## 2. Resend email — `createResendEmailChannel`

Prereqs: `RESEND_API_KEY=re_...` (a Resend test key), `RESEND_FROM` a verified sender.
`delivered@resend.dev` is Resend's always-accepts test recipient.

```ts
import { createResendEmailChannel } from './resend-email';

const adapter = createResendEmailChannel({ resolveEmail: async () => 'delivered@resend.dev' });
console.log(await adapter.send({
  userId: 'smoke',
  rendered: { kind: 'email', subject: 'Hale smoke', html: '<p>email leg live</p>', text: 'email leg live' },
}));
// expect: { status: 'sent', providerMessageId: '<resend id>' }
// with RESEND_API_KEY unset it must instead be { status: 'skipped', reason: 'not_configured' }
```

## 3. Loop SMS — `createSmsChannel`

The default sender is Linq (`LINQ_API_KEY` and `LINQ_FROM_E164`). The config gate:

```ts
import { createSmsChannel } from './phone-sms';

const adapter = createSmsChannel({ resolveTarget: async () => '+15555550100' });
console.log(await adapter.send({ userId: 'smoke', rendered: { kind: 'sms', text: 'sms leg' } }));
// Linq key or line unset → { status: 'skipped', reason: 'not_configured' }
// both set → posts to Linq POST /v3/chats (iMessage, then RCS, then SMS)
```
