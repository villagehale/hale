import { schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { previewPassport } from '~/components/passport/fixture';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { interestPassportDemo } from './demo';
import { type SourceType, iconFor, progressLabel, sourceLabel, stampFaceDate } from './signals';
import { canUndo } from './signals';

export interface StampCard {
  id: string;
  childId: string | null;
  activity: string;
  level: string | null;
  kind: 'activity' | 'outing';
  state: 'inferred' | 'confirmed' | 'removed';
  shared: boolean;
  sourceLabel: string;
  sourceDetail: string | null;
  emailUrl: string | null;
  progress: string | null;
  face: string;
  whenLabel: string | null;
  icon: string;
  inferred: boolean;
  top: string;
}

export interface KidCard {
  id: string;
  name: string;
  meta: string;
  age: string;
  born: string | null;
  grade: string | null;
  schoolDayEnds: string | null;
  notes: string | null;
  stamps: StampCard[];
  removed: StampCard[];
}

export interface PassportModel {
  preview: boolean;
  shareWithGroup: boolean;
  members: { name: string; detail: string }[];
  children: KidCard[];
  unassigned: StampCard[];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ageYears(dob: string, now: Date): number {
  const year = Number(dob.slice(0, 4));
  const month = Number(dob.slice(5, 7));
  const day = Number(dob.slice(8, 10));
  let age = now.getUTCFullYear() - year;
  if ((now.getUTCMonth() + 1) * 100 + now.getUTCDate() < month * 100 + day) age -= 1;
  return Math.max(0, age);
}

function bornLabel(dob: string): string {
  const month = MONTHS[Number(dob.slice(5, 7)) - 1];
  return month ? `Born ${month} ${dob.slice(0, 4)}` : dob;
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const month = SHORT[Number(iso.slice(5, 7)) - 1];
  const day = Number(iso.slice(8, 10));
  if (!month || !day) return null;
  return `${month} ${day}`;
}

function asSource(value: string): SourceType {
  if (value === 'gmail' || value === 'calendar' || value === 'parent' || value === 'group_share') {
    return value;
  }
  return 'gmail';
}

function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first || null;
}

export async function readPassportModel(now = new Date()): Promise<PassportModel> {
  // Preview demo is the fixture only. Checked before the database so a preview
  // that has DATABASE_URL still cannot read a real family.
  if (interestPassportDemo()) return previewPassport();
  if (!process.env.DATABASE_URL) return previewPassport();
  const database = db();
  const familyId = await currentFamilyId(database);
  const viewerId = await currentUserId(database);
  if (!familyId) {
    return { preview: false, shareWithGroup: false, members: [], children: [], unassigned: [] };
  }

  const [children, stamps, profiles, settings, members] = await Promise.all([
    database
      .select({
        id: schema.children.id,
        name: schema.children.name,
        dateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId)),
    database.select().from(schema.kidInterests).where(eq(schema.kidInterests.familyId, familyId)),
    database
      .select()
      .from(schema.kidPassportProfiles)
      .where(eq(schema.kidPassportProfiles.familyId, familyId)),
    database
      .select()
      .from(schema.familyInterestSettings)
      .where(eq(schema.familyInterestSettings.familyId, familyId)),
    database
      .select({
        userId: schema.familyMembers.userId,
        name: schema.users.name,
        role: schema.familyMembers.role,
      })
      .from(schema.familyMembers)
      .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
      .where(eq(schema.familyMembers.familyId, familyId)),
  ]);

  const ownerIds = [
    ...new Set(stamps.map((stamp) => stamp.sourceOwnerUserId).filter(Boolean)),
  ] as string[];
  const owners =
    ownerIds.length === 0
      ? []
      : await database
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, ownerIds));
  const ownerName = new Map(owners.map((owner) => [owner.id, firstName(owner.name)]));
  const profileByChild = new Map(profiles.map((profile) => [profile.childId, profile]));

  const cards = stamps.map((stamp) => {
    const source = asSource(stamp.sourceType);
    const seen = shortDate(stamp.sourceSeenOn);
    const detail = stamp.sourceSubject
      ? `“${stamp.sourceSubject}”${seen ? ` · ${seen}` : ''}`
      : null;
    const faceSource = stamp.sessionStart ?? stamp.sourceSeenOn;
    const progress = progressLabel({
      kind: stamp.kind === 'outing' ? 'outing' : 'activity',
      seasonLabel: stamp.seasonLabel,
      weeksTotal: stamp.weeksTotal,
      weeksElapsed: stamp.weeksElapsed,
      sessionStart: stamp.sessionStart,
      completed: stamp.completedAt !== null,
      now,
    });
    const card: StampCard = {
      id: stamp.id,
      childId: stamp.childId,
      activity: stamp.activity,
      level: stamp.level,
      kind: stamp.kind === 'outing' ? 'outing' : 'activity',
      state: stamp.state === 'removed' || stamp.state === 'confirmed' ? stamp.state : 'inferred',
      shared: stamp.shared,
      sourceLabel: sourceLabel({
        sourceType: source,
        viewerIsOwner: stamp.sourceOwnerUserId !== null && stamp.sourceOwnerUserId === viewerId,
        ownerFirstName: stamp.sourceOwnerUserId
          ? (ownerName.get(stamp.sourceOwnerUserId) ?? null)
          : null,
        sharerFirstName: stamp.sharerFirstName,
        toldOn:
          source === 'parent'
            ? shortDate(stamp.confirmedAt?.toISOString().slice(0, 10) ?? null)
            : null,
      }),
      sourceDetail: detail,
      emailUrl: gmailUrl(source, stamp.sourceRef),
      progress,
      face: faceSource ? stampFaceDate(faceSource) : stamp.seasonLabel.slice(0, 12),
      whenLabel: stamp.whenLabel,
      icon: iconFor(`${stamp.activity} ${stamp.activityKey}`),
      inferred: stamp.state === 'inferred',
      top: (stamp.activity.split(/\s+/)[0] ?? stamp.activity).toUpperCase().slice(0, 12),
    };
    return { card, removedAt: stamp.removedAt, firstSeen: stamp.firstSeen.getTime() };
  });

  const visible = (childId: string | null, removed: boolean) =>
    cards
      .filter(
        (item) =>
          item.card.childId === childId &&
          (removed ? item.card.state === 'removed' : item.card.state !== 'removed'),
      )
      .filter((item) => !removed || canUndo(item.removedAt, now))
      .sort((a, b) => b.firstSeen - a.firstSeen)
      .map((item) => item.card);

  const kids: KidCard[] = children
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => {
      const profile = profileByChild.get(child.id);
      const age = ageYears(child.dateOfBirth, now);
      const grade = profile?.grade ?? null;
      return {
        id: child.id,
        name: child.name,
        meta: grade ? `Age ${age} · ${grade}` : `Age ${age}`,
        age: `Age ${age}`,
        born: bornLabel(child.dateOfBirth),
        grade,
        schoolDayEnds: profile?.schoolDayEnds ?? null,
        notes: profile?.notes ?? null,
        stamps: visible(child.id, false),
        removed: visible(child.id, true),
      };
    });

  return {
    preview: false,
    shareWithGroup: settings[0]?.shareWithGroup ?? false,
    members: members.map((member) => ({
      name:
        member.userId === viewerId
          ? `${firstName(member.name) ?? 'You'} (you)`
          : (firstName(member.name) ?? 'Parent'),
      detail: memberDetail(member.role),
    })),
    children: kids,
    unassigned: visible(null, false),
  };
}

function memberDetail(role: string): string {
  if (role === 'primary_parent') return 'Full access';
  if (role === 'co_parent') return 'Co-parent · full access';
  return 'Caregiver';
}

function gmailUrl(source: SourceType, sourceRef: string): string | null {
  if (source !== 'gmail') return null;
  const messageId = sourceRef.split(':').slice(2).join(':');
  if (!messageId) return null;
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}`;
}

export function kidById(model: PassportModel, childId: string): KidCard | null {
  return model.children.find((child) => child.id === childId) ?? null;
}
