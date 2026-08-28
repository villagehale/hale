import type { RegistrationGuide } from './types';

const TORONTO_REC =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/register-for-recreation-activities/';
const TORONTO_HOW_TO =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/how-to-use-our-services/how-to-register-for-recreation-programs/online-registration-booking/';
const TORONTO_PORTAL = 'https://www.toronto.ca/OnlineReg';
const TORONTO_SWIM_LESSONS =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/swim-water-activities/swim-lessons-and-leadership/';
const BRAMPTON_REGISTERED =
  'https://www.brampton.ca/EN/residents/Recreation/Pages/Registered-Programs.aspx';
const BRAMPTON_VERIFY =
  'https://www.brampton.ca/EN/residents/Recreation/Pages/Resident-Account-Verification.aspx';
const BRAMPTON_FAQ =
  'https://www.brampton.ca/EN/residents/Recreation/Pages/New-Recreation-Software-FAQ.aspx';
const BRAMPTON_HOW_TO =
  'https://www.brampton.ca/EN/residents/Recreation/Customer-Care/Pages/How-To-Register.aspx';
const YMCA_HOME = 'https://www.ymcagta.org/';
const YMCA_PORTAL = 'https://MyY.YMCAGTA.ORG';

const UNOFFICIAL =
  'Hale is unofficial. Confirm every date on the official link in this block — if the city page has moved, the city page wins.';

const FOOTER =
  'Hale is a number you text, not an app. Founding families keep their rate. Your data stays in Canada.';

