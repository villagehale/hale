/**
 * The pipe a message rides. The ledger's channel_message_channel enum carries the
 * same values (plus email, push, and voice). `whatsapp` stays for historical rows;
 * nothing inbound produces it. `imessage` is the Linq blue-bubble pipe (VIL-335):
 * the address is a bare E.164, resolved by the same blind index, and the chat id
 * travels beside the message rather than inside the address.
 */
export type MessageTransport = 'sms' | 'whatsapp' | 'imessage';
