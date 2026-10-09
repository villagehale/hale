import type { ComponentProps, ReactNode } from 'react';
import {
  BACK_TO_TEXTS,
  BUBBLE_LABEL,
  CHANGED_TAG,
  CONTINUE_LABEL,
  type CopyPart,
  FALLBACK_HEADING,
  FALLBACK_LEDE,
  GOOGLE_BUTTON_LABEL,
  type LandingCopy,
  NEVER_TAG,
  READS_TAG,
  SIGNING_IN,
  type StatusCopy,
  TRY_AGAIN_LABEL,
} from '~/lib/channel/connect/connect-page-copy';
import styles from './connect.module.css';
import {
  BanIcon,
  CalendarIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  EyeIcon,
  GearIcon,
  GoogleG,
  InfoIcon,
  LinkIcon,
  MailIcon,
  PeopleIcon,
  XIcon,
} from './icons';

type FormAction = NonNullable<ComponentProps<'form'>['action']>;

export function Rich({ parts }: { parts: readonly CopyPart[] }) {
  return parts.map((part, index) => {
    const key = `${index}`;
    if (typeof part === 'string') return <span key={key}>{part}</span>;
    if ('br' in part) return <br key={key} />;
    return (
      <span key={key} className={styles.nw}>
        {part.nw}
      </span>
    );
  });
}

function Tile({
  icon,
  amber,
}: {
  icon: StatusCopy['icon'] | 'gear';
  amber?: boolean;
}) {
  const glyph = {
    mail: <MailIcon />,
    calendar: <CalendarIcon />,
    x: <XIcon />,
    check: <CheckIcon />,
    clock: <ClockIcon />,
    info: <InfoIcon />,
    link: <LinkIcon />,
    people: <PeopleIcon />,
    gear: <GearIcon />,
  }[icon];
  return <span className={amber ? `${styles.tile} ${styles.did}` : styles.tile}>{glyph}</span>;
}

function Pair({ icon, amber }: { icon: 'mail' | 'calendar'; amber?: boolean }) {
  return (
    <div className={styles.pair}>
      <img className={styles.pairMark} src="/connect/hale-logo.jpeg" alt="Hale" />
      <span className={styles.dots} aria-hidden="true" />
      <Tile icon={icon} amber={amber} />
    </div>
  );
}

function TextsButton({ href }: { href: string }) {
  return (
    <a className={styles.btn} href={href}>
      <ChatIcon />
      {BACK_TO_TEXTS}
    </a>
  );
}

