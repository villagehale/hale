import type { ReactNode } from 'react';
import type { Locale } from '~/i18n/routing';
import { logoSrc } from './assets';
import { ImBack, StackAvatars } from './imessage-ui';
import { PhoneChat, TypingBubble } from './phone-chat';
import { tx } from './tx';

function Check() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** The three group-chat examples. `framed` is the phone gallery; the desktop grid is the still. */
export function groupChatSlides(locale: Locale, framed: boolean): ReactNode[] {
  const t = (s: string) => tx(locale, s);
  const step = (value: string) => ({ 'data-motion-step': value });
  const stamp = () => (
    <div className="im-stamp">
      iMessage
      <br />
      <b>{t('Today')}</b> {t('9:41 AM')}
    </div>
  );

  const frame = (name: string, members: string, left: string, right: string, thread: ReactNode, chip: ReactNode) => {
    const head = (
      <>
        <StackAvatars left={left} right={right} />
        <span className="im-name">{name}</span>
        <span className="im-members">{members}</span>
      </>
    );
    const screen = framed ? (
      <PhoneChat>
        <div className="im-phone-head">
          <ImBack />
          {head}
        </div>
        <div className="im-thread im-phone-thread">
          {stamp()}
          {thread}
        </div>
      </PhoneChat>
    ) : (
      <article className="im-screen im-chat">
        <div className="im-head">{head}</div>
        <div className="im-thread">
          {stamp()}
          {thread}
        </div>
      </article>
    );
    return (
      <div data-motion-scene="chat">
        {screen}
        <div className="im-chips">{chip}</div>
      </div>
    );
  };

  return [
    <div key="party">
      <div className="hs-chat-cap">
        <span className="n">01</span>
        <h3 className="hs-h3">{t('A joint birthday party')}</h3>
      </div>
      {frame(
        t('Room 4 parents 🍎'),
        t('Dana, Marco + 7 more'),
        'D',
        'M',
        <>
          <div className="im-run group">
            <div className="im-who">Dana</div>
            <span className="im-pic im-mono">D</span>
            <div className="im-b in tail">{t('Joint party for Leo and Aria? Somewhere indoor 🎈')}</div>
          </div>
          <div className="im-run group" {...step('0.6')}>
            <div className="im-who">Hale</div>
            <img className="im-pic" src={logoSrc} alt="" />
            <TypingBubble />
            <div className="im-b in tail">
              {t(
                'Two nearby take Saturday groups of 8: the climbing gym (ages 3–7) or the clay café (ages 4+). Want me to track RSVPs?',
              )}
            </div>
          </div>
          <div className="im-run group" {...step('2.2')}>
            <div className="im-who">Dana</div>
            <span className="im-pic im-mono">D</span>
            <TypingBubble />
            <div className="im-b in tail">{t('Climbing gym! Booked Sat the 14th at 2')}</div>
          </div>
        </>,
        <span className="hs-did" {...step('3')}>
          <Check />
          {t('6 yes, 2 to go · on everyone’s calendar')}
        </span>,
      )}
    </div>,
    <div key="carpool">
      <div className="hs-chat-cap">
        <span className="n">02</span>
        <h3 className="hs-h3">{t('Who’s driving this week')}</h3>
      </div>
      {frame(
        t('Soccer carpool 🚗'),
        t('Mei, Tom, Hale'),
        'M',
        'T',
        <>
          <div className="im-run out">
            <div className="im-b out tail">{t('Can’t do Tuesday pickup this week 😩')}</div>
          </div>
          <div className="im-run group" {...step('0.6')}>
            <div className="im-who">Tom</div>
            <span className="im-pic im-mono">T</span>
            <TypingBubble />
            <div className="im-b in tail">{t('I’ll grab both Tue. You do Thu?')}</div>
          </div>
          <div className="im-run group" {...step('1.6')}>
            <div className="im-who">Hale</div>
            <img className="im-pic" src={logoSrc} alt="" />
            <TypingBubble />
            <div className="im-b in tail">
              {t(
                'Got it. Tom on Tuesday, Mei on Thursday, 5:30 after soccer. I’ll remind whoever’s driving the night before.',
              )}
            </div>
          </div>
        </>,
        <span className="hs-did" {...step('3')}>
          <Check />
          {t('Driving · Tue Tom, Thu Mei')}
        </span>,
      )}
    </div>,
    <div key="swim">
      <div className="hs-chat-cap">
        <span className="n">03</span>
        <h3 className="hs-h3">{t('Same swim class, three families')}</h3>
      </div>
      {frame(
        t('Swim this winter? 🏊'),
        t('Aisha, Jordan, Kate, Hale'),
        'A',
        'J',
        <>
          <div className="im-run group">
            <div className="im-who">Aisha</div>
            <span className="im-pic im-mono">A</span>
            <div className="im-b in tail">{t('Same swim class for all three kids this winter?')}</div>
          </div>
          <div className="im-run group" {...step('0.6')}>
            <div className="im-who">Hale</div>
            <img className="im-pic" src={logoSrc} alt="" />
            <TypingBubble />
            <div className="im-b in tail">
              {t(
                'Saturdays 9:30 at the community pool has room for all three. Sign-ups open Tuesday at 7. I’ll send you each the link the night before.',
              )}
            </div>
          </div>
          <div className="im-run out" {...step('3')}>
            <div className="im-b out tail">{t('Got in! 🙌')}</div>
            <div className="im-status">{t('Delivered')}</div>
          </div>
        </>,
        <span className="hs-did" {...step('2.2')}>
          <Check />
          {t('Reminder set · Mon 7 PM')}
        </span>,
      )}
    </div>,
  ];
}
