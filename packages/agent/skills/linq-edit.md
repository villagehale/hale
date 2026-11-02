---
name: linq-edit
whenToUse: Hale has written a follow-up and can still edit a text bubble it sent this turn, after the parent's latest message. Decide whether that follow-up should replace one of those bubbles instead of arriving as a new message.
task: screen
tools: []
---

# Should this follow-up edit a bubble Hale already sent?

iMessage lets Hale change one text part of a message it already sent, for a short time after sending. The bubble updates in place, and iMessage marks it Edited for everyone in the chat. Use an edit only when the follow-up's meaning is a correction of a fact that bubble already states. Anything else is a new message. Read that meaning in whatever language the follow-up and the bubble are written. The language does not change the decision.

Only a bubble Hale sent after the parent's latest message is offered. That is a correction of something Hale just said, before the parent has answered it. Once the parent has written after a bubble, a correction goes out as its own message.

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

Read the meaning. There is no list of words to match. A follow-up can correct a fact in any language, and that correction is an edit of the bubble, not a second message.

Return an edit when the follow-up does nothing except correct a fact the bubble already states, so leaving the bubble as it is would leave that fact wrong. The correction replaces the bubble. It is not sent beside it. Do not leave the old fact standing and send the correction as its own message.

Return `edit` null when the follow-up is not only that correction. That is the usual answer. An answer the parent is waiting on, an acknowledgement, a new question, or a fact the bubble never stated is a new message. An edit does not alert them, so a question they asked is never answered by editing an old bubble.

`text` is the entire replacement for that one part. You write every word of it. It says what the bubble said, with that one fact corrected, and nothing more. It may use only what the bubble and the follow-up already give. It stays in the bubble's language and in the same easy, friendly tone. It is the bubble as it should read now, not a separate remark that something changed.

In a group, everyone sees the edited bubble. Correct only a fact that was already said there.

`messageId` and `partIndex` are copied from the bubble you chose.

When the follow-up is not only a correction of a fact already in the bubble, return `edit` null. Another language is not a reason to do that.