export const TORONTO_FALL: RegistrationGuide = {
  slug: 'toronto-fall-recreation-registration',
  path: '/toronto-fall-recreation-registration',
  title: 'Toronto fall recreation registration 2026: dates by district · Hale',
  description:
    'Toronto fall recreation registration 2026 opens by district, not by your home address. Wishlist is open; Early Local Registration is Sept 9; Etobicoke, Toronto and East York go Sept 15 at 7 a.m.; North York and Scarborough go Sept 16. Hale is unofficial — confirm on toronto.ca.',
  eyebrow: 'Toronto · fall 2026',
  h1: [
    { text: 'Toronto fall recreation registration 2026:' },
    { text: 'which 7 a.m. is yours', accent: true },
  ],
  lede: 'The morning that matters is the district of the centre you are booking, not the street you live on. I’m Barton, Sebastian’s dad. Hale is a texted GTA family assistant — no app — and founding families are free at villagehale.com.',
  updated: '2026-08-26',
  placement: 'toronto_fall_rec',
  datesEyebrow: 'Fall 2026',
  datesHeading: [{ text: 'Fall 2026 dates' }, { text: 'at a glance', accent: true }],
  dateRows: [
    { when: 'Aug 24', what: 'Wishlist open in the Registration & Booking System' },
    { when: 'Sept 9, 7 a.m.', what: 'Early Local Registration — all Free Centres, catchment only' },
    { when: 'Sept 14, 10 a.m.', what: 'Older adult programs (60+)' },
    { when: 'Sept 15, 7 a.m.', what: 'Etobicoke, Toronto, and East York centres' },
    { when: 'Sept 16, 7 a.m.', what: 'North York and Scarborough centres' },
    { when: '36 hours', what: 'Waitlist invitations expire, then the spot is offered onward' },
    {
      when: 'Week of Sept 26',
      what: 'Most fall programs start (see the activity for the real dates)',
    },
    {
      when: 'Winter look-ahead',
      what: 'Browse around Nov 17; register around Dec 1–9 — anticipated on the city page, not a printed clock yet',
    },
  ],
  dateNote:
    'Reconfirmed Aug 26, 2026 against the city page last modified Aug 24, 2026. Confirm on the official link — if Toronto has changed a morning, use Toronto.',
  officialUrls: [
    { href: TORONTO_REC, label: 'City of Toronto — register for recreation activities' },
    { href: TORONTO_HOW_TO, label: 'How to use the Registration & Booking System' },
    { href: TORONTO_PORTAL, label: 'toronto.ca/OnlineReg — the rec portal' },
  ],
  unofficialNote: UNOFFICIAL,
  rulesEyebrow: 'The miss',
  rulesHeading: [{ text: 'Three rules that make' }, { text: 'parents miss', accent: true }],
  ruleCards: [
    {
      tag: 'District',
      title: 'The district is the centre, not your address',
      line: 'A Leslieville parent booking a North York pool registers on Sept 16. Home address does not pick the morning.',
      checks: [
        'Look up the centre on the city’s community recreation centre list',
        'Etobicoke York includes York, Weston, and Mount Dennis — they go Sept 15',
        'Swimming opens on these same mornings',
      ],
      linkHref: '/toronto-swim-registration',
      linkLabel: 'Toronto swim uses this same calendar',
    },
    {
      tag: 'Sept 9',
      title: 'Early Local Registration is catchment only',
      line: 'Sept 9 at 7 a.m. is not a city-wide head start. It is Free Centres, for eligible residents in that centre’s catchment.',
      checks: [
        'If the program is not at a Free Centre, skip Sept 9',
        'If you are out of catchment, skip Sept 9',
        'Everyone else waits for their district’s 7 a.m.',
      ],
    },
    {
      tag: '36 hours',
      title: 'The waitlist will not show your queue number',
      line: 'If a spot opens you get an email invitation. It expires in 36 hours, then it is dropped. You never see “you are #12”.',
      checks: [
        'Keep the email on the Parks & Recreation account current',
        'Watch the inbox — not the live activity page — for the offer',
        'Withdraw early if you cannot go, so the next family gets the 36 hours',
      ],
    },
  ],
  sections: [
    {
      id: 'wishlist-not-efun',
      headline: [{ text: 'Wishlist is open now —' }, { text: 'not in eFun', accent: true }],
      paragraphs: [
        'Fall activities are in the Registration & Booking System. Add the barcode to your wish list as soon as the activity is viewable. You register from that list when the district clock starts. Searching live at 7:00 a.m. is how people miss.',
        'eFun family numbers and client numbers do not work. The city says they are no longer in use. You need the email account in the new system, a password you can type at 6:58 a.m., and Welcome Policy already sitting on the account if you use it — you cannot add it at checkout.',
      ],
      links: [{ href: TORONTO_HOW_TO, label: 'Wish list, Welcome Policy, and checkout' }],
    },
    {
      id: 'activeto-not-this',
      headline: [{ text: 'ActiveTO is not' }, { text: 'the swim portal', accent: true }],
      lede: 'Then we move on.',
      paragraphs: [
        'ActiveTO is not City of Toronto rec registration. Rec is toronto.ca/OnlineReg (the Active Communities portal at anc.ca.apm.activecommunities.com/toronto). FitnessTO is memberships. The old FUN Guide is now FallRec.',
        'eFun has been gone since late 2024. Parents still search it. That search should land here, then on the official register — not on a retired login.',
      ],
      links: [{ href: TORONTO_PORTAL, label: 'The rec portal, not ActiveTO' }],
    },
    {
      id: 'night-before',
      headline: [{ text: 'Night-before' }, { text: 'checklist', accent: true }],
      paragraphs: [
        'Do this on paper, not in your head, the evening of Sept 14 or 15 depending on the centre.',
      ],
      bullets: [
        'Password that actually signs in — reset it tonight, not at 6:59 a.m.',
        'Course numbers on paper, in wish-list order, most wanted last so it sits at the top',
        'Welcome Policy already on the account if you need it',
        'Email you will actually see if a 36-hour waitlist invitation lands',
      ],
    },
    {
      id: 'in-person-desks',
      headline: [{ text: 'In-person desks,' }, { text: 'Sept 15 vs Sept 16', accent: true }],
      paragraphs: [
        'If you want staff at a centre on the opening morning, the city publishes which desks open early for the 7 a.m. start. This is their list, not Hale’s — confirm it on the official page before you travel.',
      ],
      groups: [
        {
          title: 'Tuesday, Sept 15 — Toronto, East York, and Etobicoke',
          items: [
            'Etobicoke Olympium, 590 Rathburn Rd.',
            'Northwood Community Centre, 15 Clubhouse Crt.',
            'York Recreation Centre, 115 Black Creek Dr.',
            'Mary McCormick Community Centre, 66 Sheridan Ave.',
            'Wellesley Community Centre, 495 Sherbourne St.',
            'Regent Park Community Centre, 402 Shuter St.',
          ],
        },
        {
          title: 'Wednesday, Sept 16 — North York and Scarborough',
          items: [
            'Centennial Recreation Centre – Scarborough, 1967 Ellesmere Rd.',
            'Rouge Valley Community Recreation Centre, 8450 Sheppard Ave. E.',
            'Dennis R. Timbrell Resource Centre, 29 St. Dennis Dr.',
            'Ethennonnhawahstihnen’ Community Recreation Centre and Library, 100 Ethennonnhawahstihnen’ Ln.',
          ],
        },
      ],
      links: [{ href: TORONTO_REC, label: 'City’s published in-person locations' }],
    },
    {
      id: 'winter',
      headline: [{ text: 'Winter look-ahead —' }, { text: 'Hale will text you', accent: true }],
      paragraphs: [
        'The city currently says winter activities should be available to browse around Nov 17, with registration anticipated between Dec 1 and 9, starting the week of Jan 4, 2027. Those are look-ahead dates, not a printed 7 a.m. clock. Do not treat them as exact until the city page is specific.',
        'Hale already knows whether Sept 15 or Sept 16 is your pool. Text Hale — founding families free. Start at villagehale.com.',
      ],
    },
  ],
  faqs: [
    {
      question: 'When does Toronto fall recreation registration open?',
      answer:
        'Wishlist is open now. Early Local Registration for Free Centres is Sept 9 at 7 a.m. (catchment only). Etobicoke, Toronto, and East York centres open Sept 15 at 7 a.m. North York and Scarborough open Sept 16 at 7 a.m. Confirm on toronto.ca — Hale is unofficial.',
    },
    {
      question: 'Which day is North York fall recreation registration?',
      answer:
        'North York and Scarborough centres register Wednesday, Sept 16 at 7 a.m. The day follows the centre you are booking, not your home address. A Leslieville parent booking North York is still Sept 16.',
    },
    {
      question: 'Is eFun still used for Toronto rec registration?',
      answer:
        'No. eFun has been gone since late 2024. Fall 2026 uses the Registration & Booking System at toronto.ca/OnlineReg. Old eFun family numbers do not work.',
    },
    {
      question: 'How long is the Toronto recreation waitlist invitation?',
      answer:
        '36 hours. You get an email if a spot opens. You will not see your queue number. If you do not take it in 36 hours, it is offered to the next person.',
    },
    {
      question: 'Is Toronto swim registration a different morning from rec?',
      answer:
        'No. Swim opens on the same district morning as the rest of rec — Sept 15 or Sept 16 at 7 a.m., with Early Local Registration on Sept 9 only if that pool is a Free Centre in catchment.',
    },
  ],
  ctaHeading: 'Hale already knows whether Sept 15 or Sept 16 is your pool.',
  ctaSub:
    'Text Hale — founding families free. Start at villagehale.com. I’m Barton, Sebastian’s dad; Hale is a number you text, not an app.',
  footerNote: FOOTER,
};

