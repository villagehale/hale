import type { RegistrationGuide } from './types';
import { INTAKE_PREFILL } from '../text-entry';

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
    'Toronto’s fall 2026 resident mornings have gone — Sept 9 early local, Sept 15 Etobicoke and Toronto East York, Sept 16 North York and Scarborough. Non-residents register ten days after their district’s own morning, so Sept 25 or Sept 26 at 7 a.m. Winter is not posted yet. Hale is unofficial — confirm on toronto.ca.',
  eyebrow: 'Toronto · fall 2026',
  h1: [
    { text: 'Toronto fall recreation registration 2026:' },
    { text: 'which 7 a.m. is yours', accent: true },
  ],
  lede: 'The morning that mattered was the district of the centre you were booking, not the street you live on — and those mornings have gone: Sept 9, Sept 15, Sept 16. If you live outside Toronto, yours is still ahead — ten days after your activity’s own morning, so Friday, Sept 25 at 7 a.m. for the districts that opened Sept 15 and Sept 26 for the ones that opened Sept 16. I’m Barton, Sebastian’s dad. Hale is a texted GTA family assistant — no app — and founding families are free at villagehale.com.',
  updated: '2026-09-18',
  placement: 'toronto_fall_rec',
  datesEyebrow: 'Fall 2026',
  datesHeading: [{ text: 'What is left of' }, { text: 'the fall calendar', accent: true }],
  dateRows: [
    {
      when: 'Sept 25, 7 a.m.',
      what: 'Non-residents — ten days after the centre’s own morning, so Sept 26 where the district opened Sept 16',
    },
    {
      when: 'Week of Sept 26',
      what: 'Most fall programming begins (see the activity for the real dates)',
    },
    { when: '36 hours', what: 'Waitlist invitations expire, then the spot is offered onward' },
    {
      when: 'Passed — Aug 24',
      what: 'Listings went browsable and the wish list opened in the Registration & Booking System',
    },
    {
      when: 'Passed — Sept 9, 7 a.m.',
      what: 'Early Local Registration — all Free Centres, catchment only',
    },
    { when: 'Passed — Sept 15, 7 a.m.', what: 'Etobicoke, Toronto, and East York centres' },
    { when: 'Passed — Sept 16, 7 a.m.', what: 'North York and Scarborough centres' },
    {
      when: 'Winter 2027',
      what: 'Not posted yet. The city’s look-ahead says browse around Nov 17 and register around Dec 1–9, starting the week of Jan 4 — a look-ahead, not a clock',
    },
  ],
  dateNote:
    'Dates as the City published them in its release of August 24, 2026, re-verified against Hale’s registration dataset on Sept 17, 2026. Written Sept 18: the mornings in this table have gone, and the non-resident date is the city-wide ten-day rule applied to them rather than a date Toronto prints. Confirm on the official link — if Toronto has changed a morning, use Toronto.',
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
      line: 'A Leslieville parent booking a North York pool went Sept 16, not Sept 15 — and a non-resident booking that same pool goes Sept 26, not Sept 25. Home address never picked the morning.',
      checks: [
        'Look up the centre on the city’s community recreation centre list',
        'Etobicoke York includes York, Weston, and Mount Dennis — they went Sept 15',
        'Swimming opened on these same mornings',
      ],
      linkHref: '/toronto-swim-registration',
      linkLabel: 'Toronto swim uses this same calendar',
    },
    {
      tag: 'Sept 25',
      title: 'The non-resident clock is a rule, not a printed date',
      line: 'Toronto prints only the resident morning. Non-residents may register ten days after registration starts for that activity, with a $54.90 per-activity surcharge — so a centre that opened Sept 15 takes them Sept 25, and one that opened Sept 16 takes them Sept 26.',
      checks: [
        'Count ten days from the centre’s own morning, not from the earliest one in the city',
        'The surcharge is per activity, not per family',
        'Early Local Registration was proximity, not residency — it closed with its own morning',
      ],
    },
    {
      tag: '36 hours',
      title: 'The waitlist will not show your queue number',
      line: 'If a spot opens you get an email invitation. It expires in 36 hours, then it is dropped. You never see “you are #12”. Now that the mornings have gone, this is the live path.',
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
      headline: [
        { text: 'Registration is open —' },
        { text: 'and eFun is still gone', accent: true },
      ],
      paragraphs: [
        'The district mornings decided the popular barcodes; what is open now is what did not fill, plus the waitlist. Fall activities live in the Registration & Booking System, and you register from your wish list rather than searching live. That is what separated the families who got a Saturday 9 a.m. from the ones who did not, and it is what will separate them again in the winter cycle.',
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
        'If your morning is still ahead — non-residents, then the winter cycle — do this on paper the evening before, not in your head.',
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
      headline: [{ text: 'Which district' }, { text: 'is your centre?', accent: true }],
      paragraphs: [
        'The city staffed these desks for the opening mornings. The list is now the fastest district lookup there is, and the district is what sets a non-resident’s Sept 25 or Sept 26. This is the city’s list, not Hale’s — confirm it on the official page before you travel.',
      ],
      groups: [
        {
          title: 'Opened Sept 15 — Toronto, East York, and Etobicoke (non-residents Sept 25)',
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
          title: 'Opened Sept 16 — North York and Scarborough (non-residents Sept 26)',
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
      headline: [{ text: 'Winter is not posted —' }, { text: 'Hale will text you', accent: true }],
      paragraphs: [
        'Winter 2027 is not posted yet. The city’s look-ahead says winter activities should be available to browse around Nov 17, with registration anticipated between Dec 1 and 9 and programs starting the week of Jan 4, 2027. Those are look-ahead dates, not a printed clock. Do not set an alarm on them until the city page is specific.',
        'Hale knows which morning each centre keeps and watches for the winter clock to be printed. Text Hale — founding families free. Start at villagehale.com.',
      ],
    },
  ],
  faqs: [
    {
      question: 'When does Toronto fall recreation registration open?',
      answer:
        'Fall 2026 is already open — the mornings have gone. Early Local Registration was Sept 9 at 7 a.m. for Free Centres in catchment; Etobicoke and Toronto East York opened Sept 15 at 7 a.m.; North York and Scarborough opened Sept 16. Non-residents register ten days after their activity’s own morning, so Sept 25 or Sept 26 at 7 a.m. Confirm on toronto.ca — Hale is unofficial.',
    },
    {
      question: 'Which day is North York fall recreation registration?',
      answer:
        'North York and Scarborough centres opened Wednesday, Sept 16 at 7 a.m. The day follows the centre you are booking, not your home address — a Leslieville parent booking North York went Sept 16, and a non-resident booking it goes Sept 26.',
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
        'No. Swim opened on the same district mornings as the rest of rec — Sept 15 and Sept 16 at 7 a.m. — and Early Local Registration on Sept 9 applied only where that pool was a Free Centre in catchment.',
    },
  ],
  ctaHeading: 'Non-residents register Sept 25. Winter is not posted yet.',
  ctaSub:
    'Text Hale — founding families free. Start at villagehale.com. I’m Barton, Sebastian’s dad; Hale is a number you text, not an app.',
  footerNote: FOOTER,
};

export const TORONTO_SWIM: RegistrationGuide = {
  slug: 'toronto-swim-registration',
  path: '/toronto-swim-registration',
  title: 'Toronto swim registration 2026: same mornings as rec, not a separate day · Hale',
  description:
    'Toronto swim registration 2026 was never a separate day. Lessons opened on the centre’s rec morning — Sept 15 and Sept 16 at 7 a.m. Non-residents follow ten days later, Sept 25 or Sept 26, and the city lets you register up to the start of the third class, space permitting. Hale is unofficial; confirm on toronto.ca.',
  eyebrow: 'Toronto · swim 2026',
  h1: [
    { text: 'Toronto swim registration 2026:' },
    { text: 'it is not a separate day', accent: true },
  ],
  lede: 'There was never a swim-only date, and the district mornings have gone. What is left: non-residents open Friday, Sept 25 at 7 a.m. (Sept 26 where the district opened Sept 16), and the city lets you register up to the start of the third class, space permitting. Tell Hale the pool and the Ultra level. Founding families free — villagehale.com.',
  updated: '2026-09-18',
  placement: 'toronto_swim',
  datesEyebrow: 'What is left',
  datesHeading: [{ text: 'Swim shares the' }, { text: 'district’s rec calendar', accent: true }],
  dateRows: [
    {
      when: 'Sept 25, 7 a.m.',
      what: 'Non-residents — ten days after the pool’s own morning, so Sept 26 where the district opened Sept 16',
    },
    {
      when: 'Until class 3',
      what: 'You can still register up to the start of the third class, space permitting',
    },
    {
      when: 'Week of Sept 26',
      what: 'Most fall programming begins, so that third-class window runs into October',
    },
    { when: '36 hours', what: 'Swim waitlist invitations expire, then the lane is offered onward' },
    {
      when: 'Passed — Sept 9, 7 a.m.',
      what: 'Early Local Registration — only where that pool was a Free Centre in catchment',
    },
    { when: 'Passed — Sept 15, 7 a.m.', what: 'Etobicoke, Toronto, and East York pools' },
    { when: 'Passed — Sept 16, 7 a.m.', what: 'North York and Scarborough pools' },
  ],
  dateNote:
    'Same calendar as fall rec — one cycle, no swim-only date. Dates as the City published them for fall 2026, re-verified against Hale’s registration dataset on Sept 17, 2026 and read alongside the swim lessons page. Written Sept 18: the September mornings have gone, the non-resident date has not. Confirm on the official links.',
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
      line: 'If the centre is East York, lessons went in the Sept 15 7 a.m. wave with every other program at that centre. Ultra was never a different clock, and a non-resident booking that pool waits for Sept 25 — still not a swim-only date.',
      checks: [
        'Early Local Registration applied on Sept 9 only where the pool itself was a Free Centre in catchment',
        'ActiveTO is not this portal',
        'Fall rec uses this same district calendar',
      ],
      linkHref: '/toronto-fall-recreation-registration',
      linkLabel: 'Toronto fall rec dates by district',
    },
    {
      tag: 'Wishlist',
      title: 'Wishlist the barcode. Don’t search live.',
      line: 'At 7:00 a.m. on the district morning, the people who got in already had the activity on a wish list. Searching “swim” while the queue builds is how a Saturday 9 a.m. Ultra 3 disappears — and it is how Sept 25 will go for non-residents.',
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
        'What filled in four minutes was Saturday morning Ultra and Guardian at the popular tanks',
        'What is left at 10 a.m. is often the awkward time, not “swim is still open”',
      ],
    },
  ],
  sections: [
    {
      id: 'which-morning',
      headline: [{ text: 'Which district' }, { text: 'is this pool?', accent: true }],
      lede: 'Examples only — confirm the centre on the city’s list. This is not every indoor pool.',
      paragraphs: [
        'These names are the city’s own opening-morning desks, used here as a sketch of which wave a tank sat in. The district still decides things after the morning: it sets the non-resident date, and it is how you read what is left. If your pool is not on this list, look up its district rather than guessing from your neighbourhood.',
      ],
      groups: [
        {
          title: 'Opened Sept 15 — Etobicoke, Toronto, East York (non-residents Sept 25)',
          items: [
            'Etobicoke Olympium',
            'York Recreation Centre',
            'Wellesley Community Centre',
            'Regent Park Community Centre',
            'Mary McCormick Community Centre',
          ],
        },
        {
          title: 'Opened Sept 16 — North York, Scarborough (non-residents Sept 26)',
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
        'The city lets you register for Learn to Swim up to the start of the third class, space permitting. Fall programming begins the week of Sept 26, so on most tanks that window runs into October — it is the realistic path now, not a waitlist miracle. Leisure swim and family swim are not a lesson. If the city lane is gone, the backups are a different portal: YMCA Greater Toronto, whose Aug 27 open has passed but whose listings still take registrations through Oct 10, and then private.',
      ],
      links: [
        {
          href: '/ymca-gta-swim-registration',
          label: 'YMCA Greater Toronto swim — leftovers through Oct 10',
        },
        { href: TORONTO_SWIM_LESSONS, label: 'Official swim lessons page' },
      ],
    },
  ],
  faqs: [
    {
      question: 'Is Toronto swim registration a different day from rec?',
      answer:
        'No. Swim opened on the centre’s rec morning — Sept 15 or Sept 16 at 7 a.m. There is no swim-only date, and non-residents follow the same ten-day rule: Sept 25, or Sept 26 where the district opened Sept 16.',
    },
    {
      question: 'Was my pool Sept 15 or Sept 16?',
      answer:
        'It followed the district of the centre, not your home address. Etobicoke, Toronto, and East York centres (including York Recreation Centre) went Sept 15; North York and Scarborough went Sept 16. That district still sets your non-resident date. Confirm the centre on toronto.ca.',
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
  title: 'Brampton swim registration 2026: non-residents Monday, Sept 21 at 7 a.m. · Hale',
  description:
    'Brampton Learn to Swim and Learn to Skate opened Wednesday, September 9 at 7 a.m. for residents; non-residents open Monday, September 21 at 7 a.m., and that morning is still ahead. Resident verification is in person, and an unverified account is a non-resident account. Waitlist pending-confirmation is 24 hours. Hale is unofficial; confirm on brampton.ca.',
  eyebrow: 'Brampton · swim 2026',
  h1: [
    { text: 'Brampton swim registration:' },
    { text: 'non-residents open Monday, Sept 21', accent: true },
  ],
  lede: "Residents’ morning has gone — Learn to Swim and Learn to Skate opened Wednesday, Sept 9 at 7 a.m. Non-residents open Monday, Sept 21 at 7 a.m., and that is the morning still ahead. Hale watches kids' swim for parents. Adult lessons stay on the city page. Text your kids' names, ages, and postal and I'll watch Sept 21. Founding families free.",
  updated: '2026-09-18',
  placement: 'brampton_swim',
  datesEyebrow: 'Split calendar',
  datesHeading: [
    { text: 'Swim keeps its own morning.' },
    { text: 'The calendar is split.', accent: true },
  ],
  dateRows: [
    {
      when: 'Sept 21, 7 a.m.',
      what: 'Learn to Swim and Learn to Skate — non-residents. The morning still ahead',
    },
    {
      when: 'Sept 21 – Dec 13',
      what: 'Fall session run (Guardian and the rest of the listed season)',
    },
    { when: '24 hours', what: 'Waitlist pending-confirmation window (not Toronto’s 36)' },
    {
      when: 'Passed — Aug 24, 7 a.m.',
      what: 'General rec, sports, STEAM, and winter-break camps — never swim',
    },
    {
      when: 'Passed — Sept 9, 7 a.m.',
      what: 'Learn to Swim and Learn to Skate — residents',
    },
    {
      when: 'Winter 2027',
      what: 'Not posted yet. Brampton prints one cycle at a time, and December’s winter-break camps registered inside this fall window',
    },
  ],
  dateNote:
    'As Brampton’s registered-programs page had it when it was reconfirmed on Aug 26, 2026: residents Wednesday, September 9 at 7 a.m., non-residents Monday, September 21 at 7 a.m. Written Sept 18 — the residents’ morning has gone, Monday’s has not. Confirm there before you set an alarm.',
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
      title: 'Swim keeps its own morning, 16 days after general rec',
      line: 'General rec opened Aug 24 and swim did not. Aquatics and skating moved 16 days later — residents Sept 9, non-residents Sept 21 — so registering in the rec cycle never got you a swim lane.',
      checks: [
        'Learn to Swim and Learn to Skate never split: residents went Sept 9, non-residents go Sept 21',
        'Brampton Lifesaving Club is not Learn to Swim — stay off that product if you wanted lessons',
        'The fall session still runs ~Sept 21 to Dec 13',
      ],
    },
    {
      tag: 'In person',
      title: 'Resident verification is in person — unverified means Monday’s clock',
      line: 'Photo ID plus a Brampton address, at a rec-centre desk. You cannot email a licence. New accounts default to non-resident, which is why some Brampton families are on the Sept 21 morning and the non-resident rate.',
      checks: [
        'A driver’s licence usually covers photo and address in one card',
        'Children under 18 need a verified adult on the account',
        'Get validated on a weekday, not at 6:50 a.m. on the morning itself',
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
        'On desktop, sign in to the Brampton recreation account, open the family member, and use the Account Validation (or Account Verification) tab. You want “Account & Residency Validated” with a checkmark and a date. If that line is missing, the city treats you as a non-resident: Monday at 7 a.m., and the non-resident rate.',
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
        'YMCA Greater Toronto opened Aug 27 at 9 a.m. — members and non-residents on the same clock. That morning has gone, but the listings Hale read still take registrations through Oct 10, on My Y, not Brampton’s portal, with membership still required to take many group classes. If the city lane is the one you want, Monday, Sept 21 is the Brampton morning; the Y is a different portal and a different membership gate.',
      ],
      links: [
        {
          href: '/ymca-gta-swim-registration',
          label: 'YMCA Greater Toronto swim — leftovers through Oct 10',
        },
      ],
    },
  ],
  faqs: [
    {
      question: 'When is Brampton swim registration 2026?',
      answer:
        'Learn to Swim and Learn to Skate opened Wednesday, September 9 at 7 a.m. for residents. Non-residents open Monday, September 21 at 7 a.m., which is the morning still ahead. August 24 was general rec and winter-break camps, not swim.',
    },
    {
      question: 'Why was Brampton swim later than the August 24 rec open?',
      answer:
        'Brampton splits the calendar. Most registered programs opened Aug 24; aquatics and skating keep their own morning so the city can run those activities on a later clock. Showing up on Aug 24 never got you a swim lane.',
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
        'No. Lifesaving Club is a different product. If you wanted lessons, stay on Learn to Swim for the Sept 21 open.',
    },
  ],
  ctaHeading: 'Monday, Sept 21 at 7 a.m. is the morning still ahead.',
  ctaSub:
    "Hale watches kids' swim for parents. Adult lessons stay on the city page. Text your kids' names, ages, and postal and I'll watch Sept 21. Founding families free.",
  footerNote: FOOTER,
  smsPrefill: INTAKE_PREFILL,
};

