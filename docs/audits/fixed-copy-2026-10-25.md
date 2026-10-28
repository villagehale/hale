# Fixed parent-facing copy and code-built format: audit (2026-10-25)

Barton's rule, in his words: "never有固定message" and "或者格式". No fixed parent-facing text and no code-built structure around a message. The model writes the whole text from facts. When the model fails, nothing is sent.

This file is the work list for replacing each site below. Every site is either rewritten as AI text from facts, with a nothing-sent failure path and a judged eval, or deleted. Each surface lands as its own small PR, and every PR needs a recorded eval and Preview proof before it merges.

How the list was made: a scripted scan of `apps/web/lib` for string literals of four or more words in a second-person, first-person or Hale voice, plus a scan for code-built structure (`join('\n')`, numbered or bulleted lists, `title at time` lines, `+N more` tails, prefixes). The scan errs toward too many hits, so each surface PR checks its own hits. Some hits are model prompts rather than parent text; those are closed as "prompt, not copy".

Left out on purpose:
- Web UI copy: trail verbs, dashboard, labels, the connect page, family forms, scope copy, passport.
- Ops and monitoring.
- Test fixtures.
- `channels/sms-consent-copy.ts`: the CASL consent wording is legally required, and changing it needs Barton's call.
- `channels/otp-sender.ts`: the one-time code text.
- **Overlap with the language-gate PR:** `channel/language.ts`, the reply reader and `intake/opt-out-reader.ts` are being changed there, so they are not touched here.
- `withOptOut` (`channel/opt-out.ts:53`) already returns the body unchanged, so there is no footer to remove.