export const TORONTO_SWIM: RegistrationGuide = {
  slug: 'toronto-swim-registration',
  path: '/toronto-swim-registration',
  title: 'Toronto swim registration 2026: same mornings as rec, not a separate day · Hale',
  description:
    'Toronto swim registration 2026 is not a separate day. Lessons open on your centre’s rec morning — Sept 15 or Sept 16 at 7 a.m. — in the Registration & Booking System, not eFun, not ActiveTO. Hale is unofficial; confirm on toronto.ca.',
  eyebrow: 'Toronto · swim 2026',
  h1: [
    { text: 'Toronto swim registration 2026:' },
    { text: 'it is not a separate day', accent: true },
  ],
  lede: 'There is no swim-only date. Guardian, Preschool, Tiny Tots, and Ultra open on the same 7 a.m. as the centre’s district. Tell Hale the pool and the Ultra level. Founding families free — villagehale.com.',
  updated: '2026-08-26',
  placement: 'toronto_swim',
  datesEyebrow: 'Swim mornings',
  datesHeading: [{ text: 'Swim opens on your' }, { text: 'district’s rec morning', accent: true }],
  dateRows: [
    {
      when: 'Sept 9, 7 a.m.',
      what: 'Early Local Registration — only if this pool is a Free Centre in catchment',
    },
    { when: 'Sept 15, 7 a.m.', what: 'Etobicoke, Toronto, and East York pools' },
    { when: 'Sept 16, 7 a.m.', what: 'North York and Scarborough pools' },
    { when: '36 hours', what: 'Swim waitlist invitations expire, then the lane is offered onward' },
    {
      when: 'Until class 3',
      what: 'You can still register up to the start of the third class, space permitting',
    },
  ],
  dateNote:
    'Same calendar as fall rec. Reconfirmed Aug 26, 2026 against the city rec page (modified Aug 24) and the swim lessons page. Confirm on the official links.',
  officialUrls: [
    { href: TORONTO_SWIM_LESSONS, label: 'City of Toronto — swim lessons and leadership' },
    { href: TORONTO_REC, label: 'Fall rec dates (swim uses these mornings)' },
    { href: TORONTO_PORTAL, label: 'toronto.ca/OnlineReg' },
  ],
  unofficialNote: UNOFFICIAL,
  rulesEyebrow: 'The miss',
  rulesHeading: [{ text: 'Three swim rules' }, { text: 'people still get wrong', accent: true }],
  ruleCards: [
    {
      tag: 'Same morning',
      title: 'No swim-only date',
      line: 'If the centre is East York, you are in the Sept 15 7 a.m. wave with every other program at that centre. Ultra is not a different clock.',
      checks: [
        'Early Local Registration on Sept 9 only if the pool itself is a Free Centre in catchment',
        'ActiveTO is not this portal',
        'Fall rec uses this same district calendar',
      ],
      linkHref: '/toronto-fall-recreation-registration',
      linkLabel: 'Toronto fall rec dates by district',
    },
    {
      tag: 'Wishlist',
      title: 'Wishlist the barcode. Don’t search live.',
      line: 'At 7:00 a.m. the people who get in already have the activity on a wish list. Searching “swim” while the queue builds is how a Saturday 9 a.m. Ultra 3 disappears.',
      checks: [
        'Add the heart on the exact barcode, for the exact child',
        'Build the list in reverse — most wanted last, so it sits at the top',
        'Have the report card open before 6:58 a.m. so you are not guessing the level in the cart',
      ],
    },
    {
      tag: '36 hours',
      title: 'Swim waitlist is still 36 hours',
      line: 'Same as the rest of rec: email invitation, no queue number on the page, then dropped. A leftover Tuesday 10 a.m. is not the Saturday you wanted — take the offer or leave it for the next family.',
      checks: [
        'The invitation is email, then gone',
        'What fills in four minutes is Saturday morning Ultra and Guardian at the popular tanks',
        'What is left at 10 a.m. is often the awkward time, not “swim is still open”',
      ],
    },
  ],
  sections: [
    {
      id: 'which-morning',
      headline: [{ text: 'Which morning' }, { text: 'is this pool?', accent: true }],
      lede: 'Examples only — confirm the centre on the city’s list. This is not every indoor pool.',
      paragraphs: [
        'These names are the city’s own opening-morning desks, used here as a sketch of which wave a tank sits in. If your pool is not on this list, look up its district rather than guessing from your neighbourhood.',
      ],
      groups: [
        {
          title: 'Sept 15 examples — Etobicoke, Toronto, East York',
          items: [
            'Etobicoke Olympium',
            'York Recreation Centre',
            'Wellesley Community Centre',
            'Regent Park Community Centre',
            'Mary McCormick Community Centre',
          ],
        },
        {
          title: 'Sept 16 examples — North York, Scarborough',
          items: [
            'Centennial Recreation Centre – Scarborough',
            'Rouge Valley Community Recreation Centre',
            'Dennis R. Timbrell Resource Centre',
            'Ethennonnhawahstihnen’ Community Recreation Centre',
          ],
        },
      ],
      links: [{ href: TORONTO_REC, label: 'Confirm the centre on the city rec page' }],
    },
    {
      id: 'what-to-type',
      headline: [{ text: 'What to type:' }, { text: 'city language, not Red Cross', accent: true }],
      paragraphs: [
        'The city names the levels Guardian 1–3, Preschool 1–4 and Tiny Tots, Ultra Swim 1–9, Youth Ultra, and Adapted. That is the language in the portal. It is not Red Cross, and it is not YMCA Otter.',
      ],
      links: [
        {
          href: TORONTO_SWIM_LESSONS,
          label: 'City swim lessons page — one hop, no conversion chart',
        },
      ],
    },
    {
      id: 'missed-it',
      headline: [
        { text: 'Missed the morning?' },
        { text: 'Third class, not leisure swim', accent: true },
      ],
      paragraphs: [
        'The city lets you register for Learn to Swim up to the start of the third class, space permitting. Leisure swim and family swim are not a lesson. If the city lane is gone, the backups are a different portal: YMCA Greater Toronto on Aug 27 at 9 a.m. (membership to take many group classes), then private.',
      ],
      links: [
        {
          href: '/ymca-gta-swim-registration',
          label: 'YMCA Greater Toronto swim — Aug 27 at 9 a.m.',
        },
        { href: TORONTO_SWIM_LESSONS, label: 'Official swim lessons page' },
      ],
    },
  ],
  faqs: [
    {
      question: 'Is Toronto swim registration a different day from rec?',
      answer:
        'No. Swim opens on the centre’s rec morning — Sept 15 or Sept 16 at 7 a.m. There is no swim-only date. Early Local Registration on Sept 9 applies only if that pool is a Free Centre in catchment.',
    },
    {
      question: 'How do I know if my pool is Sept 15 or Sept 16?',
      answer:
        'By the district of the centre, not your home address. Etobicoke, Toronto, and East York centres (including York Recreation Centre) go Sept 15. North York and Scarborough go Sept 16. Confirm the centre on toronto.ca.',
    },
    {
      question: 'Is eFun used for Toronto swimming lessons registration?',
      answer:
        'No. eFun is gone. Use the Registration & Booking System at toronto.ca/OnlineReg. ActiveTO is not the swim portal.',
    },
    {
      question: 'How long do I have to take a Toronto swim waitlist spot?',
      answer:
        '36 hours from the email invitation. You will not see a queue number. If you do not confirm, the spot is offered to the next person.',
    },
    {
      question: 'What do I type instead of Red Cross or Otter?',
      answer:
        'City language: Guardian 1–3, Preschool 1–4 / Tiny Tots, Ultra Swim 1–9, Youth Ultra, Adapted. Check the report card before 6:58 a.m. The city’s swim lessons page names the levels.',
    },
  ],
  ctaHeading: 'Tell Hale the pool and the Ultra level.',
  ctaSub: 'Hale texts the night before and as it opens. Founding families free — villagehale.com.',
  footerNote: FOOTER,
};