export const YMCA_GTA: RegistrationGuide = {
  slug: 'ymca-gta-swim-registration',
  path: '/ymca-gta-swim-registration',
  title: 'YMCA Greater Toronto swim registration 2026: Aug 27 has gone, spots to Oct 10 · Hale',
  description:
    'YMCA Greater Toronto swim registration opened Thursday, August 27, 2026 at 9:00 a.m. for members and non-residents on the same clock. That morning has gone; the listings Hale read still take registrations through October 10. Portal is MyY.YMCAGTA.ORG, and membership is still required to take many group Learn to Swim classes. Confirm on My Y.',
  eyebrow: 'YMCA Greater Toronto · swim',
  h1: [
    { text: 'YMCA Greater Toronto swim:' },
    { text: 'listings still take spots to Oct 10', accent: true },
  ],
  lede: 'The 9:00 a.m. open on Thursday, Aug 27 has gone. What is left is leftovers: the listings Hale read run registration to Oct 10, classes started mid-September, and membership is still required to take many group Learn to Swim classes. The portal is My Y — not eFun, not PerfectMind, not Active Mississauga. Founding families free — villagehale.com.',
  updated: '2026-09-18',
  placement: 'ymca_gta_swim',
  datesEyebrow: 'After the open',
  datesHeading: [{ text: 'What is left on My Y,' }, { text: 'membership first', accent: true }],
  dateRows: [
    {
      when: 'Through Oct 10',
      what: 'Current listings still accept registration — leftover spots, not the opening morning',
    },
    {
      when: 'Membership',
      what: 'Still required to take many group Learn to Swim classes, even if you can see the listing',
    },
    { when: 'Kids 9 and under', what: 'An adult 16+ on deck' },
    {
      when: 'Passed — Aug 27, 9:00 a.m.',
      what: 'Members and non-residents opened together on My Y',
    },
    {
      when: 'Passed — mid-September',
      what: 'Classes started, so a late spot joins a session already running',
    },
  ],
  dateNote:
    'Date verified Aug 26, 2026 from YMCA Greater Toronto activity listings (registration starts 2026/08/27 09:00 for members and non-residents; registration ends 2026/10/10). Written Sept 18: the open has gone and the Oct 10 end has not. Confirm the timestamp on My Y for the exact class — after Oct 10 this page is the record of a cycle, not a clock.',
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
      title: 'One clock for members and non-residents',
      line: 'City of Toronto rec ran at 7 a.m. by district in September. YMCA Greater Toronto opened Aug 27 at 9 a.m. for both columns, and anyone who showed up at 7 thinking it was Toronto rec was in the wrong portal.',
      checks: [
        'Portal: MyY.YMCAGTA.ORG',
        'Not eFun, not PerfectMind, not Active Mississauga',
        'Levels are Otter / Seal / Dolphin / Star — not Toronto Ultra',
      ],
    },
    {
      tag: 'Membership',
      title: 'Seeing the class is not the same as taking it',
      line: 'Listings we checked still say participants must have an active membership with the YMCA of Greater Toronto. Claiming a leftover spot without the membership is how the cart fails.',
      checks: [
        'Sort membership before you claim a spot, not during checkout',
        'Confirm the prerequisite on the exact activity in My Y',
        'Leftover spots can run through Oct 10 on current listings',
      ],
    },
    {
      tag: 'Backup',
      title: 'City clocks if My Y is not your tank',
      line: 'Toronto city swim went Sept 15 and Sept 16 at 7 a.m., and its non-residents open Sept 25. Brampton residents went Sept 9; non-residents open Monday, Sept 21 at 7 a.m. Mississauga’s fall opened in August and is on waitlist. Vaughan’s non-resident morning was Aug 27 at 7 a.m. too, one hour earlier and on a different portal — not My Y.',
      checks: [
        'Toronto: district morning, Ultra/Guardian, 36-hour waitlist',
        'Brampton: Sept 21 non-residents, in-person verification, 24-hour waitlist',
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
        'If an activity page has moved its clock, My Y wins. Hale is unofficial. The opening morning has gone; what is left sits on the listing until Oct 10, membership first. Tell Hale the branch and the level and Hale watches for the next open. Founding families free — villagehale.com.',
      ],
      links: [
        { href: YMCA_PORTAL, label: 'Open My Y' },
        {
          href: '/toronto-swim-registration',
          label: 'City of Toronto swim — non-residents Sept 25',
        },
        {
          href: '/brampton-swim-registration',
          label: 'City of Brampton swim — non-residents Sept 21',
        },
      ],
    },
  ],
  faqs: [
    {
      question: 'When is YMCA Greater Toronto swim registration?',
      answer:
        'It opened Thursday, August 27, 2026 at 9:00 a.m., members and non-residents together, and that morning has gone. The listings Hale read run registration to October 10, so what is left is leftover spots. Confirm the exact class on MyY.YMCAGTA.ORG.',
    },
    {
      question: 'Is YMCA GTA swim the same as Toronto swim registration?',
      answer:
        'No. City of Toronto swim ran on 7 a.m. district mornings in September on toronto.ca/OnlineReg, using Ultra and Guardian, with non-residents ten days behind. YMCA Greater Toronto opened Aug 27 at 9 a.m. on My Y, using Otter / Seal / Dolphin / Star, and membership is required for many group classes.',
    },
    {
      question: 'Do I need a YMCA membership to register for swim lessons?',
      answer:
        'Members and non-residents shared one clock, so catchment was never the gate — but listings we checked still require an active YMCA of Greater Toronto membership to take many group Learn to Swim classes. Confirm on the activity page.',
    },
    {
      question: 'What are YMCA swim levels called?',
      answer:
        'Otter, Seal, Dolphin, Star, and the rest of the YMCA progression — not Toronto Ultra, not Red Cross. Check the child’s current YMCA report before you claim a leftover spot.',
    },
    {
      question: 'Does a 9-year-old need an adult on deck?',
      answer:
        'YMCA Greater Toronto listings we checked say children 9 and under must be accompanied by an adult over the age of 16. Confirm on the activity page for that branch.',
    },
  ],
  ctaHeading: 'Membership first, then what is left on My Y.',
  ctaSub:
    'Tell Hale the branch and the level — Hale watches for the next open. Founding families free — villagehale.com.',
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
