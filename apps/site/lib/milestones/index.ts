import type { FamilyStage } from '@hale/types';
import type { MilestoneCheckpoint } from './types';

export type { MilestoneCheckpoint, MilestoneDomain, MilestoneDomainGroup } from './types';

/**
 * The 12 CDC "Learn the Signs. Act Early." age checkpoints (2022 AAP/CDC
 * revision). Milestone wording is the CDC's own, rendered in they/them (the CDC
 * alternates he/she) with meaning preserved — the pre-publish review gate
 * re-fetches each `sourceUrl` and diffs our copy against it.
 *
 * This is YMYL content: every checkpoint ships `published: false`, so pages
 * render noindex and stay out of the sitemap until a human reviews the copy
 * against its cited CDC URL. To take an age live: set `published: true`.
 *
 * Framing rule: these pages describe an age, never evaluate a child. There are
 * no inputs, no checkboxes, and nothing to score — a milestone list you cannot
 * "fail" is just a portrait of the age.
 */
const CHECKPOINTS: MilestoneCheckpoint[] = [
  {
    slug: '2-months',
    months: 2,
    ageLabel: '2 months',
    title: "What's typical around 2 months",
    description:
      'Milestones most babies reach by around 2 months, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'newborn',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/2-months.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'calms down when spoken to or picked up',
          'looks at your face',
          'seems happy to see you when you walk up to them',
          'smiles when you talk to or smile at them',
        ],
      },
      {
        domain: 'language-communication',
        items: ['makes sounds other than crying', 'reacts to loud sounds'],
      },
      {
        domain: 'cognitive',
        items: ['watches you as you move', 'looks at a toy for several seconds'],
      },
      {
        domain: 'movement-physical',
        items: [
          'holds their head up when on their tummy',
          'moves both arms and both legs',
          'opens their hands briefly',
        ],
      },
    ],
  },
  {
    slug: '4-months',
    months: 4,
    ageLabel: '4 months',
    title: "What's typical around 4 months",
    description:
      'Milestones most babies reach by around 4 months, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'newborn',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/4-months.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'smiles on their own to get your attention',
          'chuckles (not yet a full laugh) when you try to make them laugh',
          'looks at you, moves, or makes sounds to get or keep your attention',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'makes sounds like "oooo" and "aahh" (cooing)',
          'makes sounds back when you talk to them',
          'turns their head towards the sound of your voice',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'if hungry, opens their mouth when they see a breast or bottle',
          'looks at their hands with interest',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'holds their head steady without support when you are holding them',
          'holds a toy when you put it in their hand',
          'uses their arm to swing at toys',
          'brings their hands to their mouth',
          'pushes up onto their elbows and forearms when on their tummy',
        ],
      },
    ],
  },
  {
    slug: '6-months',
    months: 6,
    ageLabel: '6 months',
    title: "What's typical around 6 months",
    description:
      'Milestones most babies reach by around 6 months, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'newborn',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/6-months.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'knows familiar people',
          'likes to look at themselves in a mirror',
          'laughs',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'takes turns making sounds with you',
          'blows "raspberries" (sticks their tongue out and blows)',
          'makes squealing noises',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'puts things in their mouth to explore them',
          'reaches to grab a toy they want',
          'closes their lips to show they do not want more food',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'rolls from their tummy to their back',
          'pushes up with straight arms when on their tummy',
          'leans on their hands to support themselves when sitting',
        ],
      },
    ],
  },
  {
    slug: '9-months',
    months: 9,
    ageLabel: '9 months',
    title: "What's typical around 9 months",
    description:
      'Milestones most babies reach by around 9 months, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'newborn',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/9-months.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'is shy, clingy, or fearful around strangers',
          'shows several facial expressions, like happy, sad, angry, and surprised',
          'looks when you call their name',
          'reacts when you leave, by looking, reaching for you, or crying',
          'smiles or laughs when you play peek-a-boo',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'makes a lot of different sounds, like "mamamama" and "bababababa"',
          'lifts their arms up to be picked up',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'looks for objects when dropped out of sight, like a spoon or toy',
          'bangs two things together',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'gets to a sitting position by themselves',
          'moves things from one hand to their other hand',
          'uses their fingers to "rake" food towards themselves',
          'sits without support',
        ],
      },
    ],
  },
  {
    slug: '12-months',
    months: 12,
    ageLabel: '12 months',
    title: "What's typical around 12 months",
    description:
      'Milestones most children reach by around 12 months, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'toddler',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/1-year.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: ['plays games with you, like pat-a-cake'],
      },
      {
        domain: 'language-communication',
        items: [
          'waves "bye-bye"',
          'calls a parent "mama" or "dada" or another special name',
          'understands "no" — pauses briefly or stops when you say it',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'puts something in a container, like a block in a cup',
          'looks for things they see you hide, like a toy under a blanket',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'pulls up to stand',
          'walks holding on to furniture',
          'drinks from a cup without a lid as you hold it',
          'picks things up between their thumb and pointer finger, like small bits of food',
        ],
      },
    ],
  },
  {
    slug: '15-months',
    months: 15,
    ageLabel: '15 months',
    title: "What's typical around 15 months",
    description:
      'Milestones most children reach by around 15 months, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'toddler',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/15-months.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'copies other children while playing, like taking toys out of a container when another child does',
          'shows you an object they like',
          'claps when excited',
          'hugs a stuffed doll or other toy',
          'shows you affection with hugs, cuddles, or kisses',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'tries to say one or two words besides "mama" or "dada", like "ba" for ball',
          'looks at a familiar object when you name it',
          'follows directions given with both a gesture and words',
          'points to ask for something or to get help',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'tries to use things the right way, like a phone, cup, or book',
          'stacks at least two small objects, like blocks',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'takes a few steps on their own',
          'uses their fingers to feed themselves some food',
        ],
      },
    ],
  },
  {
    slug: '18-months',
    months: 18,
    ageLabel: '18 months',
    title: "What's typical around 18 months",
    description:
      'Milestones most children reach by around 18 months, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'toddler',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/18-months.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'moves away from you but looks to make sure you are close by',
          'points to show you something interesting',
          'puts their hands out for you to wash them',
          'looks at a few pages in a book with you',
          'helps you dress them by pushing an arm through a sleeve or lifting a foot',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'tries to say three or more words besides "mama" or "dada"',
          'follows one-step directions without any gestures, like giving you a toy when you say "give it to me"',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'copies you doing chores, like sweeping with a broom',
          'plays with toys in a simple way, like pushing a toy car',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'walks without holding on to anyone or anything',
          'scribbles',
          'drinks from a cup without a lid, and may spill sometimes',
          'feeds themselves with their fingers',
          'tries to use a spoon',
          'climbs on and off a couch or chair without help',
        ],
      },
    ],
  },
  {
    slug: '2-years',
    months: 24,
    ageLabel: '2 years',
    title: "What's typical around 2 years",
    description:
      'Milestones most children reach by around 2 years, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'toddler',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/2-years.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'notices when others are hurt or upset, like pausing or looking sad when someone is crying',
          'looks at your face to see how to react in a new situation',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'points to things in a book when you ask, like "where is the bear?"',
          'says at least two words together, like "More milk"',
          'points to at least two body parts when you ask them to show you',
          'uses more gestures than just waving and pointing, like blowing a kiss or nodding yes',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'holds something in one hand while using the other, like holding a container and taking the lid off',
          'tries to use switches, knobs, or buttons on a toy',
          'plays with more than one toy at the same time, like putting toy food on a toy plate',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'kicks a ball',
          'runs',
          'walks (not climbs) up a few stairs with or without help',
          'eats with a spoon',
        ],
      },
    ],
  },
  {
    slug: '30-months',
    months: 30,
    ageLabel: '30 months',
    title: "What's typical around 30 months",
    description:
      'Milestones most children reach by around 30 months, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'toddler',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/30-months.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'plays next to other children and sometimes plays with them',
          'shows you what they can do, like saying "Look at me!"',
          'follows simple routines when told, like helping to pick up toys when you say "it\'s clean-up time"',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'says about 50 words',
          'says two or more words together, with one action word, like "Doggie run"',
          'names things in a book when you point and ask "what is this?"',
          'says words like "I", "me", or "we"',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'uses things to pretend, like feeding a block to a doll as if it were food',
          'shows simple problem-solving skills, like standing on a small stool to reach something',
          'follows two-step instructions, like "put the toy down and close the door"',
          'shows they know at least one colour, like pointing to a red crayon when you ask',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'uses their hands to twist things, like turning doorknobs or unscrewing lids',
          'takes some clothes off by themselves, like loose pants or an open jacket',
          'jumps off the ground with both feet',
          'turns book pages one at a time when you read to them',
        ],
      },
    ],
  },
  {
    slug: '3-years',
    months: 36,
    ageLabel: '3 years',
    title: "What's typical around 3 years",
    description:
      'Milestones most children reach by around 3 years, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'toddler',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/3-years.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'calms down within 10 minutes after you leave them, like at a childcare drop-off',
          'notices other children and joins them to play',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'talks with you in a conversation using at least two back-and-forth exchanges',
          'asks "who", "what", "where", or "why" questions, like "where is mommy?"',
          'says what action is happening in a picture or book when you ask, like "running", "eating", or "playing"',
          'says their first name when asked',
          'talks well enough for others to understand most of the time',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'draws a circle when you show them how',
          'avoids touching hot objects, like a stove, when you warn them',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'strings items together, like large beads or macaroni',
          'puts on some clothes by themselves, like loose pants or a jacket',
          'uses a fork',
        ],
      },
    ],
  },
  {
    slug: '4-years',
    months: 48,
    ageLabel: '4 years',
    title: "What's typical around 4 years",
    description:
      'Milestones most children reach by around 4 years, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'child',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/4-years.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'pretends to be something else during play, like a teacher, superhero, or dog',
          'asks to go play with children if none are around, like "can I play with Alex?"',
          'comforts others who are hurt or sad, like hugging a crying friend',
          'avoids danger, like not jumping from tall heights at the playground',
          'likes to be a "helper"',
          'changes their behaviour based on where they are, like a place of worship, a library, or a playground',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'says sentences with four or more words',
          'says some words from a song, story, or nursery rhyme',
          'talks about at least one thing that happened during their day, like "I played soccer"',
          'answers simple questions, like "what is a coat for?" or "what is a crayon for?"',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'names a few colours of items',
          'tells what comes next in a well-known story',
          'draws a person with three or more body parts',
        ],
      },
      {
        domain: 'movement-physical',
        items: [
          'catches a large ball most of the time',
          'serves themselves food or pours water, with adult supervision',
          'unbuttons some buttons',
          'holds a crayon or pencil between their fingers and thumb, not in a fist',
        ],
      },
    ],
  },
  {
    slug: '5-years',
    months: 60,
    ageLabel: '5 years',
    title: "What's typical around 5 years",
    description:
      'Milestones most children reach by around 5 years, from the CDC checklists with Canadian guidance from the CPS. A portrait of typical, not a test — nothing to score.',
    stage: 'child',
    sourceUrl: 'https://www.cdc.gov/act-early/milestones/5-years.html',
    updated: '2026-07-03',
    published: true,
    domains: [
      {
        domain: 'social-emotional',
        items: [
          'follows rules or takes turns when playing games with other children',
          'sings, dances, or acts for you',
          'does simple chores at home, like matching socks or clearing the table after eating',
        ],
      },
      {
        domain: 'language-communication',
        items: [
          'tells a story they heard or made up with at least two events, like a cat was stuck in a tree and a firefighter saved it',
          'answers simple questions about a book or story after you read or tell it to them',
          'keeps a conversation going with more than three back-and-forth exchanges',
          'uses or recognizes simple rhymes, like bat-cat or ball-tall',
        ],
      },
      {
        domain: 'cognitive',
        items: [
          'counts to 10',
          'names some numbers between 1 and 5 when you point to them',
          'uses words about time, like "yesterday", "tomorrow", "morning", or "night"',
          'pays attention for 5 to 10 minutes during activities, not counting screen time',
          'writes some letters in their name',
          'names some letters when you point to them',
        ],
      },
      {
        domain: 'movement-physical',
        items: ['buttons some buttons', 'hops on one foot'],
      },
    ],
  },
];