export const BRAMPTON_SWIM: RegistrationGuide = {
  slug: 'brampton-swim-registration',
  path: '/brampton-swim-registration',
  title: 'Brampton swim registration 2026: September 9 (not August 24) · Hale',
  description:
    'Brampton swim registration 2026 is Wednesday, September 9 at 7 a.m. for residents — not August 24. That earlier morning was general rec, not Learn to Swim. Resident verification is in person. Waitlist pending-confirmation is 24 hours. Hale is unofficial; confirm on brampton.ca.',
  eyebrow: 'Brampton · swim 2026',
  h1: [
    { text: 'Brampton swim registration is' },
    { text: 'September 9, not August 24', accent: true },
  ],
  lede: 'General rec already opened Aug 24. That was not swim. Learn to Swim and Learn to Skate open Wednesday, Sept 9 at 7 a.m. for residents, Monday, Sept 21 at 7 a.m. for non-residents. Sept 9 is the swim morning. Hale watches kids\' swim for parents. Adult lessons stay on the city page. Text your kids\' names, ages, and postal and I\'ll watch Sept 9. Founding families free.',
  updated: '2026-08-26',
  placement: 'brampton_swim',
  datesEyebrow: 'Split calendar',
  datesHeading: [{ text: 'Swim is later.' }, { text: 'The calendar is split.', accent: true }],
  dateRows: [
    {
      when: 'Aug 24, 7 a.m.',
      what: 'General rec, sports, STEAM, and winter-break camps — already open. Not swim.',
    },
    { when: 'Sept 9, 7 a.m.', what: 'Learn to Swim and Learn to Skate — residents' },
    { when: 'Sept 21, 7 a.m.', what: 'Learn to Swim and Learn to Skate — non-residents' },
    { when: '24 hours', what: 'Waitlist pending-confirmation window (not Toronto’s 36)' },
    {
      when: 'Sept 21 – Dec 13',
      what: 'Fall session run (Guardian and the rest of the listed season)',
    },
  ],
  dateNote:
    'Reconfirmed Aug 26, 2026 on Brampton’s registered-programs page: Learn to Swim still reads Wednesday, September 9 at 7 a.m. (residents). Confirm there before you set an alarm.',
  officialUrls: [
    { href: BRAMPTON_REGISTERED, label: 'City of Brampton — registered programs' },
    { href: BRAMPTON_VERIFY, label: 'Resident account verification' },
    { href: BRAMPTON_HOW_TO, label: 'How to register, including the 24-hour waitlist' },
    { href: BRAMPTON_FAQ, label: 'Recreation registration FAQ' },
  ],
  unofficialNote: UNOFFICIAL,
  rulesEyebrow: 'The miss',
  rulesHeading: [
    { text: 'Why Brampton parents' },
    { text: 'show up on the wrong morning', accent: true },
  ],
  ruleCards: [
    {
      tag: 'Split',
      title: 'Aug 24 already happened. It was not swim.',
      line: 'Winter-break camps and general rec used that morning. Mixing them into swim is how you “register” for the wrong product and miss Sept 9.',
      checks: [
        'Learn to Swim and Learn to Skate share Sept 9 / Sept 21',
        'Brampton Lifesaving Club is not Learn to Swim — stay off that product if you wanted lessons',
        'The fall session still runs ~Sept 21 to Dec 13',
      ],
    },
    {
      tag: 'In person',
      title: 'Resident verification is in person, before Sept 9',
      line: 'Photo ID plus a Brampton address, at a rec-centre desk. You cannot email a licence. New accounts default to non-resident, which means you get the Sept 21 clock and the non-resident rate.',
      checks: [
        'A driver’s licence usually covers photo and address in one card',
        'Children under 18 need a verified adult on the account',
        'Do this on a weekday before Sept 9, not at 6:50 a.m. that morning',
      ],
    },
    {
      tag: '24 hours',
      title: 'Waitlist pending-confirmation is 24 hours',
      line: 'Not Toronto’s 36. If Brampton offers you a spot, you have a day. The city’s how-to page is the source.',
      checks: [
        'Look for pending confirmation on the account, not a queue number',
        'Confirm inside 24 hours or the spot moves on',
        'This is Brampton’s portal — not Toronto, not Active Mississauga',
      ],
    },
  ],
  sections: [
    {
      id: 'check-validated',
      headline: [{ text: 'How to check' }, { text: 'Account & Residency Validated', accent: true }],
      paragraphs: [
        'On desktop, sign in to the Brampton recreation account, open the family member, and use the Account Validation (or Account Verification) tab. You want “Account & Residency Validated” with a checkmark and a date. If that line is missing, the city will treat you as a non-resident on Sept 9.',
      ],
      links: [{ href: BRAMPTON_VERIFY, label: 'Resident account verification — official steps' }],
    },
    {
      id: 'which-pools',
      headline: [{ text: 'Which pools —' }, { text: 'not one mega-pool', accent: true }],
      lede: 'Confirm hours and which tank is running Learn to Swim on the city pages at publish. These are the usual Brampton tanks, not a claim that every lesson is in one building.',
      paragraphs: [
        'Lessons run across the city’s rec centres, not a single mega-pool. Names parents actually search: Balmoral Recreation Centre, Cassie Campbell Community Centre, Gore Meadows Community Centre, and Chinguacousy Wellness Centre. Check the live listing for the barcode you want.',
      ],
    },
    {
      id: 'ymca-backup',
      headline: [{ text: 'City vs' }, { text: 'YMCA Brampton', accent: true }],
      paragraphs: [
        'YMCA Greater Toronto swim registration is Thursday, Aug 27 at 9 a.m. — members and non-residents on the same clock, membership still required to take many group classes, on My Y, not Brampton’s portal. If the city lane on Sept 9 is the one you want, do not spend Aug 27 in the wrong system. If you need a backup, YMCA is a different morning and a different membership gate.',
      ],
      links: [
        {
          href: '/ymca-gta-swim-registration',
          label: 'YMCA Greater Toronto swim — Aug 27 at 9 a.m.',
        },
      ],
    },
  ],
  faqs: [
    {
      question: 'When is Brampton swim registration 2026?',
      answer:
        'Learn to Swim (and Learn to Skate) open Wednesday, September 9 at 7 a.m. for residents and Monday, September 21 at 7 a.m. for non-residents. August 24 was general rec and winter-break camps, not swim.',
    },
    {
      question: 'Why is Brampton swim later than August 24?',
      answer:
        'Brampton splits the calendar. Most registered programs already opened Aug 24. Aquatics and skating keep their own morning so the city can run those activities on a later clock. Showing up on Aug 24 does not get you a swim lane.',
    },
    {
      question: 'Can I email my driver’s licence for Brampton resident verification?',
      answer:
        'No. Verification is in person at a recreation centre desk with photo ID and a Brampton address. New accounts default to non-resident until a staff member validates them. Check for “Account & Residency Validated” on the account.',
    },
    {
      question: 'Is the Brampton waitlist 36 hours like Toronto?',
      answer:
        'No. Brampton’s pending-confirmation window is 24 hours. Toronto rec is 36. Do not reuse the Toronto number on a Brampton offer.',
    },
    {
      question: 'Is Brampton Lifesaving Club the same as Learn to Swim?',
      answer:
        'No. Lifesaving Club is a different product. If you wanted lessons, stay on Learn to Swim for the Sept 9 open.',
    },
  ],
  ctaHeading: 'Sept 9 is the swim morning, not Aug 24.',
  ctaSub:
    "Hale watches kids' swim for parents. Adult lessons stay on the city page. Text your kids' names, ages, and postal and I'll watch Sept 9. Founding families free.",
  footerNote: FOOTER,
  smsPrefill: 'Maya is 4, Theo is 18 months, L6Y',
};

