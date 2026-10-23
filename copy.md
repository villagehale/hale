# AI-search copy pass (before / after), by page
Branch `site/ai-search` (worktree, based on 906929ee). Nothing committed. Full diff: `site-ai-search.patch`. Every new string also has an FR (tu form, matching the site) and ZH twin in messages/{fr,zh}.json under `Rd`.

## /about
**Before:** Hero "A planner for your kids' year." / "Two parents building the helper we wanted." → Our mission → "The people" (Parent-built in Georgetown, Barton Dong CEO, Eugene Song CTO, Why "Hale") → Text Hale.

**After** (hero H1 and lede kept, since a test locks them):
- Value prop (second hero line): An iMessage and text helper that plans your kids' activities and your family's year, for parents in the US and Canada.
- Our mission (unchanged)
- **What Hale does**: Hale finds what's on near you for your kids' ages, reminds you before sign-ups open, keeps the family calendar straight and asks how it went. You text it like a friend. No app to download.
  - Hale finds activities near you, by age: swim, camps, drop-ins, library programs, rec classes and weekend plans, each with the page it came from.
  - It watches full classes and texts you when a spot opens, and reminds you before registration so you're ready.
  - If you connect Gmail and Google Calendar, it reads school and activity emails and keeps dates on your calendar. It asks before it adds or changes anything.
  - Send it a photo of a flyer or a schedule and it reads it. Write in any language and it replies in yours.
  - It works in your group chats with a co-parent, the carpool or other parents, and keeps track of who's in and who's driving.
- **What makes Hale different**
  - It lives in your texts. No app, no new account to learn.
  - It searches live and shows its source. Every date comes with the page it came from, and if they disagree, the source page wins.
  - It asks before it acts. Hale doesn't book, register or pay for you; you stay in charge.
  - It covers the whole kids' year, from the first months to almost grown, not one season or one app.
- **Who uses Hale**: Hale is for parents and caregivers in the US and Canada with kids from newborn to 18: the parent who keeps the family calendar, co-parents who share the load, and groups of parents planning together. We're just getting started, and founding families use Hale free.
- **How Hale works**
  1. Text Hale. It asks where you are and how old your kids are.
  2. It shows you what's on this week, picked for your kids.
  3. It texts you only when there's a reason: a heads-up before sign-ups, the link the night before, a question after the first class.
  4. Hale is free, with unlimited chat. Reply STOP any time.
- **The team behind Hale** (was the eyebrow "The people"; founders card unchanged)
- New AboutPage + Organization JSON-LD: legal name, Georgetown ON, founded 2026-06-24, aloha@villagehale.com, areaServed US + CA, founders Barton Dong (CEO) and Eugene Song (CTO, with LinkedIn).
- Meta description. Before: "Hale is a planner for your kids' year. Barton Dong, CEO, and Eugene Song, CTO, at Village Hale Technologies Inc." After: "Hale is an iMessage and text helper that plans kids' activities and the family year for parents in the US and Canada. Made by Barton Dong and Eugene Song at Village Hale Technologies Inc." (FR/ZH updated to match.) The title "About · Hale" stays because a test locks it.

## /faq (FAQPage JSON-LD already existed; it now picks up the new items)
Added:
- **Who is Hale for?** Parents and caregivers with kids from newborn to 18, plus the co-parents and other parents they plan with.
- **Where does Hale work?** In the US and Canada. Hale works by iMessage and regular text on a US or Canadian phone number.
- **What do paid plans cost?** Free is $0 with unlimited chat. Plus is $19 CAD a month or $159 a year, and Max is $39 CAD a month or $329 a year. Families who join now get every feature free until paid plans start.
The group ranges moved to fit. The faq.test.ts list of cleared questions was extended with these 3 entries; no assertion was loosened.

## /llms.txt
A new "About Hale" block now sits before the answer index: what it is, who it's for, what it does and doesn't do, how it works, price, company and founders, and links to /about, /faq and /pricing. The answer index follows under "## Answer pages".

## Homepage / pricing / robots / site JSON-LD: no change
- robots.ts already allows GPTBot, OAI-SearchBot, ChatGPT-User, PerplexityBot, Google-Extended, ClaudeBot, anthropic-ai and Claude-User.
- The homepage already outputs Organization, WebSite and SoftwareApplication JSON-LD. The pricing page already shows CAD prices in text.
- I tried new homepage meta and Jsonld descriptions that named US/Canada, but VIL-325 tests lock them, so I reverted. The US/Canada answer now lives on /about, /faq and llms.txt.

## Pricing (pricing page, homepage pricing block, FAQ, llms.txt): dual currency
- "$19 CAD/mo" → "$19 CAD/mo · $15 USD/mo"; "or $159 CAD/yr, about three months free" → "or $159 CAD / $129 USD a year, about three months free"
- "$39 CAD/mo" → "$39 CAD/mo · $29 USD/mo"; "or $329 CAD/yr…" → "or $329 CAD / $259 USD a year, about three months free"
- The FAQ cost answer and llms.txt use the same placeholders. FR and ZH match. Free stays "$0 CAD/mo" (locked).
- Pricing meta description (EN): "Prices are in Canadian dollars." → "Prices in Canadian or US dollars." (FR/ZH meta never named a currency).
- There's no geo mechanism on the site, so both currencies are listed statically.
