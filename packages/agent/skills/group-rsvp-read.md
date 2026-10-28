---
name: group-rsvp-read
whenToUse: A message or tapback in a group chat where Hale may be tracking who is coming to a plan. Read the meaning — start tracking, report the count, a yes, a no, still deciding, calendar permission, or people talking to each other — in any wording and any language.
task: screen
tools: []
---

# Read a group RSVP turn

You get one message from a group chat, optional tapback type, the sender's first
name when known, whether Hale is already tracking a plan in this chat, `now` as
an ISO clock, the last few lines of THIS chat only, and the names Hale goes by.
You never see another family's inbox, calendar titles, or 1:1 texts.

Decide one `intent`:

- `track`: the sender asks Hale to keep a count of who is coming to a plan
  (a party, a picnic, a class meetup — whatever they named). Any wording.
  Starting a count is Hale's job, not starting a poll or handing out buttons.
- `report`: the sender wants the current count or who is in.
- `yes`: this household is coming. Includes a tapback that means yes (heart,
  thumbs-up, like, love, emphasize) on the plan, and plain language from any
  language.
- `no`: this household is out. Includes a thumbs-down / dislike tapback and
  plain language.
- `pending`: they have not decided, or they asked Hale to wait.
- `permission_yes`: they are answering Hale's ask about putting the plan on
  THEIR household calendar — a yes to that write, not a new RSVP.
- `permission_no`: they refused that calendar write.
- `chatter`: people talking to each other, including snacks, outfits, jokes,
  and joining or leaving the group itself. Not a vote and not an ask for Hale.
- `unclear`: you cannot tell. Do not guess a vote.

Also return:

- `confidence` between 0 and 1. Below 0.6, treat the read as `unclear`.
- `event` when `track` names a plan, or when a missing fact is filled in while
  tracking: `title`, `whenText`, `location`. Use only words from this message or
  `recent`. When they named a day or time, resolve `whenText` to an ISO
  timestamp using `now`. Leave a field null rather than invent a day, hour, or
  place they did not name. Never invent who is free or busy.
- `householdName` when the sender names who the vote is for (their family, a
  kid, "we"). Otherwise the sender's first name, or null.

A tapback is a vote on the plan when Hale is already tracking, or when `recent`
is about that plan. A laugh tapback is `chatter`. Joining or leaving the group
is `chatter`. A question aimed at another parent is `chatter`.

Read meaning, not keywords. When unsure between a vote and `chatter`, choose
`chatter`. When unsure between `track` and `chatter`, choose `chatter`.

Return `intent`, `confidence`, `event`, and `householdName`.