export function LandingCard({
  copy,
  pending = false,
  formAction,
}: {
  copy: LandingCopy;
  pending?: boolean;
  formAction?: FormAction;
}) {
  const service = copy.provider === 'gmail' ? 'mail' : 'calendar';
  return (
    <section className={`${styles.card} ${styles.split}`} aria-label={copy.aria}>
      <div className={styles.act}>
        <Pair icon={service} />
        <p className={styles.eyebrow}>{copy.eyebrow}</p>
        <h1 className={styles.h1}>
          <Rich parts={copy.title} />
        </h1>
        <p className={styles.lede}>
          <Rich parts={copy.lede} />
        </p>
        <form className={styles.form} action={formAction}>
          <button
            type="submit"
            className={pending ? `${styles.gsi} ${styles.pending}` : styles.gsi}
            disabled={pending || !formAction}
          >
            <GoogleG className={styles.g} />
            {GOOGLE_BUTTON_LABEL}
          </button>
        </form>
        {pending ? (
          <p className={styles.wait}>
            <span className={styles.spin} aria-hidden="true" />
            {SIGNING_IN}
          </p>
        ) : null}
        <p className={styles.note}>
          <InfoIcon />
          <span>{copy.note}</span>
        </p>
      </div>
      <div className={styles.info}>
        <div className={styles.sec}>
          <p className={styles.tag}>{READS_TAG}</p>
          <ul className={styles.list}>
            {copy.reads.map((item) => (
              <li
                key={item
                  .map((part) => (typeof part === 'string' ? part : 'nw' in part ? part.nw : '|'))
                  .join('')}
              >
                <EyeIcon />
                <span>
                  <Rich parts={item} />
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.sec}>
          <p className={styles.tag}>{NEVER_TAG}</p>
          <ul className={`${styles.list} ${styles.no}`}>
            {copy.never.map((item) => (
              <li
                key={item
                  .map((part) => (typeof part === 'string' ? part : 'nw' in part ? part.nw : '|'))
                  .join('')}
              >
                <BanIcon />
                <span>
                  <Rich parts={item} />
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.sec}>
          <p className={styles.tag}>{CHANGED_TAG}</p>
          <p className={styles.detail}>
            <Rich parts={copy.disconnect} />
          </p>
        </div>
      </div>
    </section>
  );
}

export function FallbackCard({
  pending = false,
  formAction,
}: {
  pending?: boolean;
  formAction?: FormAction;
}) {
  return (
    <section className={styles.card} aria-label={FALLBACK_HEADING}>
      <div className={styles.act}>
        <Tile icon="link" />
        <h1 className={styles.h1}>{FALLBACK_HEADING}</h1>
        <p className={styles.lede}>{FALLBACK_LEDE}</p>
        <form className={styles.form} action={formAction}>
          <button type="submit" className={styles.btn} disabled={pending || !formAction}>
            {pending ? SIGNING_IN : CONTINUE_LABEL}
          </button>
        </form>
      </div>
    </section>
  );
}

export function StatusCard({
  copy,
  smsHref,
  formAction,
  pending = false,
}: {
  copy: StatusCopy;
  smsHref: string | null;
  formAction?: FormAction;
  pending?: boolean;
}) {
  return (
    <section className={styles.card} aria-label={copy.aria}>
      <div className={styles.act}>
        {copy.paired && (copy.icon === 'mail' || copy.icon === 'calendar') ? (
          <Pair icon={copy.icon} amber={copy.amber} />
        ) : (
          <Tile icon={copy.icon} amber={copy.amber} />
        )}
        <h1 className={styles.h1}>
          <Rich parts={copy.heading} />
        </h1>
        <p className={styles.lede}>
          <Rich parts={copy.lede} />
        </p>
        {copy.bubble ? (
          <div className={styles.bubble}>
            <p className={styles.bubbleLabel}>{BUBBLE_LABEL}</p>
            <div className={styles.msg}>
              <Rich parts={copy.bubble} />
            </div>
          </div>
        ) : null}
        {copy.detail ? (
          <p className={styles.detail}>
            <Rich parts={copy.detail} />
          </p>
        ) : null}
        {copy.help ? (
          <div className={styles.help}>
            <CheckIcon />
            <span>
              <b>{copy.help.title}</b>
              <Rich parts={copy.help.body} />
            </span>
          </div>
        ) : null}
        {copy.retry && formAction ? (
          <form className={styles.form} action={formAction}>
            <button type="submit" className={styles.btn} disabled={pending}>
              {TRY_AGAIN_LABEL}
            </button>
          </form>
        ) : null}
        {copy.sms && smsHref ? <TextsButton href={smsHref} /> : null}
      </div>
    </section>
  );
}

function Row({
  icon,
  title,
  meta,
  children,
  action,
}: {
  icon: 'calendar' | 'mail';
  title: string;
  meta: string;
  children?: ReactNode;
  action: string;
}) {
  return (
    <div className={styles.row}>
      <Tile icon={icon} />
      <div>
        <h3>{title}</h3>
        <p className={styles.meta}>{meta}</p>
        {children}
        <div className={styles.rowAct}>
          <a className={styles.secondary} href="#apps">
            {action}
          </a>
        </div>
      </div>
    </div>
  );
}

/** The design's connections card. Settings itself keeps its receipts layout; this is the dev preview of the concept. */
export function DisconnectPreview() {
  return (
    <section className={styles.card} aria-label="Connections">
      <div className={styles.act}>
        <Tile icon="gear" />
        <h1 className={styles.h1}>Connections</h1>
        <p className={styles.lede}>
          <Rich
            parts={[
              'Each connection reads one service. Disconnect any time, here or by telling Hale in ',
              { nw: 'your texts.' },
            ]}
          />
        </p>
        <div className={styles.rows}>
          <Row
            icon="calendar"
            title="Google Calendar"
            meta="Connected Oct 6, 2026 · Last synced Oct 6, 2026"
            action="Disconnect"
          >
            <div className={styles.chips}>
              <span>Calendar · read-only</span>
              <span>Profile name · read-only</span>
            </div>
          </Row>
          <Row icon="mail" title="Gmail" meta="Not connected" action="Connect">
            <p className={styles.done}>
              Disconnected. Hale deleted its keys. Google still lists Hale until you remove it at{' '}
              <a href="https://myaccount.google.com/permissions">
                myaccount.google.com/
                <wbr />
                permissions
              </a>
              .
            </p>
          </Row>
        </div>
      </div>
    </section>
  );
}
