import { deriveStage } from '@hale/types';
import { AddCoParentCard } from '~/components/hale/add-coparent-card';
import { FamilyChildren } from '~/components/hale/family-children';
import { FamilyIntents } from '~/components/hale/family-intents';
import { TeenAccessGrants } from '~/components/hale/teen-access-grants';
import type { FamilyBasicsView } from '~/lib/dashboard/family-basics';
import type { FamilyMembersView } from '~/lib/dashboard/family-members';
import type { TeenAccessGrantSummary } from '~/lib/teen-access';
import { PortalHeading } from './heading';
import styles from './portal.module.css';
import { PostalEditor } from './postal-editor';

export function PortalFamily({
  members,
  basics,
  openInvite,
  teenGrants,
}: {
  members: FamilyMembersView;
  basics: FamilyBasicsView;
  openInvite: { expiresAt: string } | null;
  teenGrants: TeenAccessGrantSummary[];
}) {
  const hasTeen = basics.children.some((child) => deriveStage(child.dateOfBirth) === 'teenager');
  const childNames = Object.fromEntries(basics.children.map((child) => [child.id, child.name]));
  const you = members.primary?.name?.trim() || members.primary?.email || null;

  return (
    <>
      <PortalHeading title="Family" lede="Who Hale helps, and who can see it." />
      <div className={styles.grid}>
        <div className={styles.col}>
          <section className={styles.card}>
            <span className={styles.tag}>Kids</span>
            <FamilyChildren
              kids={basics.children}
              emptyLabel="No kids yet."
              addLabel="Add a child"
              editLabel="Edit"
            />
          </section>
          <section className={styles.card}>
            <span className={styles.tag}>What you want help with</span>
            <FamilyIntents intents={basics.intents} legend="What you want help with" />
            <p className={styles.text}>
              Hale uses these to pick what to text you. Change them by text anytime.
            </p>
          </section>
        </div>
        <div className={styles.col}>
          <section className={styles.card}>
            <span className={styles.tag}>Parents</span>
            {members.primary ? (
              <div className={`${styles.row} ${styles.tight}`}>
                <span>
                  <h3 data-hale-pii>{you ? `${you} (you)` : '(you)'}</h3>
                  <p className={styles.meta}>Full access</p>
                </span>
              </div>
            ) : null}
            {members.coParent ? (
              <div className={`${styles.row} ${styles.tight}`}>
                <span>
                  {members.coParent.name?.trim() || members.coParent.email ? (
                    <h3 data-hale-pii>{members.coParent.name?.trim() || members.coParent.email}</h3>
                  ) : null}
                  <p className={styles.meta}>Full access</p>
                </span>
              </div>
            ) : (
              <AddCoParentCard
                plain
                title="Add your co-parent"
                description="They get the same texts and settings."
                actionLabel="Invite"
                openInvite={openInvite}
              />
            )}
          </section>
          <section className={styles.card}>
            <span className={styles.tag}>Your area</span>
            <PostalEditor location={basics.location} />
          </section>
        </div>
      </div>
      {hasTeen ? (
        <div className={styles.one}>
          <section className={`${styles.card} ${styles.span}`}>
            <span className={styles.tag}>teen privacy</span>
            <TeenAccessGrants grants={teenGrants} childNames={childNames} />
          </section>
        </div>
      ) : null}
    </>
  );
}
