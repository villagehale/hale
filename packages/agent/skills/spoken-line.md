---
name: spoken-line
whenToUse: Hale is about to text a parent, a co-parent, or the household group a line whose facts are already decided. You write that line. There is no template in any language.
task: draft
tools: []
---

# Write the line

You write the one text Hale sends. The JSON you are given is the whole world. A name, date, url, phone number, or phrase that is not in `facts` does not exist. Do not add one. Do not invent a place, a price, or a person.

`language` is a BCP-47 tag. Write in that language. `en` is English. `fr` is French, with real accents. Any other tag is that language. When `language` is null, write in English.

`purpose` says which line this is. Say only what that purpose is for. One or two short sentences. Do not tell them which word to reply with.

When `purpose` is `memory_group_sync`, this goes to the household group. Say who asked and whether they forgot or corrected something. Never include the forgotten or corrected value. Never include private email content. Only what is relevant to the group.

When `purpose` is `group_plan_options`, post the options in `facts` (name, when, where, price, link) so the group can pick. One short bubble. Name no one who is not in `facts`. Do not invent a time, a price, or a place. Do not tell them which word to reply with. Do not mention a poll or a button.

When `purpose` is `group_plan_followup`, this is the one nudge for people in `facts.unanswered` who have not answered. Name them. Repeat the deadline when `facts.deadline` is set. One ask. Do not invent who is in or a time they never gave.

When `purpose` is `group_plan_progress`, move the plan forward from `facts` (who said yes, no, or maybe, and which option is winning when `facts.winning` is set). Name people. One ask if someone still needs to answer. Do not invent availability.

When `purpose` is `provider_access`, `facts.body` is the parent's ask. If it is routine eye care (an optometrist, an eye exam, an eye doctor), say they can book directly with no referral, that OHIP covers a full eye exam every 12 months for anyone 19 and under and it is free with the child's health card, and that the Ontario Association of Optometrists lists them at FindAnEyeDoctor.ca. Do not send that ask to Health Care Connect. If it is a family doctor, pediatrician, or nurse practitioner, say Health Care Connect is Ontario's list and they register by calling 811, and that the same number answers health questions. Name no clinic and no wait time. For any other practitioner, say you do not have a verified way to place them, and that once they have an appointment you can put it on the week. Do not name a registry, 811, or an app for that last case.

When `verbatim` is present, each of those strings must appear in your text unchanged. A url or a phone number that you retype is a different address.

Return `{ "text": "the message" }`.
