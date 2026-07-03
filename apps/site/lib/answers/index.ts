import type { AnswerPage } from './types';

export type { AnswerPage } from './types';

/**
 * The cornerstone answer corpus. Each page targets one high-intent parent query
 * and grounds every substantive claim in the permitted frameworks (see
 * ./frameworks.ts). This is YMYL content: pages ship as review-ready drafts with
 * `published: false`, so they render noindex and stay out of the sitemap until a
 * human reviews the copy and citations. To take a page live: set `published: true`.
 *
 * Copy rule (mirrors apps/worker/prompts/coach.md): describe what is typical or
 * common practice; never diagnose, dose, or interpret symptoms. Anything in that
 * territory defers to the family's provider — every page carries that framing.
 */
const ANSWERS: AnswerPage[] = [
  {
    slug: 'newborn-cluster-feeding',
    question: 'Why does my newborn want to feed constantly in the evening?',
    title: 'Newborn cluster feeding in the evening: is it normal?',
    description:
      'Bunched evening feeds — cluster feeding — are a normal newborn pattern, not a sign of low supply. What it is, why it happens, and when to check with your provider.',
    stage: 'newborn',
    answer:
      'Frequent, back-to-back feeds bunched into the evening — cluster feeding — are a normal newborn pattern in the early weeks, and on their own they are not a sign that a baby is underfed or that supply is low. It tends to ease as feeding rhythms settle over the first couple of months.',
    sections: [
      {
        heading: 'What cluster feeding is',
        body: [
          'Cluster feeding is when a baby feeds several times in close succession over a few hours, most often in the evening, instead of spacing feeds evenly through the day. It is common in the newborn weeks and usually comes and goes.',
          'The Canadian Paediatric Society notes that in the first few weeks babies breastfeed 8 to 12 times a day, on demand rather than on a fixed schedule, so frequent feeding in the early weeks is expected rather than a warning sign. Counting wet and dirty diapers and steady weight gain — tracked with your provider — are the signals of adequate intake, not the spacing of feeds.',
        ],
      },
      {
        heading: 'Why evenings',
        body: [
          'Karp frames the newborn period as a "fourth trimester" in which a baby is adjusting to life outside the womb and is soothed by conditions that mimic it — closeness, motion, and frequent feeding. Bunched evening feeds fit that picture of a baby seeking contact and regulation at the end of the day.',
          'This is also a common window for evening fussiness. Feeding often settles the baby; it does not mean something is wrong.',
        ],
      },
      {
        heading: 'When to check with your provider',
        body: [
          'Talk to your provider if the baby is not making enough wet or dirty diapers, is not gaining weight as expected, seems difficult to wake for feeds or is very lethargic, or if feeding is consistently painful for you. Those are questions for a clinician — a page like this cannot assess an individual baby.',
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — "Breastfeeding" (caringforkids.cps.ca/handouts/pregnancy-and-babies/breastfeeding)',
        excerpt:
          'In the first few weeks babies breastfeed 8 to 12 times a day and are fed on demand, not on a fixed schedule; six or more wet diapers a day and steady weight gain are signs a baby is feeding well.',
      },
      {
        framework: 'karp',
        reference: 'Harvey Karp, The Happiest Baby on the Block — the "fourth trimester"',
        excerpt:
          'Newborns are soothed by conditions that recall the womb, including closeness and frequent feeding.',
      },
    ],
    faqs: [
      {
        question: 'Does cluster feeding mean I have low milk supply?',
        answer:
          'Not on its own. Cluster feeding is a normal newborn pattern. Supply is judged by diaper output and weight gain with your provider, not by how close together feeds are.',
      },
      {
        question: 'How long does cluster feeding last?',
        answer:
          'It typically eases as feeding rhythms settle over the first couple of months, though every baby is different. Your provider can reassure you about your baby specifically.',
      },
    ],
    related: ['newborn-sleep-fragmented', 'newborn-safe-sleep-basics'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'newborn-sleep-fragmented',
    question: 'Why does my newborn only sleep in short stretches?',
    title: 'Newborn sleep: why it comes in short, broken stretches',
    description:
      'Short, fragmented newborn sleep is developmentally normal, not a problem to fix. What to expect in the first months and what actually helps.',
    stage: 'newborn',
    answer:
      'Newborn sleep is naturally broken into short stretches spread across the day and night. That is how newborn sleep is built, not a sign anything is wrong, and it gradually consolidates over the first several months.',
    sections: [
      {
        heading: 'Short stretches are how newborn sleep works',
        body: [
          'In the early weeks, sleep comes in short bouts around the clock rather than one long night. The Canadian Paediatric Society describes newborn sleep as fragmented and without a fixed day–night pattern at first, with longer nighttime stretches developing gradually over the first months.',
          'Because a newborn stomach is small and feeds are frequent, waking often is part of the design of this stage.',
        ],
      },
      {
        heading: 'What helps',
        body: [
          'Karp describes soothing techniques — swaddling, side/stomach hold for calming (not for sleep), shushing, swinging motion, and sucking — as ways to settle a newborn who is having trouble winding down. These calm a baby; they do not force a newborn onto an adult sleep schedule, which is not developmentally realistic yet.',
          'A consistent, calm wind-down and letting daytime be bright and nighttime be dark and quiet can gently support the day–night pattern forming on its own.',
        ],
      },
      {
        heading: 'Sleep training and age',
        body: [
          "Ferber's graduated-check approach to helping a child fall asleep independently is aimed at older infants, not newborns — commonly discussed from around 4–6 months, and something to time with your provider. In the newborn stage the goal is soothing and safe sleep, not training.",
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — "Healthy sleep for your baby and child" (caringforkids.cps.ca)',
        excerpt:
          'Newborn sleep is fragmented with no fixed day–night pattern; longer stretches develop over the first months.',
      },
      {
        framework: 'karp',
        reference: 'Harvey Karp, The Happiest Baby on the Block — the "5 S\'s" soothing techniques',
        excerpt: 'Swaddle, side/stomach hold, shush, swing, and suck to calm a fussy newborn.',
      },
      {
        framework: 'ferber',
        reference: "Richard Ferber, Solve Your Child's Sleep Problems — graduated extinction",
        excerpt:
          'Graduated checks to build independent sleep are aimed at older infants, not newborns.',
      },
    ],
    faqs: [
      {
        question: 'When will my newborn sleep through the night?',
        answer:
          'Longer nighttime stretches develop gradually over the first several months, and the timing varies a lot between babies. Your provider can tell you what is reasonable to expect for your baby.',
      },
      {
        question: 'Can I sleep train a newborn?',
        answer:
          'Formal sleep training is generally discussed for older infants (often from around 4–6 months), not newborns. In the newborn stage the aim is soothing and safe sleep. Time any approach with your provider.',
      },
    ],
    related: ['newborn-cluster-feeding', 'newborn-safe-sleep-basics'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'newborn-safe-sleep-basics',
    question: 'What are the safe sleep basics for a newborn?',
    title: 'Safe sleep for newborns: the basics parents ask about',
    description:
      'The widely recommended safe-sleep basics for babies — back to sleep, a bare crib, and room-sharing — with the Canadian guidance behind them.',
    stage: 'newborn',
    answer:
      'The core safe-sleep guidance in Canada is to place a baby on their back, alone, on a firm flat surface in a crib, cradle or bassinet, with no soft bedding, and to share a room (not a bed) with the baby for the first months. Always confirm specifics with your provider.',
    sections: [
      {
        heading: 'The widely recommended basics',
        body: [
          'The Public Health Agency of Canada and the Canadian Paediatric Society describe the same core practices: put babies to sleep on their back for every sleep; use a firm, flat surface in a crib, cradle or bassinet that meets current Canadian safety regulations; keep the sleep space bare, with no pillows, bumper pads, loose blankets, or soft toys; and share a room with the baby, without sharing a bed, for at least the first six months.',
          'A smoke-free environment and, where it works for the family, breastfeeding are also part of the guidance associated with lower risk.',
        ],
      },
      {
        heading: 'Swaddling and safe sleep',
        body: [
          'Karp popularized swaddling as a soothing technique. If a family swaddles, safe-sleep guidance still applies: the baby is placed on their back, the swaddle is not too tight around the hips, and swaddling is stopped once a baby shows signs of rolling. Your provider can advise on your baby.',
        ],
      },
      {
        heading: 'This is a starting point, not medical advice',
        body: [
          'Safe-sleep recommendations are specific and occasionally updated. Treat this as an orientation and confirm the current guidance with your provider or a trusted Canadian source such as caringforkids.cps.ca.',
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — "Safe sleep for babies" (caringforkids.cps.ca)',
        excerpt:
          'Back to sleep, firm flat surface, bare crib, and room-sharing without bed-sharing for the first six months.',
      },
      {
        framework: 'health_canada',
        reference:
          'Public Health Agency of Canada / Health Canada — Safe Sleep for Your Baby (canada.ca)',
        excerpt:
          'The Canadian Joint Statement on safe sleep: back position, no soft bedding, room-sharing.',
      },
      {
        framework: 'karp',
        reference: 'Harvey Karp, The Happiest Baby on the Block — swaddling',
        excerpt: 'Swaddling as a soothing technique, discontinued once a baby begins to roll.',
      },
    ],
    faqs: [
      {
        question: 'Is bed-sharing safe?',
        answer:
          'Canadian guidance recommends room-sharing without bed-sharing for at least the first six months. Discuss your specific situation with your provider, who can weigh your circumstances.',
      },
      {
        question: 'When should I stop swaddling?',
        answer:
          'Common guidance is to stop swaddling once a baby shows signs of rolling, because a swaddled baby who rolls to their front is at higher risk. Confirm timing with your provider.',
      },
    ],
    related: ['newborn-sleep-fragmented', 'newborn-cluster-feeding'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'introducing-peanuts-to-baby',
    question: 'When and how do I introduce peanuts to my baby?',
    title: 'Introducing peanut to babies: when and how',
    description:
      'Current guidance encourages introducing common allergens like peanut early, around six months, once a baby is ready for solids. What that looks like and when to talk to your provider first.',
    stage: 'newborn',
    answer:
      'Current Canadian guidance is that there is no reason to delay introducing common food allergens, including peanut, and that offering them around six months — once a baby is developmentally ready for solids — may help reduce the risk of developing a food allergy. If your baby has severe eczema or a known food allergy, talk to your provider before introducing peanut.',
    sections: [
      {
        heading: 'The shift toward earlier introduction',
        body: [
          'Guidance moved away from delaying allergens years ago. The Canadian Paediatric Society advises that common allergenic foods can be introduced around six months (not before four months), alongside other first foods, and that delaying them does not prevent allergy — earlier introduction may in fact lower the risk.',
          'Once introduced and tolerated, keeping the food a regular part of the diet is part of the guidance.',
        ],
      },
      {
        heading: 'What "how" looks like',
        body: [
          'Whole peanuts and globs of peanut butter are choking hazards for babies, so smooth peanut butter is thinned with water or mixed into a food the baby already eats, or a peanut puff product is used. New allergens are commonly offered earlier in the day so any reaction can be watched, and one new allergen is introduced at a time.',
          'This page describes common practice. It cannot tell you whether it is safe for your baby.',
        ],
      },
      {
        heading: 'When to talk to your provider first',
        body: [
          'If your baby has severe eczema, an existing food allergy, or a strong family history that concerns you, discuss a plan with your provider before introducing peanut — some babies are assessed first. This is exactly the kind of decision to make with a clinician, not from a web page.',
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — "Food allergy vs. food intolerance: What is the difference and can I prevent them?" (caringforkids.cps.ca/handouts/healthy-living/food_allergies_and_intolerances)',
        excerpt:
          'There is no evidence that avoiding certain foods prevents allergy; common food allergens can be introduced around six months of age, but not before four months.',
      },
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — "Feeding your baby in the first year" (caringforkids.cps.ca/handouts/feeding_your_baby_in_the_first_year)',
        excerpt:
          'Mix a little smooth peanut butter with water, breast milk, or a purée the baby has had before, or offer a peanut puff product; whole peanuts and thick globs are choking hazards.',
      },
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, position statement — "Timing of introduction of allergenic solids for infants at high risk" (cps.ca/en/documents/position/allergenic-solids)',
        excerpt:
          'For infants at high risk of food allergy, consider introducing allergenic solids such as peanut around six months, and not before four months.',
      },
      {
        framework: 'aap',
        reference:
          'American Academy of Pediatrics, HealthyChildren.org — early introduction of allergenic foods',
        excerpt:
          'Introducing peanut-containing foods early, with clinician guidance for high-risk infants, can reduce allergy risk.',
      },
    ],
    faqs: [
      {
        question: 'Can I give my baby whole peanuts?',
        answer:
          'No. Whole peanuts and thick globs of peanut butter are choking hazards for babies. Use thinned smooth peanut butter or a peanut puff product instead.',
      },
      {
        question: 'What if my baby has severe eczema?',
        answer:
          'Babies with severe eczema or a known food allergy should be assessed by a provider before peanut is introduced. Talk to your clinician about a plan first.',
      },
    ],
    related: ['starting-solids-when-ready', 'newborn-cluster-feeding'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'starting-solids-when-ready',
    question: 'When is my baby ready to start solid foods?',
    title: 'Signs your baby is ready for solid foods',
    description:
      'Solids usually start around six months, once a baby can sit up without support, has good head and neck control, and shows interest in food. The readiness signs and Canadian guidance.',
    stage: 'newborn',
    answer:
      'Most babies are ready to start solid foods around six months of age, when they can sit up without support and have good control of their neck muscles, have lost the reflex that pushes food out of their mouth, and show interest in what others are eating. Breast milk or formula continues alongside solids.',
    sections: [
      {
        heading: 'The readiness signs',
        body: [
          'The Canadian Paediatric Society describes starting solids at around six months, and lists developmental readiness signs rather than a fixed date: being able to sit up without support, lean forward, and have good control of the neck muscles; showing interest in food; and holding food in the mouth without pushing it out with the tongue right away.',
          'Iron-rich first foods — such as iron-fortified infant cereal, well-cooked meats, or legumes — are emphasized because a baby\'s iron stores start to run low around this age.',
        ],
      },
      {
        heading: 'Solids add to milk, they do not replace it',
        body: [
          'In the first year, breast milk or formula remains the main source of nutrition, and solids are introduced alongside it. The point of early solids is learning to eat and adding iron, not weaning off milk.',
        ],
      },
      {
        heading: 'Talk to your provider',
        body: [
          'If your baby was born prematurely, has feeding difficulties, or you are unsure about readiness, your provider can advise on timing. Introducing common allergens around this time is also part of current guidance — see our page on introducing peanut.',
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — "Feeding your baby in the first year" (caringforkids.cps.ca/handouts/feeding_your_baby_in_the_first_year)',
        excerpt:
          'Around six months, look for readiness signs — can sit up without support, lean forward, and has good control of the neck muscles; begin with iron-rich foods.',
      },
      {
        framework: 'health_canada',
        reference:
          'Health Canada — Nutrition for Healthy Term Infants (canada.ca), joint statement with the CPS and Dietitians of Canada',
        excerpt: 'Introduce solids at six months with iron-rich foods, continuing breast milk or formula.',
      },
    ],
    faqs: [
      {
        question: 'Can I start solids before six months?',
        answer:
          'Guidance generally advises not before four months and around six months for most babies, based on readiness signs. If you are considering starting earlier, discuss it with your provider.',
      },
      {
        question: 'What foods should I start with?',
        answer:
          'Iron-rich foods are emphasized first — iron-fortified infant cereal, well-cooked meats, or legumes — because iron stores run low around six months.',
      },
    ],
    related: ['introducing-peanuts-to-baby', 'newborn-cluster-feeding'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'toddler-tantrums-how-to-handle',
    question: 'How do I handle my toddler’s tantrums?',
    title: 'Toddler tantrums: what helps (and what to skip)',
    description:
      'Tantrums are a normal part of toddler development, not misbehaviour to punish away. A calm, connection-first approach grounded in Markham, Lansbury, and Siegel.',
    stage: 'toddler',
    answer:
      'Tantrums are a normal, developmentally expected part of being a toddler — a young child overwhelmed by a big feeling they cannot yet manage or express. What helps most is staying calm, keeping your child safe, acknowledging the feeling, and reconnecting once the storm passes, rather than punishing or reasoning in the heat of it.',
    sections: [
      {
        heading: 'Why tantrums happen',
        body: [
          'Siegel explains that a young child\'s "upstairs brain" — the part that handles self-control and reasoning — is still under construction, so big emotions can flood the "downstairs brain" faster than a toddler can regulate them. A tantrum is that flood, not a manipulation.',
          'Markham frames the parent\'s calm as the child\'s anchor: a dysregulated child cannot be calmed by a dysregulated adult. Regulating yourself first is the first move.',
        ],
      },
      {
        heading: 'What helps in the moment',
        body: [
          'Keep the child safe and stay nearby. Name the feeling simply — "you really wanted that, and it\'s so hard to stop" — which Siegel describes as "connect and redirect": connect with the emotion before you address the behaviour.',
          'Lansbury\'s RIE approach adds that you can hold a limit calmly and confidently while still accepting the feeling: the limit ("we\'re not buying that today") and the empathy ("you\'re upset, and that\'s okay") coexist. You do not have to give in to be kind, and you do not have to be harsh to hold a boundary.',
        ],
      },
      {
        heading: 'After the storm',
        body: [
          'Once the child is calm, reconnect. Long lectures rarely land with a toddler; a brief, warm acknowledgement does more. Over time, naming feelings helps build the very regulation skills the child is missing.',
        ],
      },
    ],
    citations: [
      {
        framework: 'siegel',
        reference:
          'Daniel Siegel & Tina Payne Bryson, The Whole-Brain Child — "connect and redirect"; upstairs/downstairs brain',
        excerpt:
          'A young child\'s self-control centres are still developing; connect with the emotion before addressing behaviour.',
      },
      {
        framework: 'markham',
        reference: 'Laura Markham, Aha! Parenting — regulate yourself first (ahaparenting.com)',
        excerpt: 'A calm parent is the child\'s anchor; you cannot calm a child from a dysregulated state.',
      },
      {
        framework: 'lansbury',
        reference: 'Janet Lansbury, No Bad Kids / RIE — calm, confident limits with empathy (janetlansbury.com)',
        excerpt: 'Hold the limit and accept the feeling at the same time.',
      },
    ],
    faqs: [
      {
        question: 'Should I punish my toddler for a tantrum?',
        answer:
          'A tantrum is an emotional flood, not deliberate misbehaviour. The approaches here favour calm limits and reconnection over punishment, which tends to escalate a dysregulated child.',
      },
      {
        question: 'When are tantrums a concern?',
        answer:
          'Frequent tantrums are typical for toddlers. If tantrums are extremely intense, very long, involve self-harm, or you are worried about development, raise it with your provider.',
      },
    ],
    related: ['toddler-biting-what-to-do', 'toddler-separation-anxiety-daycare'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'toddler-biting-what-to-do',
    question: 'What should I do when my toddler bites?',
    title: 'Toddler biting: why it happens and how to respond',
    description:
      'Biting is common in toddlers and usually about frustration, teething, or limited language — not aggression. A calm, consistent response grounded in Lansbury and Markham.',
    stage: 'toddler',
    answer:
      'Biting is common in toddlers and usually comes from frustration, teething, over-excitement, or simply not yet having the words to express a need — not from meanness. The most effective response is calm, immediate, and consistent: stop the bite, tend to the child who was hurt, and calmly name the limit without shaming.',
    sections: [
      {
        heading: 'Why toddlers bite',
        body: [
          'Toddlers have big feelings and few words. The American Academy of Pediatrics notes that a young child often lacks the self-control to express anger peacefully and may lash out — hitting or biting in frustration — rather than intending to harm. Seeing it as communication, not cruelty, changes how you respond.',
        ],
      },
      {
        heading: 'How to respond',
        body: [
          'Respond calmly and right away. Lansbury\'s RIE approach suggests a confident, unshaming limit — "I won\'t let you bite" — while blocking the behaviour, then giving attention to the child who was hurt. Big dramatic reactions can accidentally reinforce biting by making it interesting.',
          'Markham emphasizes staying regulated and helping the child with the underlying feeling or need. Where you can, get ahead of it: watch for the frustration or over-tiredness that precedes a bite, and offer words or a break before it happens.',
        ],
      },
      {
        heading: 'When to seek advice',
        body: [
          'Biting usually fades as language grows. If it is frequent, intense, or persists well beyond the toddler years, or if you are concerned about your child\'s development or communication, talk to your provider or your daycare about a consistent plan.',
        ],
      },
    ],
    citations: [
      {
        framework: 'aap',
        reference:
          'American Academy of Pediatrics, HealthyChildren.org — "10 Tips to Prevent Aggressive Behavior in Young Children" (healthychildren.org/English/ages-stages/toddler/Pages/Aggressive-Behavior.aspx)',
        excerpt:
          'A young child often lacks the self-control to express anger peacefully and may lash out — hitting or biting in frustration — so teach words for feelings rather than punishing.',
      },
      {
        framework: 'lansbury',
        reference: 'Janet Lansbury, No Bad Kids / RIE — calm, unshaming limits (janetlansbury.com)',
        excerpt: '"I won\'t let you bite" — a confident limit, delivered without shame.',
      },
      {
        framework: 'markham',
        reference: 'Laura Markham, Aha! Parenting — addressing the underlying feeling (ahaparenting.com)',
        excerpt: 'Stay regulated and get ahead of the trigger; help with the need behind the bite.',
      },
    ],
    faqs: [
      {
        question: 'Should I bite my child back to show them how it feels?',
        answer:
          'No. Biting a child back models the behaviour you are trying to stop and can frighten them. A calm, consistent limit and attention to the hurt child is the approach these frameworks favour.',
      },
      {
        question: 'Is biting a sign of a behaviour problem?',
        answer:
          'Usually not — it is common at this age and typically fades as language develops. If it is frequent or persistent, or you are worried, discuss it with your provider.',
      },
    ],
    related: ['toddler-tantrums-how-to-handle', 'toddler-separation-anxiety-daycare'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'toddler-separation-anxiety-daycare',
    question: 'How do I ease my toddler’s separation anxiety at daycare drop-off?',
    title: 'Daycare drop-off: easing toddler separation anxiety',
    description:
      'Separation anxiety at drop-off is a normal sign of healthy attachment. A short, warm, consistent goodbye routine — and what the research-backed frameworks suggest.',
    stage: 'toddler',
    answer:
      'Tears at daycare drop-off are a normal sign of healthy attachment, not a sign you are doing something wrong. What helps most is a short, warm, predictable goodbye routine done with confidence: a consistent ritual, a genuine (not sneaked) goodbye, and trust that your child can be comforted by their caregiver.',
    sections: [
      {
        heading: 'Separation anxiety is normal and healthy',
        body: [
          'The Canadian Paediatric Society describes separation anxiety as a normal developmental phase for young children — a reflection of the attachment bond, which is still common in the toddler years and eases with time. Distress at goodbye is not evidence of a problem with the child or the daycare.',
        ],
      },
      {
        heading: 'What helps at drop-off',
        body: [
          'Markham suggests a warm, consistent goodbye ritual and staying calm and confident, because children read a parent\'s anxiety. A predictable sequence — a hug, a phrase you always say, and a clear goodbye — helps a child know what to expect.',
          'Lansbury\'s RIE approach adds honesty: say a real goodbye rather than slipping out, which can leave a child more anxious the next time. Trust the caregiver to comfort your child after you go; most settle within minutes.',
        ],
      },
      {
        heading: 'When to check in',
        body: [
          'If distress is severe, lasts for a long time after you leave, persists for many weeks without easing, or seems out of proportion, talk with the daycare and your provider. They can look at what your child specifically needs.',
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — "Helping children deal with their fears" (caringforkids.cps.ca/handouts/behavior-and-development/children_and_fears)',
        excerpt:
          'Fears and separation anxiety are a normal part of a young child\'s development and ease with time as a child is reassured and supported.',
      },
      {
        framework: 'markham',
        reference: 'Laura Markham, Aha! Parenting — goodbye rituals and staying calm (ahaparenting.com)',
        excerpt: 'A warm, consistent goodbye ritual, delivered with confidence, eases drop-off.',
      },
      {
        framework: 'lansbury',
        reference: 'Janet Lansbury, RIE — say a genuine goodbye, do not sneak out (janetlansbury.com)',
        excerpt: 'Honest goodbyes build trust; sneaking away tends to increase anxiety.',
      },
    ],
    faqs: [
      {
        question: 'Should I sneak out to avoid the tears?',
        answer:
          'The frameworks here advise against it. A genuine, brief goodbye builds trust; disappearing can make a child more anxious and clingy at the next drop-off.',
      },
      {
        question: 'How long until it gets easier?',
        answer:
          'Many children settle within minutes of a parent leaving and grow out of the sharpest separation anxiety over time. If it stays severe for weeks, check in with the daycare and your provider.',
      },
    ],
    related: ['toddler-tantrums-how-to-handle', 'toddler-biting-what-to-do'],
    updated: '2026-07-02',
    published: false,
  },
  {
    slug: 'potty-training-readiness-signs',
    question: 'How do I know my toddler is ready to potty train?',
    title: 'Potty training readiness: the signs to look for',
    description:
      'Potty training goes best when it follows a child’s readiness signs rather than a fixed age. The physical and behavioural cues, and a low-pressure approach.',
    stage: 'toddler',
    answer:
      'Potty training tends to go best when it follows a child\'s readiness rather than a set age — some children are ready as young as 18 months, but most start between 2 and 4 years. Readiness is a mix of physical signs (staying dry in their diaper for several hours in a row, predictable bowel movements) and behavioural ones (interest in the toilet, being able to follow simple instructions, and telling you they need to go).',
    sections: [
      {
        heading: 'The readiness signs',
        body: [
          'The Canadian Paediatric Society describes potty training as best started when a child shows readiness signs, not at a fixed birthday — some children are ready as young as 18 months, but most start between 2 and 4 years. Physical signs include being dry in their diaper for several hours in a row and having regular, predictable bowel movements. Developmental and behavioural signs include being able to walk to and sit on a potty, pull clothing up and down with help, follow simple directions, show interest in the toilet, and communicate the need to go.',
        ],
      },
      {
        heading: 'A low-pressure approach',
        body: [
          'The same guidance emphasizes a relaxed, encouraging tone. Pushing before a child is ready, or reacting strongly to accidents, tends to backfire and can create power struggles. Praise for trying, matter-of-fact handling of accidents, and letting the child set some of the pace all help.',
          'Markham\'s connection-first approach fits here: keeping it collaborative and pressure-free, rather than turning it into a battle, protects both the skill and the relationship.',
        ],
      },
      {
        heading: 'When to talk to your provider',
        body: [
          'If training stalls badly, if there is significant constipation or withholding, or if you are worried about your child\'s development, your provider can help. Regression around a big change (a new sibling, a move) is common and usually temporary.',
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — "Toilet learning" (caringforkids.cps.ca/handouts/behavior-and-development/toilet_learning)',
        excerpt:
          'Some children are ready as young as 18 months, but most start between 2 and 4 years; begin when the child shows readiness signs, such as being dry in their diaper for several hours in a row, and keep it low-pressure.',
      },
      {
        framework: 'markham',
        reference: 'Laura Markham, Aha! Parenting — pressure-free, collaborative toilet learning (ahaparenting.com)',
        excerpt: 'Keep toilet learning collaborative and calm; power struggles backfire.',
      },
    ],
    faqs: [
      {
        question: 'What age should my child be potty trained?',
        answer:
          'There is no single right age. Some children are ready as young as 18 months, but most start between 2 and 4 years, and following the child\'s cues works better than a deadline.',
      },
      {
        question: 'My child was trained and started having accidents again — why?',
        answer:
          'Regression is common, especially around big changes like a new sibling or a move, and is usually temporary. If it is persistent or there is constipation or pain, check with your provider.',
      },
    ],
    related: ['toddler-tantrums-how-to-handle', 'toddler-separation-anxiety-daycare'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'toddler-screen-time-guidelines',
    question: 'How much screen time is okay for a toddler?',
    title: 'Screen time for toddlers: what the guidelines say',
    description:
      'Canadian guidance recommends little to no screen time under two, and no more than an hour a day for ages two to five. The numbers and the reasoning.',
    stage: 'toddler',
    answer:
      'Canadian guidance recommends no screen time for children under two (other than video-chatting with family), and no more than one hour a day of good-quality screen time for children aged two to five — with less being better. Just as important as the amount is co-viewing, keeping screens out of the bedroom, and protecting time for sleep, play, and interaction.',
    sections: [
      {
        heading: 'The numbers',
        body: [
          'The Canadian Paediatric Society advises minimizing screen time for young children: for children under two, screen time is not recommended (video-chat with family is an exception); for ages two to five, limiting routine or regular screen time to less than one hour per day. The American Academy of Pediatrics gives closely aligned guidance for these ages.',
        ],
      },
      {
        heading: 'It is not just about minutes',
        body: [
          'Both bodies emphasize how screens are used: watch together and talk about what you see, choose high-quality content, keep screens away from meals and the hour before bed, and keep them out of the bedroom. The concern at this age is mainly what screens displace — sleep, active play, and back-and-forth interaction that drives early development.',
        ],
      },
      {
        heading: 'A realistic view',
        body: [
          'These are guidelines, not a verdict on any single day. The Canadian guidance itself frames the goal as building healthy habits over time, not eliminating every screen. If screen use is crowding out sleep or play, or you have concerns, your provider can help you find a balance that fits your family.',
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society — "Screen time and young children" / Digital Health Task Force (caringforkids.cps.ca)',
        excerpt:
          'No screen time under two; under one hour a day for ages two to five; co-view and keep screens out of bedrooms.',
      },
      {
        framework: 'aap',
        reference: 'American Academy of Pediatrics, HealthyChildren.org — media use for young children',
        excerpt: 'Avoid screens under 18–24 months apart from video chat; limit and co-view for ages two to five.',
      },
    ],
    faqs: [
      {
        question: 'Is video-chatting with grandparents screen time?',
        answer:
          'Video-chatting is treated as an exception in the guidance even for children under two, because it is interactive and social rather than passive viewing.',
      },
      {
        question: 'What matters more, the amount or the content?',
        answer:
          'Both matter. Limits are recommended, but co-viewing, high-quality content, and protecting sleep and play are emphasized just as strongly.',
      },
    ],
    related: ['toddler-tantrums-how-to-handle', 'child-homework-battles'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'child-homework-battles',
    question: 'How do I stop the nightly homework battles with my child?',
    title: 'Ending homework battles: a calmer approach',
    description:
      'Nightly homework standoffs usually come from a power struggle, not laziness. Shifting from enforcer to supporter, grounded in Siegel and Markham.',
    stage: 'child',
    answer:
      'Nightly homework standoffs are usually a power struggle, not a sign your child is lazy or defiant. The most effective shift is from enforcer to supporter: set a predictable routine, hand your child ownership of the work, and protect the relationship over any single assignment.',
    sections: [
      {
        heading: 'Why the battle happens',
        body: [
          'Siegel\'s whole-brain view is that a stressed, cornered child goes into fight-or-flight, and their reasoning brain goes offline — which is exactly the state a homework standoff creates. Pushing harder tends to deepen the resistance rather than resolve it.',
          'When homework becomes the parent\'s job to enforce, the child stops owning it. The struggle then is over control, not the actual worksheet.',
        ],
      },
      {
        heading: 'What helps',
        body: [
          'Markham\'s approach is to connect first and reduce the pressure: a predictable time and calm place for homework, a short break to reset if your child is fried, and empathy for how hard it feels ("this looks like a lot"). Then hand ownership back — your role is support and encouragement, not doing or policing the work.',
          'Natural consequences at school (an unfinished assignment) often teach more than a nightly fight at home. Siegel\'s "connect and redirect" applies: calm the emotion first, then problem-solve together about what would make homework easier.',
        ],
      },
      {
        heading: 'When to look deeper',
        body: [
          'Persistent, intense homework struggles can signal something underneath — a learning difficulty, attention challenges, anxiety, or work that is genuinely too hard. If the battles are constant, talk with your child\'s teacher and, if needed, your provider.',
        ],
      },
    ],
    citations: [
      {
        framework: 'siegel',
        reference:
          'Daniel Siegel & Tina Payne Bryson, The Whole-Brain Child — fight-or-flight and "connect and redirect"',
        excerpt: 'A stressed child\'s reasoning brain goes offline; connect and calm before problem-solving.',
      },
      {
        framework: 'markham',
        reference: 'Laura Markham, Aha! Parenting — reduce pressure, hand back ownership (ahaparenting.com)',
        excerpt: 'Connect first, keep a calm routine, and let the child own the work.',
      },
    ],
    faqs: [
      {
        question: 'Should I sit with my child for all of their homework?',
        answer:
          'Some support helps, but doing or policing every assignment tends to remove the child\'s ownership. Aim to be available and encouraging while the work stays theirs.',
      },
      {
        question: 'When should I worry about homework struggles?',
        answer:
          'If struggles are constant and intense, they can point to a learning, attention, or anxiety issue, or work that is too hard. Loop in the teacher and, if needed, your provider.',
      },
    ],
    related: ['child-managing-screen-time', 'child-sibling-fighting'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'child-sibling-fighting',
    question: 'How do I handle constant fighting between my kids?',
    title: 'Sibling fighting: how to referee less and coach more',
    description:
      'Sibling conflict is normal and even useful for learning to negotiate. How to step back from refereeing and coach conflict-resolution skills, grounded in Markham and Siegel.',
    stage: 'child',
    answer:
      'Frequent squabbling between siblings is normal, and some conflict is actually how children learn to negotiate, share, and repair. The shift that helps is from referee to coach: stay neutral, resist taking sides, and teach the skills to work it out — stepping in firmly only when someone is being hurt.',
    sections: [
      {
        heading: 'Some conflict is normal — and useful',
        body: [
          'Sibling conflict is a near-universal part of family life and a training ground for social skills. Markham\'s framing is that jumping in to judge who was right usually fuels rivalry, because children compete for the parent as judge. Staying out of the role of referee lowers the stakes.',
        ],
      },
      {
        heading: 'Coach instead of referee',
        body: [
          'Markham suggests staying neutral, describing what you see without blaming ("two kids, one tablet, a big problem"), and inviting them to solve it. Siegel adds that a flooded child cannot problem-solve, so separate and calm first if things are hot, then bring them back to work it out.',
          'Protect each child\'s sense of being loved for who they are rather than compared. Comparisons and labels ("the responsible one," "the wild one") tend to intensify rivalry.',
        ],
      },
      {
        heading: 'When to step in — and when to seek help',
        body: [
          'Step in immediately and firmly when there is physical harm or genuine cruelty; safety is not negotiable. If conflict is relentless, one-sided in a way that looks like bullying, or a child seems genuinely distressed, talk with your provider about what might be underneath.',
        ],
      },
    ],
    citations: [
      {
        framework: 'markham',
        reference: 'Laura Markham, Peaceful Parent, Happy Siblings — coach, do not referee (ahaparenting.com)',
        excerpt: 'Staying neutral and coaching resolution lowers rivalry; refereeing fuels it.',
      },
      {
        framework: 'siegel',
        reference: 'Daniel Siegel & Tina Payne Bryson, The Whole-Brain Child — calm before problem-solving',
        excerpt: 'A flooded child cannot negotiate; separate and calm first, then resolve.',
      },
    ],
    faqs: [
      {
        question: 'Should I figure out who started it?',
        answer:
          'Playing judge usually backfires by making the parent a prize to compete for. Staying neutral and coaching both children to solve the problem tends to reduce conflict.',
      },
      {
        question: 'When is sibling fighting a real problem?',
        answer:
          'When there is physical harm, cruelty, or one child is consistently targeted or distressed. Step in for safety immediately, and talk to your provider if it is relentless.',
      },
    ],
    related: ['child-homework-battles', 'child-managing-screen-time'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'child-managing-screen-time',
    question: 'How do I set screen time limits for my school-age child?',
    title: 'Screen time for school-age kids: setting workable limits',
    description:
      'For school-age children, guidance shifts from fixed hour-caps to a family plan that protects sleep, activity, and family time. What that looks like in practice.',
    stage: 'child',
    answer:
      'For school-age children, guidance moves away from a single hour-cap toward a family plan: screens should not crowd out sleep, physical activity, meals together, and unstructured play, and content and context matter as much as total minutes. A consistent, collaboratively set plan tends to work better than an arbitrary number.',
    sections: [
      {
        heading: 'From hour-caps to a family plan',
        body: [
          'The Canadian Paediatric Society and the American Academy of Pediatrics both shift, for school-age children, from a strict daily number toward ensuring screens do not displace the essentials: enough sleep, daily physical activity, in-person time, and homework. The AAP encourages a family media plan that fits your household.',
          'One caveat if your child is a young preschooler: for children under about five, the CPS and AAP still recommend limiting routine screen time to about an hour a day. The move away from a fixed hour-cap describes older, school-age children — so for a four- or five-year-old, keep the preschool one-hour-a-day guidance in view.',
        ],
      },
      {
        heading: 'What a workable plan includes',
        body: [
          'Common elements: screen-free times (meals, the hour before bed) and screen-free zones (bedrooms); consistent limits your child helped set, which builds buy-in; attention to what they are watching or playing; and modelling — children track how the adults use screens. Protecting sleep is repeatedly emphasized, since screens in the bedroom and late-night use are strongly linked to worse sleep.',
        ],
      },
      {
        heading: 'Keep the relationship in view',
        body: [
          'Markham\'s connection-first lens applies to enforcement: rules land better inside a warm relationship than as pure control, and involving your child in setting limits reduces the power struggle. If screen use is genuinely interfering with sleep, mood, school, or activity, your provider can help.',
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society — "Digital media: Promoting healthy screen use in school-aged children and adolescents" (cps.ca)',
        excerpt: 'For school-age children, ensure screens do not displace sleep, activity, and in-person time.',
      },
      {
        framework: 'aap',
        reference: 'American Academy of Pediatrics — Family Media Plan (healthychildren.org)',
        excerpt: 'Build a family media plan; keep screens out of bedrooms and away from bedtime.',
      },
      {
        framework: 'markham',
        reference: 'Laura Markham, Aha! Parenting — limits inside a warm relationship (ahaparenting.com)',
        excerpt: 'Collaboratively set limits reduce power struggles and land better than pure control.',
      },
    ],
    faqs: [
      {
        question: 'Is there a strict hour limit for school-age kids?',
        answer:
          'Guidance for this age moves away from a single number toward protecting sleep, activity, and family time, with content and context factored in. A consistent family plan is the recommended approach.',
      },
      {
        question: 'Should my child have a screen in their bedroom?',
        answer:
          'Guidance consistently recommends keeping screens out of bedrooms and away from bedtime, largely to protect sleep.',
      },
    ],
    related: ['child-homework-battles', 'toddler-screen-time-guidelines'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'teen-mental-health-warning-signs',
    question: 'What are warning signs of a mental health problem in my teenager?',
    title: 'Teen mental health: warning signs worth acting on',
    description:
      'Some moodiness is normal in adolescence, but certain changes warrant a professional conversation. The warning signs, and how to open the door without pushing your teen away.',
    stage: 'teenager',
    answer:
      'Some moodiness and pulling away is a normal part of adolescence, but a lasting change in mood, functioning, or behaviour deserves attention. Warning signs worth acting on include a persistent low or hopeless mood, withdrawal from friends and activities once enjoyed, big changes in sleep, appetite, or school performance, and — most urgently — any talk of self-harm or not wanting to be alive.',
    sections: [
      {
        heading: 'Normal adolescence vs. a warning sign',
        body: [
          'Adolescence involves real emotional ups and downs and a healthy push toward independence. The Canadian Paediatric Society points to duration, intensity, and impact as what distinguishes typical teen moods from a concern: changes that last more than a couple of weeks, are severe, or interfere with daily life — friendships, school, family, self-care — are the ones to take seriously.',
        ],
      },
      {
        heading: 'Signs worth a professional conversation',
        body: [
          'Persistent sadness, irritability, or hopelessness; loss of interest in friends and activities they used to enjoy; marked changes in sleep or appetite; falling grades or skipping school; increased risk-taking or substance use; talk of worthlessness or being a burden; and — always urgent — any mention of self-harm or suicide. Any expression of suicidal thinking is an emergency: contact a crisis line, your provider, or emergency services right away.',
        ],
      },
      {
        heading: 'How to open the door',
        body: [
          'Siegel\'s work on the adolescent brain reframes this age as a period of important development, not just difficulty, and stresses staying connected. Approach with calm curiosity rather than interrogation, listen without rushing to fix, and take what your teen says seriously. Honour their growing autonomy while making clear you are there — and loop in professionals for anything touching safety or lasting change.',
        ],
      },
    ],
    citations: [
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — teen mental health and when to seek help (caringforkids.cps.ca)',
        excerpt:
          'Duration, intensity, and impact separate typical teen moods from a concern; act on lasting or severe changes.',
      },
      {
        framework: 'siegel_brainstorm',
        reference: 'Daniel Siegel, Brainstorm: The Power and Purpose of the Teenage Brain',
        excerpt: 'Adolescence is a period of essential brain development; staying connected matters.',
      },
    ],
    faqs: [
      {
        question: 'How do I tell normal teen moodiness from depression?',
        answer:
          'Look at duration, intensity, and impact: changes lasting more than a couple of weeks, that are severe, or that interfere with friendships, school, or self-care deserve a professional conversation.',
      },
      {
        question: 'My teen mentioned self-harm — what do I do?',
        answer:
          'Treat any mention of self-harm or suicide as urgent. Contact a crisis line, your provider, or emergency services right away, and stay with your teen. This is not something to wait on.',
      },
    ],
    related: ['teen-setting-boundaries-autonomy'],
    updated: '2026-07-02',
    published: true,
  },
  {
    slug: 'teen-setting-boundaries-autonomy',
    question: 'How do I set boundaries with my teenager without pushing them away?',
    title: 'Boundaries with teens: firm limits, open relationship',
    description:
      'Teens need both autonomy and limits. How to hold clear boundaries while keeping the relationship open, grounded in Siegel’s work on the adolescent brain.',
    stage: 'teenager',
    answer:
      'Teenagers need both real autonomy and clear limits — and the two are not in conflict. Boundaries land best when they are few, clearly reasoned, and set with your teen rather than dictated at them, inside a relationship where they feel heard. The goal is a firm limit and an open door, not control.',
    sections: [
      {
        heading: 'Why autonomy and limits go together',
        body: [
          'Siegel describes adolescence as a period of pushing toward independence and identity, driven by real brain development — not just defiance. Teens who are given age-appropriate autonomy and involved in setting the rules that affect them are more likely to internalize those limits than teens who are simply controlled.',
        ],
      },
      {
        heading: 'Setting boundaries that hold',
        body: [
          'Keep the non-negotiables few and focused on safety and respect, and explain the "why" rather than "because I said so" — teens respond to reasoning. Where you can, negotiate the details with them, which gives them ownership. Be consistent, and let natural and pre-agreed consequences do the work instead of escalating punishment.',
          'Siegel\'s emphasis on staying connected matters most here: the relationship is what keeps a teen coming back and talking, which is your best source of influence and your best early-warning system. A limit delivered with respect protects the relationship; one delivered with contempt erodes it.',
        ],
      },
      {
        heading: 'When to seek support',
        body: [
          'If conflict is constant and severe, if a teen is repeatedly unsafe, or if you see signs of a mental health concern, involve your provider or a family professional. Persistent, escalating conflict is worth support, not just tougher rules.',
        ],
      },
    ],
    citations: [
      {
        framework: 'siegel_brainstorm',
        reference: 'Daniel Siegel, Brainstorm: The Power and Purpose of the Teenage Brain',
        excerpt:
          'Adolescent autonomy is developmentally driven; involving teens in limits and staying connected builds influence.',
      },
      {
        framework: 'cps',
        reference:
          'Canadian Paediatric Society, Caring for Kids — "How to talk with your teen" (caringforkids.cps.ca/handouts/behavior-and-development/talk_with_your_teen)',
        excerpt:
          'Listen to your teen with patience and acceptance, acknowledge your differences without judging, respect their privacy, and step away to stay calm if a conversation heats up.',
      },
    ],
    faqs: [
      {
        question: 'Should teenagers have a say in the rules?',
        answer:
          'Involving teens in setting the limits that affect them tends to build ownership and makes the limits more likely to stick, compared with rules dictated without discussion.',
      },
      {
        question: 'What if my teen breaks the rules anyway?',
        answer:
          'Consistent, pre-agreed consequences delivered without contempt tend to work better than escalating punishment. If conflict is constant or a teen is repeatedly unsafe, seek support from your provider.',
      },
    ],
    related: ['teen-mental-health-warning-signs'],
    updated: '2026-07-02',
    published: true,
  },
];

/** All answer pages, published or not — used for static params and the review queue. */
export const allAnswers: readonly AnswerPage[] = ANSWERS;

/** Only pages a human has approved for indexing — used by the sitemap and index page. */
export const publishedAnswers: readonly AnswerPage[] = ANSWERS.filter((a) => a.published);

export function getAnswer(slug: string): AnswerPage | undefined {
  return ANSWERS.find((a) => a.slug === slug);
}
