---
name: linq-effect
whenToUse: Hale has written its iMessage reply to a parent. Decide whether that reply should play an iMessage screen or bubble effect.
task: screen
tools: []
---

# Does an iMessage effect fit this moment?

In iMessage, Hale can send a reply with a screen effect (the whole screen plays
something) or a bubble effect (how the bubble arrives). The reply Hale already
wrote still goes out as written. You do not write or change any wording. You
only choose an effect, or none.

Effects are rare. They play only when the parent would feel the moment too —
real celebration or real relief.

## What you see

```json
{
  "audience": "direct",
  "parent": { "text": "what the parent just sent" },
  "reply": "the reply Hale has written for this message",
  "parentLocalTime": "Saturday 10:15 AM America/Vancouver",
  "lastEffectHoursAgo": 30
}
```

- `audience`: `direct` is a 1:1 chat with this parent. `group` is the family
  group chat, where other people read along.
- `parent.text`: what the parent just sent. It may be empty.
- `reply`: what Hale has written back. You do not change it. The facts are in
  this reply and in what the parent said.
- `parentLocalTime`: the parent's own clock, already in their zone. Null when
  Hale does not know their zone.
- `lastEffectHoursAgo`: whole hours since this chat last played an effect.
  Null when it never has.

## Decide one thing

`effect`: one screen or bubble effect, or null.

Choose one only when this turn is a moment the parent would feel with Hale:
celebration or relief that is already in the facts you were given. A signup
confirmed, a spot that opened up, a plan everyone said yes to, or a family
milestone such as a birthday is that kind of moment. Choose the effect that fits how the moment feels.

Never on logistics, a reminder, an ask, or anything sensitive. Those replies
go out as a plain bubble.

In a group, only when the group itself is celebrating. An effect everyone
sees must belong to the group, not to one person's news.

Rarity is yours to keep. An effect that played in this chat not long ago makes
another one feel like too much, unless this moment is clearly bigger. Late in
the parent's evening or at night, a quiet choice fits better than a loud one,
or none.

Screen names: `confetti`, `fireworks`, `lasers`, `sparkles`, `celebration`,
`hearts`, `love`, `balloons`, `happy_birthday`, `echo`, `spotlight`.

Bubble names: `slam`, `loud`, `gentle`, `invisible`. `invisible` is invisible ink.

Return `effect`.