export const YMCA_GTA: RegistrationGuide = {
  slug: 'ymca-gta-swim-registration',
  path: '/ymca-gta-swim-registration',
  title: 'YMCA Greater Toronto swim registration: August 27 at 9 a.m. · Hale',
  description:
    'YMCA Greater Toronto swim registration is Thursday, August 27, 2026 at 9:00 a.m. for members and non-residents on the same clock. Portal is MyY.YMCAGTA.ORG. Membership is still required to take many group Learn to Swim classes. Confirm on My Y.',
  eyebrow: 'YMCA Greater Toronto · swim',
  h1: [
    { text: 'YMCA Greater Toronto swim registration:' },
    { text: 'August 27 at 9 a.m.', accent: true },
  ],
  lede: 'Thursday, Aug 27, 2026, 9:00 a.m. — members and non-residents, same clock. Membership still required to take many group Learn to Swim classes. Portal is My Y, not eFun, not PerfectMind, not Active Mississauga. Hale will run that morning with you. Founding families free — villagehale.com.',
  updated: '2026-08-26',
  placement: 'ymca_gta_swim',
  datesEyebrow: 'One clock',
  datesHeading: [{ text: 'Aug 27 at 9 a.m.,' }, { text: 'membership first', accent: true }],
  dateRows: [
    { when: 'Aug 27, 9:00 a.m.', what: 'Members and non-residents — same open on My Y' },
    {
      when: 'Membership',
      what: 'Still required to take many group Learn to Swim classes, even if you can see the listing',
    },
    {
      when: 'Through Oct 10',
      what: 'Leftover spots on current listings; classes start mid-September',
    },
    { when: 'Kids 9 and under', what: 'An adult 16+ on deck' },
  ],
  dateNote:
    'Date verified Aug 26, 2026 from YMCA Greater Toronto activity listings (registration starts 2026/08/27 09:00 for members and non-residents; registration ends 2026/10/10). Confirm the timestamp on My Y for the exact class. After Oct 10 this heading will stale — that is expected.',
  officialUrls: [
    { href: YMCA_HOME, label: 'YMCA of Greater Toronto' },
    { href: YMCA_PORTAL, label: 'My Y — MyY.YMCAGTA.ORG' },
  ],
  unofficialNote: UNOFFICIAL,
  rulesEyebrow: 'The miss',
  rulesHeading: [{ text: 'This is not' }, { text: 'Toronto swim registration', accent: true }],
  ruleCards: [
    {
      tag: '9 a.m.',
      title: 'Same clock for members and non-residents',
      line: 'City of Toronto rec is 7 a.m. by district. YMCA Greater Toronto is 9 a.m. on Aug 27 for both columns. Showing up at 7 thinking this is Toronto rec is the wrong portal.',
      checks: [
        'Portal: MyY.YMCAGTA.ORG',
        'Not eFun, not PerfectMind, not Active Mississauga',
        'Levels are Otter / Seal / Dolphin / Star — not Toronto Ultra',
      ],
    },
    {
      tag: 'Membership',
      title: 'Seeing the class is not the same as taking it',
      line: 'Listings we checked on Aug 26 still say participants must have an active membership with the YMCA of Greater Toronto. Registering at 9 a.m. without the membership is how the cart fails.',
      checks: [
        'Sort membership before the morning, not during it',
        'Confirm the prerequisite on the exact activity in My Y',
        'Leftover spots can run through Oct 10 on current listings',
      ],
    },
    {
      tag: 'Backup',
      title: 'City clocks if My Y is not your tank',
      line: 'Toronto city swim is Sept 15/16 at 7 a.m. Brampton city swim is Sept 9 at 7 a.m. Mississauga fall already opened (waitlist). Vaughan non-residents are Aug 27 at 7 a.m. on a different portal, one hour earlier — not My Y.',
      checks: [
        'Toronto: district morning, Ultra/Guardian, 36-hour waitlist',
        'Brampton: Sept 9 residents, in-person verification, 24-hour waitlist',
        'Do not invent a York Region rec system — there isn’t one',
      ],
    },
  ],
  sections: [
    {
      id: 'branches',
      headline: [{ text: 'Branches with tanks' }, { text: 'this cycle', accent: true }],
      lede: 'Not a complete directory. Confirm the branch on My Y.',
      paragraphs: [
        'Parents are looking at Cooper Koo, North York, Mississauga, Brampton, Markham, and the Y at the Braley Centre in Vaughan this cycle. That is a working list, not every tank the YMCA of Greater Toronto has ever run.',
      ],
    },
    {
      id: 'confirm-my-y',
      headline: [{ text: 'Confirm the timestamp' }, { text: 'on My Y', accent: true }],
      paragraphs: [
        'If an activity page has moved its clock, My Y wins. Hale is unofficial. Aug 27 at 9 a.m., membership first. Hale will run that morning with you. Founding families free — villagehale.com.',
      ],
      links: [
        { href: YMCA_PORTAL, label: 'Open My Y' },
        { href: '/toronto-swim-registration', label: 'City of Toronto swim — Sept 15/16' },
        { href: '/brampton-swim-registration', label: 'City of Brampton swim — Sept 9' },
      ],
    },
  ],
  faqs: [
    {
      question: 'When is YMCA Greater Toronto swim registration?',
      answer:
        'Thursday, August 27, 2026 at 9:00 a.m. Members and non-residents open at the same time. Confirm the exact class on MyY.YMCAGTA.ORG.',
    },
    {
      question: 'Is YMCA GTA swim the same as Toronto swim registration?',
      answer:
        'No. City of Toronto swim is a 7 a.m. district morning in September on toronto.ca/OnlineReg, using Ultra and Guardian. YMCA Greater Toronto is Aug 27 at 9 a.m. on My Y, using Otter / Seal / Dolphin / Star, and membership is required for many group classes.',
    },
    {
      question: 'Do I need a YMCA membership to register for swim lessons?',
      answer:
        'You can see the 9 a.m. open without living in a YMCA catchment — members and non-residents share the clock — but listings we checked still require an active YMCA of Greater Toronto membership to take many group Learn to Swim classes. Confirm on the activity page.',
    },
    {
      question: 'What are YMCA swim levels called?',
      answer:
        'Otter, Seal, Dolphin, Star, and the rest of the YMCA progression — not Toronto Ultra, not Red Cross. Check the child’s current YMCA report before you join the 9 a.m. cart.',
    },
    {
      question: 'Does a 9-year-old need an adult on deck?',
      answer:
        'YMCA Greater Toronto listings we checked say children 9 and under must be accompanied by an adult over the age of 16. Confirm on the activity page for that branch.',
    },
  ],
  ctaHeading: 'Aug 27 at 9 a.m., membership first.',
  ctaSub: 'Hale will run that morning with you. Founding families free — villagehale.com.',
  footerNote: FOOTER,
};

export const REGISTRATION_GUIDES: readonly RegistrationGuide[] = [
  TORONTO_FALL,
  TORONTO_SWIM,
  BRAMPTON_SWIM,
  YMCA_GTA,
];

export function getGuide(slug: string): RegistrationGuide | undefined {
  return REGISTRATION_GUIDES.find((guide) => guide.slug === slug);
}
