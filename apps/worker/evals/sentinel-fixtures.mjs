// Fixture corpus for the E2 sentinel eval (VIL-225). One synthetic family
// throughout (rule #1: synthetic names, no real PII): Leo (5yo, non-teen) and
// Maya (14yo, teenager). Every fixture's `expected` is SPEC-derived (what a
// human reading the email would conclude), never fitted to a model's output
// (CLAUDE.md rule #7).
//
// Categories, each covered at least twice per the ticket's corpus spec:
// cancellations, reschedules, e-vites (Evite/Paperless Post patterns), picture
// day, doctor reminders, daycare newsletters (noise), promo spam mentioning
// "kids" (hard negatives), French-language notices, and the teen personal-vs-
// logistics line.

export const RECEIVED_AT = '2026-07-20T09:00:00Z'; // a Monday
export const FAMILY_TIMEZONE = 'America/Toronto';

export const CHILDREN = [
  { id: 'child-leo', name: 'Leo', ageInMonths: 60 },
  { id: 'child-maya', name: 'Maya', ageInMonths: 168 },
];

/**
 * `expected` fields:
 *   triagePositive     — required. What triage should say.
 *   kind               — required when triagePositive (unless skipKindCheck).
 *   skipKindCheck       — true when the fixture exists to test something OTHER
 *                          than kind accuracy (e.g. the teen line) and the
 *                          "correct" kind is itself debatable.
 *   teenContent         — asserted only when present.
 *   expectedChildRef     — 'leo' | 'maya' | null | undefined (undefined = skip).
 *   requiresOriginalTime / requiresNewTime — asserted only when true.
 */