/** Every checkpoint, including unpublished drafts. Sorted by age (non-empty). */
export const allCheckpoints: [MilestoneCheckpoint, ...MilestoneCheckpoint[]] = [
  ...CHECKPOINTS,
].sort((a, b) => a.months - b.months) as [MilestoneCheckpoint, ...MilestoneCheckpoint[]];

/** Only human-reviewed checkpoints — what the sitemap and hub index may list. */
export const publishedCheckpoints: MilestoneCheckpoint[] = allCheckpoints.filter(
  (c) => c.published,
);

/** A checkpoint by slug, or undefined. */
export function getCheckpoint(slug: string): MilestoneCheckpoint | undefined {
  return allCheckpoints.find((c) => c.slug === slug);
}

/**
 * The checkpoint at or below `months` — never above. Rounding up would show an
 * older child's list and manufacture false worry; the at-or-below list is what
 * most children this age already do, which reads as reassurance. Ages under the
 * youngest checkpoint (2 months) return that youngest checkpoint.
 */
export function checkpointForMonths(months: number): MilestoneCheckpoint {
  let match = allCheckpoints[0];
  for (const c of allCheckpoints) {
    if (c.months <= months) match = c;
  }
  return match;
}

/** The previous and next checkpoints for the "looking back / looking ahead" links. */
export function adjacentCheckpoints(slug: string): {
  prev: MilestoneCheckpoint | undefined;
  next: MilestoneCheckpoint | undefined;
} {
  const i = allCheckpoints.findIndex((c) => c.slug === slug);
  return {
    prev: i > 0 ? allCheckpoints[i - 1] : undefined,
    next: i >= 0 && i < allCheckpoints.length - 1 ? allCheckpoints[i + 1] : undefined,
  };
}

/** The stage each checkpoint sits in — exported for related-answer selection. */
export function stageOf(checkpoint: MilestoneCheckpoint): FamilyStage {
  return checkpoint.stage;
}
