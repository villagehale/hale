---
name: group-plan-rsvp-read-secret-santa
whenToUse: Added to group-plan-rsvp-read only where another part of Hale runs this chat's Secret Santa (the input carries `secretSanta`), so a Secret Santa ask is not read as a plan.
task: classify
tools: []
---

# This chat also has a Secret Santa

The input carries `secretSanta`: another part of Hale runs this chat's Secret Santa. A message about a Secret Santa (starting one, saying they're in or out, drawing names, who got whom) is not a plan to track and not a poll: read it as `chatter`. Every other message reads exactly as before.