Done in the reminder PR (#911): the parent reminder's `reminderLead` + `eventLine` prefix, `+N more` tail and voice fold.

## A. Code-built structure (format)
```
apps/web/lib/channel/coparent/duty/asks.ts:725:  return parts.join('\n');
apps/web/lib/channel/intake/activity-map.ts:331:  return parts.join('\n');
apps/web/lib/channel/intake/first-touch-find.ts:97:  return shown.map((line, index) => `${index + 1}. ${line}`).join('\n');
apps/web/lib/channel/intake/friend-voice.ts:994:    .join('\n');
apps/web/lib/channel/intake/friend-voice.ts:1063:    body = parts.join('\n');
apps/web/lib/channel/intake/year-open.ts:113:  return shown.map((line, index) => `${index + 1}. ${line}`).join('\n');
apps/web/lib/channel/linq/family-outbound.ts:630:        text: lines.join('\n'),
apps/web/lib/channel/linq/group-coparent-copy.ts:144:  return `${weekly.trimEnd()}\n${extra.join('\n')}`;
apps/web/lib/channel/linq/household-calendar.ts:428:    text: lines.join('\n'),
apps/web/lib/channel/linq/payload.ts:258:      text: texts.join('\n'),
apps/web/lib/channel/off-domain/medical.ts:381:    .join('\n');
apps/web/lib/loop/templates/caregiver/reminder-sms.ts:27:  const line = `${event.title} at ${localTimeLabel(event.startsAt, timeZone)}`;
apps/web/lib/memory/brief.ts:229:  let text = [header, ...lines].join('\n');
apps/web/lib/memory/kinds.ts:233:    bubbles.push(parts.join('\n'));
apps/web/lib/memory/workstream-followup.ts:770:  ].join('\n');
apps/web/lib/memory/workstreams.ts:456:  let text = lines.join('\n');
apps/web/lib/registration/sequence/copy.ts:890:  return lines.join('\n');
```

## B. Fixed text literals by file (file, then line: excerpt)

```
apps/web/lib/auth/channel-link-actions.ts (1)
  34: This link is invalid or has expired. A fresh one is in your texts.
apps/web/lib/channel/activity/commitment.ts (1)
  79: A promise to come back with what I find on ${subject}
apps/web/lib/channel/activity/deliver.ts (1)
  417: activity follow-up: the parent was told Hale is still watching and no row was written
apps/web/lib/channel/activity/followup-note.ts (5)
  61: In your own words, in the language named by `language` on this request, say that more options exist and that t
  165: true when the message tells the parent Hale will come back to them about this (keep watching, check again, tex
  457: The message asks the parent a question. This message keeps a promise; it never asks for permission. Say what y
  469: The message says Hale could not get at these details AND that it will come back when the venue posts them. Bot
  482: The message says Hale will come back or keep looking. Nothing is outstanding on this one and no such promise h
apps/web/lib/channel/activity/tools.ts (1)
  67:  means the search is still running and you ran out of time to wait (a CALL only): it is NOT nothing, so never 
apps/web/lib/channel/activity/venue-pages.ts (2)
  146: activity held options: the latest note could not be read - sending the reply without venue pages
  154: activity held options: could not read the note - sending the reply without venue pages
apps/web/lib/channel/autonomy/compose.ts (1)
  38: The one text Hale sends.
apps/web/lib/channel/autonomy/notice-text.ts (1)
  167: The one text Hale sends.
apps/web/lib/channel/calendar-write/notice.ts (1)
  168: The one text Hale sends the parent.
apps/web/lib/channel/caregiver/add-them-yourself.ts (1)
  149: Return the one reply to the parent.
apps/web/lib/channel/caregiver/copy.ts (11)
  38: Okay - I haven't texted ${name}.
  42: You're in - I'll text you the week's schedule and pickup reminders, and nothing else. Reply STOP anytime.
  44: No problem - I won't text you again.
  54: Tell me who, their number, and what they are - like: add grandma 647-555-0199 as grandparent. I can do grandpa
  68: A co-parent sees everything I show you, so I won't add one from a number you typed. Text me add my partner and
  72: That number is already set up with Hale, so I can't add it as a caregiver - they'd need to reply STOP there fi
  74: That's your own number - you're already here.
  79: I've already texted them - I'll let you know as soon as they answer.
  89: I can't text that number for you. If they'd like to be here, they can text me first.
  93: That's a lot of people in one day - I'll pick this up tomorrow. Nobody new has been texted.
  99: That's one for ${who} - I only share the schedule here.
apps/web/lib/channel/caregiver/route.ts (1)
  299: caregiver reply: spoken line unreachable
apps/web/lib/channel/checkin/request.ts (1)
  104: Decide whether this message asks Hale for something.
apps/web/lib/channel/coach/autonomy-switch-off-tool.ts (1)
  37: They want Hale to stop sending email for them without asking.
apps/web/lib/channel/coach/gmail-draft-notice.ts (3)
  62: You removed a Gmail draft Hale had prepared. Hale did not send any email.
  65: You updated a Gmail draft. The parent reviews it and sends it themselves. Hale did not send any email.
  67: You prepared a Gmail draft in the parent Gmail. They review it and send it themselves. Hale did not send any e
apps/web/lib/channel/coach/gmail-draft-tool.ts (1)
  54: Thanks, Thursday at 4 still works for us.
apps/web/lib/channel/coach/tools.ts (1)
  480: s week: the composed plan summary, `days` (the seven dates of that week with the weekday each one is — read yo
apps/web/lib/channel/connect/fresh-link.ts (1)
  196: connector link: fresh link text sent without its link
apps/web/lib/channel/connect/text-connect.ts (5)
  51: I never see your password. You can disconnect any time.
  52: I never see your password. You can disconnect any time.
  83: So Hale can flag daycare and school notices for you.
  89: So Hale can catch class invites and trip dates for the kids.
  94: One tap signs you in and opens your connected apps.
apps/web/lib/channel/consent-ask.ts (1)
  117: Write the one text this person will see.
apps/web/lib/channel/coparent/accept.ts (1)
  137: co-parent accepted, from their own number, the one invite Hale sent them
apps/web/lib/channel/coparent/duty/copy.ts (2)
  18: You both said you've got {event}, {day}. Who's taking it, {parentA} or {parentB}?
  43: {name}, over to you on {event}, {day}.
apps/web/lib/channel/coparent/duty/extract.ts (1)
  180: Structured duty slots from one co-parent reply. Not a message to a parent.
apps/web/lib/channel/coparent/duty/parse.ts (4)
  68: ll|i can|i got it|i
  69: ll| will)|i can|i(?:
  75: ll both|we will both|we both|we can both|both parents|we
  76: t|i cannot|i won
apps/web/lib/channel/coparent/duty/placeholders.ts (1)
  15: I don't keep score, but I can tell you what's still open this week. Want that?
apps/web/lib/channel/coparent/duty/sync-line.ts (1)
  53: ll|i will) take ([A-Za-z][A-Za-z
apps/web/lib/channel/founder/copy.ts (4)
  33: A note from Barton, the dad who built Hale: thank you for being one of our first ${location} families. If anyt
  37: Sent - your note is in their thread.
  41: No problem - I have closed that one out.
  49: I could not reach that family, so the note did not go. Closing that one out.
apps/web/lib/channel/founder/ping.ts (1)
  68: An offer to send your welcome note to a new family from the ${location} poster.
apps/web/lib/channel/identity/ask-voice.ts (1)
  247: Return the one text asking for the parent's own detail.
apps/web/lib/channel/identity/name-reply.ts (1)
  65: you can call me
apps/web/lib/channel/inbound-route.ts (2)
  190: inbound: a first text got no reply; the first-reply sweep owes it one
  360: inbound: recorded the text but could not queue it for C1 — left unmarked for the reconciler
apps/web/lib/channel/intake/adult-learn.ts (1)
  19: I'm a kids' rec helper, not adult lessons. If you've got kids, send their names and ages and I'll watch ${city
apps/web/lib/channel/intake/answer.ts (4)
  115: ?(ll|m going to|ve)\s+(keep|watch|track|start|set|add|find|found|remind|send|text|check|look)|i
  206: The reply to what the parent asked, or an empty string if they did not ask anything.
  210: Hale's own pending question again, in different words, ending in '?'.
  444: Return the answer to the parent's question and the line back to Hale's.
apps/web/lib/channel/intake/friend-voice.ts (24)
  71: Hale only reads, sees, or looks at the kids' emails or events
  72: Hale never sees work or personal email
  79: Google shares the whole inbox with Hale
  80: Hale keeps and uses only what is about the kids
  81: Hale never sends email
  85: Google shares the whole calendar with Hale
  86: Hale keeps and uses only what is about the kids
  87: Hale never changes or deletes their events
  520: ’]re|you are|we[
  536: ’]?t|cannot) (?:see|read|look at|open|touch|access) (?:your |any )?(?:work|personal|private|other)\b|\bonly (?
  540: ’]?s your name|your name\?|comment (?:je )?(?:dois|peux)[- ]?(?:je )?t[
  651: your own message: the parent has not written since your last text
  687: when coparentGroupMode is existing, the number on its own line under the reply
  688: they add Hale to the iMessage group they already have, or Hale starts a new one. A plain yes names neither. An
  692: start a group text with the other parent and the number below, then send the phrase below in it
  1275: \\b(?:i['’]?m|i am|this is|it['’]?s|je suis|c['’]est)\\s+${escapeRegExp(name)}\\b
  1819: onboarding-friend: unusable reply
  1863: onboarding-friend: unusable reply
  1874: onboarding-friend: unusable reply
  1934: onboarding-friend: unusable reply
  2046: When coparentGroupMode is existing, code places the number on its own line under the reply. Say it is below an
  2047: Under their yes, code puts Hale's number and the phrase on their own lines right below. Say they are below and
  2055: It made a privacy claim that is not true. Google shares the whole inbox or calendar with Hale; Hale keeps and 
  2281: Return the onboarding reply and any facts the parent just gave.
apps/web/lib/channel/intake/intent.ts (2)
  107: ${skill.instructions}\n\nClassify the reply in state using exactly one of the three criteria.
  129: Return how the parent's reply reads.
apps/web/lib/channel/intake/machine.ts (3)
  1009: 988 (call or text, Canada and US)
  1340: intake crisis: the model routed a crisis but wrote no reply - nothing sent, page #ops
  2422: cold-start: question is stale, handing the text to the coach
apps/web/lib/channel/intake/provision.ts (1)
  210: parent originated contact by texting Hale
apps/web/lib/channel/intake/radar-voice.ts (1)
  39: Your first weekend find lands in a day or two.
apps/web/lib/channel/intake/welcome-card.ts (1)
  39: That's me - save my card so it's a name texting you, not a number.
apps/web/lib/channel/join/copy.ts (3)
  31: Here you go - forward this to them and they're in: ${joinLink(code)} Just to them, though: whoever opens it jo
  64: You're in - ${who} added you as a co-parent, so you see what they see here and can text me anything, anytime. 
  69: Your partner is in - they joined from their own number and they see what you see here.
apps/web/lib/channel/linq/contact-card.ts (1)
  62: linq contact card: setup held past the reply budget
apps/web/lib/channel/linq/group-onboarding-voice.ts (3)
  107: Hale group onboarding: a ${kind} line was not sent (${fallback}). Nothing went to the parent.
  147: The one message Hale sends.
  165: The one message Hale sends.
apps/web/lib/channel/linq/group-turn-policy.ts (1)
  51: i will (?:take|grab|get|do|drive|pick)
apps/web/lib/channel/linq/group-turn-reader.ts (1)
  87: Return whether this group message is for Hale.
apps/web/lib/channel/linq/group.ts (2)
  35: This thread is your kids' year — both of you, and me.
  45: I couldn't open the group yet. Ask them to text this number once, then tell me to try again.
apps/web/lib/channel/linq/inbound.ts (6)
  508: linq inbound: group opt-out, no reply
  532: linq inbound: group opt-out, no reply
  621: linq inbound: logistics text was not stored
  829: linq inbound: claim reply unreachable
  971: linq inbound: Hale removed from the group
  1373: Linq reports a Hale sending line as ${line.status}. Unrequested proactive sends are held until it clears.
apps/web/lib/channel/linq/link-preview.ts (2)
  94: linq link preview: unreachable — the text already went out
  100: linq link preview: refused — the text already went out
apps/web/lib/channel/linq/logistics-poll.ts (1)
  21: we'll figure it out
apps/web/lib/channel/linq/roster-reading.ts (1)
  78: Hale group onboarding: could not read a group reply after one retry. Nothing was seated. Check #ops.
apps/web/lib/channel/nudge/nudge-voice.ts (1)
  308: The one text Hale sends.
apps/web/lib/channel/nudge/weekday-ask-tools.ts (1)
  30: The one text Hale sends: what a friend who noticed something about this family's week would text. Its one ask 
apps/web/lib/channel/off-domain/answer-request.ts (2)
  111: With `live` unavailable, no running count, record or title tally is stated, neither as a digit nor as a word t
  145: When the notes flag a medication interaction, the reply includes a check with a doctor or a pharmacist.
apps/web/lib/channel/off-domain/lane.ts (1)
  455: off-domain lane: the question this reply left open was not kept
apps/web/lib/channel/off-domain/medical.ts (1)
  635: off-domain medical: moment reply unwritten
apps/web/lib/channel/off-domain/moment-reply.ts (1)
  87: Return the one text for this moment.
apps/web/lib/channel/off-domain/screen.ts (1)
  303: Return which lane this inbound text belongs in.
apps/web/lib/channel/opt-out.ts (1)
  22: Reply STOP to opt out.
apps/web/lib/channel/plan/compose.ts (4)
  155: How many days from today Hale should check back in. Your final message must promise this day by name.
  263: Message ${stage} names a dose. Hale never gives one, not even over the counter.
  324: The plan never says when you will check back. Your last message must promise the day: "${promised}".
  421: Return the plan as two or three text messages in order, plus how many days from today to check back.
apps/web/lib/channel/plan/offer.ts (2)
  69: The offer tells them to reply with a keyword. Ask in a sentence, like "Want me to send it?"
  100: Should I send the whole first-foods plan?
apps/web/lib/channel/plan/reply.ts (1)
  360: How do we do ${playbook.primaryMethod.name}?
apps/web/lib/channel/proactive/compose.ts (1)
  44: The one text Hale sends.
apps/web/lib/channel/proactive/decide.ts (1)
  50: Your one decision for this family right now.
apps/web/lib/channel/proactive/tools.ts (1)
  132: The one text Hale sends for the whole batch.
apps/web/lib/channel/rec-morning/city-line.ts (1)
  39: I can watch leftovers and the waitlist.
apps/web/lib/channel/reconcile/reconcile.ts (6)
  138: The message promises to change how Hale itself behaves. Nothing in the system can record or keep that promise,
  140: The message says Hale is watching a registration or will text before one opens. No registration window is bein
  142: The message says Hale is watching and will text when it opens, and what Hale is actually watching is ONE class
  146: The message says something is booked or on the calendar. Nothing on this family's calendar matches and the par
  148: The message says an invite was sent or will be sent. Only the co-parent invite path may say that, and only aft
  221: ${window.town} registration: a text before it opens.
apps/web/lib/channel/reconcile/unhanded.ts (1)
  185: inbound reconcile: this text is still owed a reply — the queue refused it again
apps/web/lib/channel/referral/share.ts (4)
  74: The line contains a link. Do not write one - the real link is added after your message, and any URL you compos
  79: The line points at an app, a website or an account. Hale is a number their friend texts; there is nothing for 
  102: s own link for telling somebody else about Hale — call it whenever a parent asks how to refer, invite, share, 
  107: It's a text line that keeps track of the family week - registrations, plans, the stuff that slips.
apps/web/lib/channel/router/copy.ts (15)
  54: Already handled - nothing waiting on you.
  68: I'm still double-checking that one myself - nothing for you to do yet, I'll come back to you on it.
  70: That one isn't something I can take back.
  122: Give me a moment - I'm still catching up on your last few texts.
  134: That's sorted - I won't raise it again.
  156: Approved - ${spokenActionLabel(actionType)}. I'll let you know once it's done.
  165: That's back off your calendar.
  199: Got it - I'll make that introduction and use this address from now on.
  204: That address is already on another Hale account - text me a different one and I'll use that.
  217: Thanks - I'll use that from now on.
  220: Nothing's waiting on your approval right now. Everything I've set up is here: ${appLink()}
  224: Nothing to undo from the last day. Your full history is here: ${appLink()}
  235: I've only got one thing waiting on you - tell me if you want it and I'll put it through.
  236: I've only got ${pendingCount} things waiting on you - tell me which one you mean.
  342: That one's past me for now - I'm best at your family's schedule, registrations, and what's on nearby. (For eve
apps/web/lib/channel/router/handlers.ts (2)
  342: connector link: both-links text could not be written - nothing sent
  380: connector link: link text could not be written - nothing sent
apps/web/lib/channel/router/open-questions.ts (11)
  470: introductions to other Hale families nearby
  472: the plan I offered
  474: what I said I would come back to you about
  475: sending your welcome note to the new family
  480: texting your co-parent
  490: how your weeks are covered
  499: turning off your forwarding address
  894: Whether to be introduced to other Hale families nearby
  908: Whether to meet one nearby Hale family
  973: Whether to text the number you gave me and seat them as your co-parent
  1073: Whether to turn off your forwarding address
apps/web/lib/channel/router/resolve.ts (2)
  181: The id of the question this reply answers; 'none' if it answers none of them; 'ambiguous' if it is clearly an 
  302: Return which open question this reply answers, and how.
apps/web/lib/channel/router/route.ts (11)
  859: channel router: answer already claimed by a concurrent attempt — this send was a duplicate reply
  1234: channel router: the weekday-care ask is standing and the reply settles neither side
  1411: channel router: moment reply unwritten
  2167: channel router: the reply claimed a row that does not exist - not sent as written
  2213: channel router: every sentence of the reply claimed a row that does not exist
  2218: channel router: sending the reply with the unbacked sentences cut out
  2530: pending ask: the reply landed; the question it left open was not kept
  2559: linq moment: fell through to the text
  2580: channel router: the reply landed; the answer ledger did not
  2698: group sync: the 1:1 reply landed; the group bubble did not
  2717: channel router: no reply for this step
apps/web/lib/channel/same-activity/copy.ts (3)
  10: Another family nearby is looking at the same {activity}. Want me to check if they'd go together? I won't share
  14: Asked. If they're in, I'll let you know; if not, I won't bring it up again. Nothing to do for now.
  18: You're both up for it. The other parent is {firstName}, and they got your first name too. Want me to start a c
apps/web/lib/channel/spoken-line.ts (1)
  86: Write the one text Hale will send.
apps/web/lib/channel/spots/promise.ts (1)
  36: Hale is watching a full class and will text when a spot opens.
apps/web/lib/channel/spots/tool.ts (9)
  74: That link is not a portal I can read. I can only watch ${portals} - tell the parent that plainly, and do not o
  76: That link is not a secure address, so I will not poll it. Ask the parent to copy the link out of their browser
  78: That link carries a sign-in in it, so I will not store or poll it. Ask the parent for the plain course-page ad
  82: That is not a course page I can read. I can only watch ${portals} course pages - ask the parent for the link f
  103: I cannot read that page - it does not carry a class ${portalLabel} publishes. Ask the parent to send the link 
  132: s address, exactly as they pasted it - never one you composed, and never a search or listing page: it has to b
  171: I cannot watch class pages for this household yet - nothing would be polling it. Tell the parent plainly that 
  180: This household has not said yes to Hale texting them first, so I cannot watch anything for them. Say so plainl
  233: I could not reach ${link.portalLabel} just now, so I have not started watching anything. Tell the parent that 
apps/web/lib/channel/voice/said-line.ts (6)
  133: Return the one text Hale sends.
  205: Hale would catch school and camp emails for them too
  206: their calendar joins the kids' year Hale keeps for the family
  226: URGENT: crisis flagged, no reply sent - page #ops now
  248: 988 (call or text, Canada and US)
  280: so Hale can spot daycare and school notices
apps/web/lib/coach/action-intent.ts (1)
  305: Add to your plan
apps/web/lib/commitments/ledger.ts (2)
  198: commitments: fulfilment with no ledger row - promise left open, Hale will read as still owing it
  261: commitments: close failed - promise left open, Hale will read as still owing it
apps/web/lib/cron/drain.ts (2)
  249: drain: autonomy notice dispatch failed; the morning sweep still owes the text
  284: drain: autonomy notice dispatch failed; the morning sweep still owes the text
apps/web/lib/health/checkpoints.ts (1)
  216: Ontario runs a longer 18-month well-baby visit with your family doctor.
apps/web/lib/health/offer.ts (1)
  63: An offer to add booking this to your week: ${checkpoint.task}
apps/web/lib/integrations/calendar-alert.ts (3)
  1165: ${title} is on your calendar for ${when}${placePhrase(change)}
  1263: ${title}: ${count} sessions on your calendar, ${pattern} starting ${from}
  1271: ${title}: ${count} sessions on your calendar, the first on ${first}
apps/web/lib/integrations/calendar-mirror.ts (1)
  33: Something on your calendar
apps/web/lib/integrations/calendar-offer-read.ts (2)
  39: The id of the offer this reply answers; 'none' if it answers none of them; 'ambiguous' if it is clearly an ans
  189: Read which open calendar offer this reply answers, and whether it was a yes or a no.
apps/web/lib/integrations/email-alert-offer.ts (2)
  203: An offer to put ${offer.title} on your week, starting ${offer.startsAt.toISOString()}
  223: putting ${offer.title} on your week
apps/web/lib/integrations/email-alert.ts (8)
  292: email alert: the sentinel could not read this message - no text, and the key is unspent
  654: email alert: the going count could not be read - the text goes without the clause
  757: email alert: the text went out and the booking row did not - the ask will not happen
  965: email alert: the sentinel could not read this message - no text, and the key is unspent
  1190: I've kept the details out of this text.
  1300: Want me to add it to your week?
  1313: Want it on your calendar?
  1518: ${sender} says you're in for ${title}
apps/web/lib/integrations/going.ts (1)
  264: , with ${spelled(count.others)} other Hale families
apps/web/lib/integrations/offer-receipt.ts (1)
  28: The one text message. Include the title and the rendered instant exactly.
apps/web/lib/loop/templates/calendar-invite/sms.ts (1)
  91: Added - ${payload.summary}, ${payload.when}. Tap to put it on your phone's calendar: ${payload.url}
apps/web/lib/loop/voice/calendar-cancel-voice.ts (1)
  133: Return the one short text telling the parent the event is cancelled.
apps/web/lib/memory/workstream-followup.ts (18)
  137: follow up|reach out|contacte|contact|appelle|[ée]crive|v[ée]rifie|relance|demande|email|text|check|call|ask|ch
  139: ’]ll|i will|i[
  152: ^(?:just (?:checking|wanted to check|following up|circling back|a quick check-?in)|checking in${WE}|checking b
  157: ${WB}(?:any news|on your end|heard anything|des nouvelles|de ton c[oô]t[eé])${WE}
  163: ${WB}(?:hear back|heard back|update from|any update|news from|r[eé]pondu|r[eé]ponse|get back to you|got back t
  170: ${WB}(?:tu dois|tu devrais|vous devez|vous devriez|il faut que tu|il faudrait que tu|faudrait que tu|faut(?:\\
  171: ${WB}il faudrait\\s+\\p{L}+(?:er|ir|re)${WE}
  172: ${WB}il faut(?!-il)\\s+\\p{L}+(?:er|ir|re)${WE}
  180: ^(?:time to|need to|gotta|don['’]t forget|make sure|remember to|be sure to)${WE}
  186: ${WB}(?:you need to|you have to|you['’]ve got to|you should|you must|don['’]t forget to|make sure (?:to|you))$
  205: ${WB}(?:booked|is confirmed|you signed up|all set|c['’]est r[eé]gl[eé]|r[ée]servée?|confirmée?|inscrite?)${WE}
  210: ${WB}(?:you said|you mentioned|tu as dit|tu m['’]as dit|comme tu disais)${WE}
  220: ${WB}(?:did you|have you|do you|you get a chance|can you|could you|as-tu|t['’]as|tu peux|peux-tu|pourrais-tu)$
  230: ${WB}(?:when|since|after|now that|quand|depuis que|maintenant que)\\s+(?:you(?:['’]ve)?|tu as|t['’]as)\\s+(cal
  231: ${WB}what did (?:the\\s+\\p{L}+|they|he|she) say${WE}
  232: ${WB}qu['’]est-ce qu(?:['’](?:ils|elles|il|elle)|e\\s+(?:l['’]\\p{L}+|(?:le|la|les)\\s+\\p{L}+))\\s+(?:t['’]a 
  573: ${WB}(?:(?:did|has|have|does|do|will|is|was|can|could)\\s+${name}|do you know if\\s+${name}|${name}\\s+a(?:\\s
  778: The one check-back text for this open thread.
apps/web/lib/memory/workstreams.ts (1)
  77: ’]ll|i will|i[
apps/web/lib/party/copy.ts (2)
  48: I've got the party but not the day - what date and time? Send it however you like.
  52: Here's your invite - share this with guests: ${url}\nText me "who's coming?" any time for the headcount.
apps/web/lib/party/guest-copy.ts (3)
  30: From Hale: ${title} has been cancelled by the host. Sorry for the change.
  40: Hale made this invite for the host.
  41: See what it does for your family
apps/web/lib/plan/week.ts (1)
  33: a plan for your teen — private
apps/web/lib/registration/sequence/copy.ts (34)
  120: Reply "got in", "waitlisted #12" or "missed it".
  211: You told me the setup is done.
  213: You have not told me the setup is done - tonight is the time. Want me to know when it is?
  215: You have not told me the setup is done - sign in now and check it.
  327: The birthday I hold is
  335:  Your postal code gets the residents-first date.
  346:  I'll send your plan the evening before.
  347:  Want me to run the morning with you?
  364: ${windowPhrase(input.shortlist)} opens ${when(input.anchor, input.timeZone, input.now)} for ${who}. Before the
  411: Tomorrow: ${label} opens ${openAt(input.anchor)} I could not re-read the course page tonight, so check it your
  413: ${municipal} The course page you sent me is gone from ${label}.
  441: Heads up: ${label} now shows ${name} opening ${when(clock.at, input.timeZone, input.now)} That is not tomorrow
  442: Heads up: ${label} now shows that course opening ${when(clock.at, input.timeZone, input.now)} That is not tomo
  515: ${windowPhrase(shortlist)} opens ${timeOfDay(input.anchor, input.timeZone)}. Your link: ${shortlist.sourceUrl}
  549: I could not read ${label} just now, so I cannot tell you what it says. It opens ${at} Sign in, then Register: 
  556: ${label} is not showing the course you sent me. I had ${at} for it. Check the page yourself: ${prep.courseUrl}
  564: Heads up: I had ${at} for this and ${label} now shows ${when(clock.at, input.timeZone, input.now)} Go by the p
  593: Checking in on your ${town} waitlist spot - watch your email for an offer.
  597: About 2h left to answer a ${town} waitlist offer: ${hours}h from your message runs out ${until}. Check your em
  599: Halfway on the ${town} waitlist clock. Their window is ${hours}h from your message, so it runs out ${until}.
  629: That's a spot - you're in for ${town} ${shortlist.windowRef.cycleLabel}.
  632: Sorry - that one filled. I'll flag the next ${town} window early.
  639: ${spot}, noted. ${town} has no published response window, so I can't set a clock - watch your email closely.
  641: ${spot}, noted. ${town} gives ${shortlist.waitlistResponseHours}h to answer an offer, so I'll nudge you before
  761: My ${townLabel(input.municipality)} dates said ${when(input.opensForFamilyAt, timeZone, now)} I am going by th
  772: a form I cannot see${prerequisite ? ' and a prerequisite level' : ''}
  784: the birthdays I hold
  808: You told me the setup on ${input.portal.portalLabel} is done.
  810: No problem. The four: ${input.portal.accountLabel}, ${whoPhrase(input.fitNotes)} added with their birthday(s),
  829: That is already a yes - I have this one, and I'll run the morning with you.
  832: Approving this asks me to text you a week ahead, the evening before, and 15 minutes before it opens. I never r
  835: Approving this asks me to text you a week ahead, a checklist a few days out, the evening before, and 15 minute
  855: Your postal code gets the residents-first date, ${shortlist.residentPriorityDays} day${shortlist.residentPrior
  887: If you send me the link to the course page once you have picked one, the morning text will carry it.
apps/web/lib/registration/sequence/prepare-reply.ts (10)
  492: That link is not a secure one, so I did not open it. Send me the course page from ${portal} as it appears in y
  494: That link carries a sign-in inside it, so I did not open it. Send me the plain course page from ${portal}.
  498: That is not a course page I can read. Open the class on ${portal} and send me the link from the address bar.
  500: That link is longer than I can read. Send the course page link from ${portal} on its own line.
  502: That is another town's portal, and the morning I am holding is ${town}. Send me the ${town} course page.
  504: I could not read that page just now. Nothing has changed on my side - send it again and I will try once more.
  508: That page does not publish a registration date I can read, so I am staying on the ${town} dates I already have
  510: That course opens ${when(pageClock as Date, sequence.timeZone, now)} and the ${town} morning I am holding is $
  534: I already have that class from you, and I read one page at a time, so I have not opened it again. There is not
  536: I just tried a course page for you, and I read one at a time. I have not opened that link and I will not come 
apps/web/lib/registration/sequence/run.ts (1)
  1105: ${windowPhrase(args.shortlist)}: your plan, the evening before.
apps/web/lib/registration/verify-window.ts (2)
  332: Verbatim page text stating the YEAR these dates belong to.
  339: Verbatim page text the dates were read from.
apps/web/lib/signup/browser-use/engine.ts (1)
  502: Registration for "${input.session.label}" starting ${input.session.startsAt} on ${host}, which you asked Hale 
apps/web/lib/signup/connectors/copy.ts (1)
  17: I couldn't finish {session} with {provider}, so nothing is signed up. Here's the page if you'd like to do it y
apps/web/lib/signup/offer-copy.ts (1)
  11: It's {price}. Want me to try signing you up? I'll stop and hand it back if it asks for payment or a login.
apps/web/lib/signup/outcome-reply.ts (1)
  98: Write the one text the parent sees about this sign-up.
apps/web/lib/text-hale-target.ts (1)
  15: Hey Hale, what's going on?
apps/web/lib/travel/copy.ts (1)
  191: You're in ${input.city} ${dayPhrase}. A couple of things on for ${kids}:
apps/web/lib/travel/extract.ts (1)
  84: Why the booking's own text says a child is travelling, or 'none'.
apps/web/lib/village/intros/consent.ts (2)
  102: parent opted in to being introduced to other Hale families nearby
  103: parent opted out of being introduced to other Hale families
apps/web/lib/village/intros/copy.ts (10)
  72: Great - I'll keep an eye out. Nothing is shared until you both say yes, and you can tell me to stop anytime.
  76: Done - no intros. I won't bring this up again.
  91: You're already set - I'll keep an eye out.
  93: Already off - I won't bring it up.
  96: No problem - I'll keep looking.
  107: You're already in - I'll let you know if they are too.
  109: Already passed on that one - I'll keep looking.
  118: That one's closed now, but I'm still looking - I'll text you at the next good match.
  130: I don't have an intro waiting for you right now - I'll text you when there's a match.
  142: No intro this time - I'll keep an eye out.
apps/web/lib/village/intros/reply.ts (2)
  338: if the other family also says yes, Hale starts a group text with both
  339: none - do not promise or mention a group text or any next step with the other family
apps/web/lib/village/intros/voice.ts (1)
  293: Return the one text asking this family about an introduction.
apps/web/lib/village/social-proof.ts (1)
  25: loved by ${count} families near you```
