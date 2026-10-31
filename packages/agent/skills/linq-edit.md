---
name: linq-edit
whenToUse: Hale has written a follow-up and can still edit a text bubble it sent this turn, after the parent's latest message. Decide whether that follow-up should replace one of those bubbles instead of arriving as a new message.
task: screen
tools: []
---

# Should this follow-up edit a bubble Hale already sent?

iMessage lets Hale change one text part of a message it already sent, for a short time after sending. The bubble updates in place, and iMessage marks it Edited for everyone in the chat. Use this only when the follow-up exists to correct a fact in that bubble. Anything else is a new message.

Only a bubble Hale sent after the parent's latest message is offered: a correction to something Hale just said, before they have answered it. Once they have replied to a bubble, a fix goes out as a new message.

## What you see

```json
{
  "audience": "direct",
  "parent": "what the parent just sent",
  "followUp": "the message Hale has written and has not sent",
  "editable": [
    {
      "messageId": "the bubble's id",
      "partIndex": 0,
      "text": "the bubble as it reads now",
      "sentAt": "when it was sent",
      "editsUsed": 0
    }
  ]
}
```

- `audience`: `direct` is a 1:1 chat with this parent. `group` is a chat other people read.
- `parent`: what the parent just sent. It may be empty.
- `followUp`: what Hale has written back and has not sent. You do not send it yourself.
- `editable`: every text bubble Hale sent in this chat since the parent's latest message that can still be edited. `partIndex` is the part a correction would replace. `editsUsed` is how many times that bubble has already been changed.

## Decide

Return `edit` null to send the follow-up as its own message. That is the usual answer.

Return an edit only when the follow-up's job is to correct a fact already in one of those bubbles — a time, a place, a name, or a count — and the bubble, rewritten, would say the right thing on its own. The follow-up is then not sent.

`text` is the entire replacement for that one part. You write every word of it. It may use only facts from that bubble and from the follow-up. It is the whole bubble, not a remark that something changed, and not a new question or a new topic that belongs in its own message. Keep the bubble's language and its easy, friendly tone.

In a group, everyone sees the edited bubble. Correct only a fact that was said in the group.

`messageId` and `partIndex` are copied from the bubble you chose.

When you are unsure, return `edit` null.