export const FIXTURES = [
  // ── true positives ─────────────────────────────────────────────────────
  {
    id: 'cancel-swim',
    envelope: {
      subject: 'Swim Class Update — This Saturday',
      from: 'Sunnybrook Swim School <info@sunnybrookswim.example.com>',
      snippet: "We're sorry to inform you that Leo's Level 2 swim class this Saturday has been cancelled due to a pool issue.",
    },
    body: "Hi families,\n\nWe're sorry to inform you that Leo's Level 2 swim class this Saturday, July 25th at 10:00 AM has been cancelled due to a pool maintenance issue. We will post a makeup date once the pool reopens.\n\nThank you for your understanding,\nSunnybrook Swim School",
    expected: { triagePositive: true, kind: 'cancellation', requiresOriginalTime: true, expectedChildRef: 'leo' },
  },
  {
    id: 'cancel-daycare-pd-day',
    envelope: {
      subject: 'Daycare Closed Wednesday — Professional Development Day',
      from: 'Little Sprouts Daycare <admin@littlesprouts.example.com>',
      snippet: 'Reminder that Little Sprouts will be closed this Wednesday for a staff professional development day.',
    },
    body: 'Dear parents,\n\nA reminder that Little Sprouts Daycare will be closed this Wednesday, July 22nd for a staff professional development day. Regular drop-off resumes Thursday morning.\n\nBest,\nLittle Sprouts Team',
    expected: { triagePositive: true, kind: 'cancellation', requiresOriginalTime: true, expectedChildRef: null },
  },
  {
    id: 'reschedule-soccer',
    envelope: {
      subject: 'Soccer Practice Moved to Thursday This Week',
      from: 'Riverside Youth Soccer <coach@riversidesoccer.example.com>',
      snippet: "Due to a field conflict, this week's U8 practice is moving from Tuesday to Thursday, same time.",
    },
    body: "Hi team,\n\nDue to a field scheduling conflict, this week's U8 practice is moving from Tuesday, July 21st at 5:00 PM to Thursday, July 23rd at 5:00 PM. Same field, just a new day.\n\nSee you there,\nCoach Sam",
    expected: { triagePositive: true, kind: 'reschedule', requiresOriginalTime: true, requiresNewTime: true, expectedChildRef: null },
  },
  {
    id: 'reschedule-conference',
    envelope: {
      subject: 'Parent-Teacher Conference Time Change — Leo',
      from: 'Maple Street Elementary <office@maplestreet.example.edu>',
      snippet: 'Your conference for Leo originally scheduled for 3:00 PM on July 28th has been moved to 4:30 PM the same day.',
    },
    body: 'Dear Parent/Guardian,\n\nYour parent-teacher conference regarding Leo, originally scheduled for 3:00 PM on Tuesday, July 28th, has been moved to 4:30 PM that same day due to a scheduling conflict with another family. We apologize for any inconvenience.\n\nMaple Street Elementary Office',
    expected: { triagePositive: true, kind: 'reschedule', requiresOriginalTime: true, requiresNewTime: true, expectedChildRef: 'leo' },
  },
  {
    id: 'invite-evite-birthday',
    envelope: {
      subject: "You're Invited! Ava's 6th Birthday Party",
      from: 'Evite <invitations@evite.example.com>',
      snippet: "Ava's mom has invited Leo to a birthday party on Saturday, August 8th at 2:00 PM at Jump Zone Trampoline Park.",
    },
    body: "You're invited!\n\nAva's 6th Birthday Party\nSaturday, August 8th at 2:00 PM\nJump Zone Trampoline Park, 123 Fun Ave\n\nLeo, we'd love for you to join us! Please RSVP by August 1st.\n\nHosted with Evite",
    expected: { triagePositive: true, kind: 'new_event', requiresNewTime: true, expectedChildRef: 'leo' },
  },
  {
    id: 'invite-paperless-post',
    envelope: {
      subject: 'Join us for a pool party!',
      from: 'Paperless Post <no-reply@paperlesspost.example.com>',
      snippet: "You've received an invitation to a pool party on Sunday, August 2nd at 1:00 PM.",
    },
    body: "Hi there,\n\nYou've received an invitation:\n\nPool Party for Noah's 7th Birthday\nSunday, August 2nd, 1:00 PM – 3:00 PM\n456 Lakeside Drive\n\nPlease reply to let us know if Leo can make it!\n\nSent via Paperless Post",
    expected: { triagePositive: true, kind: 'new_event', requiresNewTime: true, expectedChildRef: 'leo' },
  },
  {
    id: 'new-school-assembly',
    envelope: {
      subject: 'Save the Date: Fall Assembly & Open House',
      from: 'Maple Street Elementary <office@maplestreet.example.edu>',
      snippet: 'Please join us for our Fall Assembly and Open House on Friday, September 11th at 9:00 AM in the gymnasium.',
    },
    body: 'Dear Families,\n\nPlease save the date for our Fall Assembly and Open House on Friday, September 11th at 9:00 AM in the school gymnasium. All families are welcome to attend.\n\nMaple Street Elementary',
    expected: { triagePositive: true, kind: 'new_event', requiresNewTime: true, expectedChildRef: null },
  },
  {
    id: 'reminder-doctor-appt',
    envelope: {
      subject: 'Appointment Reminder: Leo — Tuesday 2:00 PM',
      from: 'Riverside Pediatrics <reminders@riversidepeds.example.com>',
      snippet: 'This is a reminder that Leo has an appointment with Dr. Chen this Tuesday, July 21st at 2:00 PM.',
    },
    body: 'Hello,\n\nThis is a friendly reminder that Leo has a check-up appointment with Dr. Chen scheduled for this Tuesday, July 21st at 2:00 PM. Please arrive 10 minutes early.\n\nRiverside Pediatrics',
    expected: { triagePositive: true, kind: 'reminder_only', requiresOriginalTime: true, expectedChildRef: 'leo' },
  },
  {
    id: 'reminder-picture-day',
    envelope: {
      subject: 'Reminder: Picture Day is This Friday',
      from: 'Maple Street Elementary <office@maplestreet.example.edu>',
      snippet: 'A reminder that Picture Day for all students is this Friday, July 24th. Please have Leo wear his best smile!',
    },
    body: 'Dear Families,\n\nJust a reminder that Picture Day for all students is this Friday, July 24th. Please have Leo dressed and ready — order forms are due by Thursday.\n\nMaple Street Elementary',
    expected: { triagePositive: true, kind: 'reminder_only', requiresOriginalTime: true, expectedChildRef: 'leo' },
  },
  {
    id: 'cancel-field-trip-weather',
    envelope: {
      subject: 'Field Trip Cancelled Due to Weather',
      from: 'Maple Street Elementary <office@maplestreet.example.edu>',
      snippet: "Due to the forecasted storm, tomorrow's zoo field trip for Leo's class has been cancelled.",
    },
    body: "Dear Parents,\n\nDue to the forecasted severe storm, tomorrow's (Wednesday, July 22nd) zoo field trip for Leo's class has been cancelled. Students should attend regular classes instead.\n\nMaple Street Elementary",
    expected: { triagePositive: true, kind: 'cancellation', requiresOriginalTime: true, expectedChildRef: 'leo' },
  },
  {
    id: 'reschedule-swim-time',
    envelope: {
      subject: 'Swim Class Time Change This Week Only',
      from: 'Sunnybrook Swim School <info@sunnybrookswim.example.com>',
      snippet: "This Saturday only, Leo's 10:00 AM class is moving to 11:30 AM due to a scheduling conflict.",
    },
    body: 'Hi families,\n\nFor this Saturday, July 25th only, Leo\'s swim class is moving from 10:00 AM to 11:30 AM due to a pool scheduling conflict. Regular time resumes next week.\n\nSunnybrook Swim School',
    expected: { triagePositive: true, kind: 'reschedule', requiresOriginalTime: true, requiresNewTime: true, expectedChildRef: 'leo' },
  },
  {
    id: 'invite-playdate',
    envelope: {
      subject: 'Playdate this weekend?',
      from: 'Jenny Park <jenny.park@example.com>',
      snippet: 'Would love to set up a playdate at the park this Saturday at 3pm if you\'re free!',
    },
    body: 'Hi!\n\nWe had so much fun last time — would love to set up a playdate at Riverside Park this Saturday, July 25th at 3:00 PM if you\'re free. Let me know!\n\nJenny',
    expected: { triagePositive: true, kind: 'new_event', requiresNewTime: true, expectedChildRef: null },
  },

  // ── hard negatives / noise ─────────────────────────────────────────────
  {
    id: 'noise-daycare-newsletter',
    envelope: {
      subject: 'Little Sprouts Monthly Newsletter — July',
      from: 'Little Sprouts Daycare <admin@littlesprouts.example.com>',
      snippet: "In this month's newsletter: summer safety tips, a note from the director, and garden project photos.",
    },
    body: "Dear Families,\n\nIn this month's newsletter: summer safety tips, a note from our director, and photos from our garden project. As always, thank you for being part of our community.\n\nLittle Sprouts Team",
    expected: { triagePositive: false },
  },
  {
    id: 'noise-promo-kids-clothing',
    envelope: {
      subject: "50% Off Kids' Summer Styles — Today Only!",
      from: 'TinyThreads <deals@tinythreads.example.com>',
      snippet: "Score huge savings on kids' summer clothing — today only, everything is half off!",
    },
    body: "Hi there,\n\nToday only: 50% off all kids' summer styles! Shop shorts, tees, and swimwear before this deal ends tonight.\n\nShop now,\nTinyThreads",
    expected: { triagePositive: false },
  },
  {
    id: 'noise-promo-family-meal-kit',
    envelope: {
      subject: 'Family Fun Night Starts With Dinner',
      from: 'HomeChef Kits <hello@homechefkits.example.com>',
      snippet: 'Get 40% off your first box and make family dinner night easy this week.',
    },
    body: 'Hi,\n\nMake family dinner night easy — get 40% off your first HomeChef box this week. Kid-approved recipes included!\n\nOrder now,\nHomeChef Kits',
    expected: { triagePositive: false },
  },
  {
    id: 'noise-work-unrelated',
    envelope: {
      subject: 'Q3 Project Timeline — Action Needed',
      from: 'Priya Shah <priya.shah@example.com>',
      snippet: 'Can you review the attached timeline before our sync tomorrow? A few dates moved.',
    },
    body: 'Hi,\n\nCan you review the attached Q3 project timeline before our sync tomorrow? A few milestone dates moved around. Let me know if you have questions.\n\nThanks,\nPriya',
    expected: { triagePositive: false },
  },
  {
    id: 'noise-shipping-notification',
    envelope: {
      subject: 'Your package has shipped',
      from: 'Amazon <shipment-tracking@amazon.example.com>',
      snippet: "Your order of 'Kids Rain Boots, Size 11' has shipped and will arrive Thursday.",
    },
    body: "Hello,\n\nYour order of 'Kids Rain Boots, Size 11' has shipped and is expected to arrive Thursday, July 23rd. Track your package here.\n\nAmazon",
    expected: { triagePositive: false },
  },
  {
    id: 'noise-parenting-blog',
    envelope: {
      subject: '5 Tips for Better Toddler Bedtimes',
      from: 'Parenting Weekly <newsletter@parentingweekly.example.com>',
      snippet: 'This week: five expert-backed tips to help your toddler wind down and sleep better.',
    },
    body: "Hi there,\n\nThis week's newsletter: five expert-backed tips to help your toddler wind down and sleep better, plus reader questions answered.\n\nParenting Weekly",
    expected: { triagePositive: false },
  },
  {
    id: 'noise-daycare-policy-update',
    envelope: {
      subject: 'Updated Illness Policy — Please Review',
      from: 'Little Sprouts Daycare <admin@littlesprouts.example.com>',
      snippet: "We've updated our illness policy for the upcoming school year. Please review the attached section.",
    },
    body: "Dear Families,\n\nWe've updated our illness policy for the upcoming school year — please review the attached handbook section at your convenience. No action needed unless you have questions.\n\nLittle Sprouts Team",
    expected: { triagePositive: false },
  },
  {
    id: 'noise-fundraiser-general',
    envelope: {
      subject: 'Support Our Annual Fundraiser',
      from: 'Maple Street PTA <pta@maplestreet.example.edu>',
      snippet: "Our annual fundraiser is now open online — help us reach this year's goal for new playground equipment.",
    },
    body: "Dear Families,\n\nOur annual fundraiser is now open online — help us reach this year's goal of $5,000 for new playground equipment. Every contribution helps!\n\nMaple Street PTA",
    expected: { triagePositive: false },
  },

  // ── French-language ─────────────────────────────────────────────────────
  {
    id: 'french-cancel-natation',
    envelope: {
      subject: 'Cours de natation annulé samedi',
      from: 'École de natation Rivière-Bleue <info@riviere-bleue.example.com>',
      snippet: "Le cours de natation de Léo prévu samedi le 25 juillet à 10h00 est annulé en raison d'un problème technique.",
    },
    body: "Bonjour,\n\nNous sommes désolés de vous informer que le cours de natation de Léo prévu samedi le 25 juillet à 10h00 est annulé en raison d'un problème technique à la piscine. Une date de reprise sera communiquée bientôt.\n\nMerci de votre compréhension,\nÉcole de natation Rivière-Bleue",
    // Accented "Léo" vs the family's stored "Leo" is a genuine name-matching edge
    // case — not asserted here, only kind/triage (see module header).
    expected: { triagePositive: true, kind: 'cancellation', requiresOriginalTime: true },
  },
  {
    id: 'french-noise-newsletter',
    envelope: {
      subject: 'Infolettre mensuelle — Garderie Petits Soleils',
      from: 'Garderie Petits Soleils <info@petitssoleils.example.com>',
      snippet: "Dans cette infolettre : conseils d'été, un mot de la directrice et des photos de notre jardin.",
    },
    body: "Chers parents,\n\nDans cette infolettre de juillet : conseils de sécurité pour l'été, un mot de notre directrice et des photos de notre projet de jardin. Merci de faire partie de notre communauté.\n\nGarderie Petits Soleils",
    expected: { triagePositive: false },
  },

  // ── teen line: personal correspondence vs logistics-about-a-teen ────────
  {
    id: 'teen-logistics-picture-day',
    envelope: {
      subject: 'Picture Day Reminder — Grade 9',
      from: 'Riverside High School <office@riversidehigh.example.edu>',
      snippet: 'A reminder that Picture Day for Grade 9 students, including Maya, is this Friday, July 24th.',
    },
    body: 'Dear Families,\n\nA reminder that Picture Day for all Grade 9 students, including Maya, is this Friday, July 24th during homeroom. No action needed — just have them arrive as usual.\n\nRiverside High School',
    expected: {
      triagePositive: true,
      kind: 'reminder_only',
      requiresOriginalTime: true,
      expectedChildRef: 'maya',
      teenContent: false,
    },
  },
  {
    id: 'teen-personal-correspondence',
    envelope: {
      subject: "Maya's counselling session — rescheduled",
      from: 'Ms. Alvarez, School Counsellor <alvarez@riversidehigh.example.edu>',
      snippet: "Maya's session is moving from this Thursday to next Wednesday at 3pm — she's been feeling overwhelmed about exams and some friction with friends, so wanted to keep you in the loop.",
    },
    body: "Hi there,\n\nJust a note that Maya's counselling session is moving from this Thursday, July 23rd to next Wednesday, July 29th at 3:00 PM — I had a conflict come up. Also wanted to mention: she's been feeling overwhelmed about her upcoming exams and some friction with a couple of friends. Nothing urgent, just wanted to keep you in the loop before we talk again.\n\nWarmly,\nMs. Alvarez",
    expected: {
      triagePositive: true,
      kind: 'reschedule',
      requiresOriginalTime: true,
      requiresNewTime: true,
      expectedChildRef: 'maya',
      teenContent: true,
    },
  },

  // ── genuinely unclear ────────────────────────────────────────────────────
  {
    id: 'unclear-ambiguous',
    envelope: {
      subject: 'Quick update',
      from: 'Little Sprouts Daycare <admin@littlesprouts.example.com>',
      snippet: "Just wanted to give you a heads up about something happening in Leo's room — more details soon.",
    },
    body: "Hi there,\n\nJust wanted to give you a heads up about something happening in Leo's room this week — we'll share more details soon. Nothing to worry about!\n\nLittle Sprouts Team",
    expected: { triagePositive: true, kind: 'unclear', expectedChildRef: 'leo' },
  },
];
