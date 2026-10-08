import type { ReactNode } from 'react';
import type { Locale } from '~/i18n/routing';
import { logoSrc } from './assets';
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
  const wrap = (card: ReactNode) => (framed ? <PhoneChat>{card}</PhoneChat> : card);
  const stamp = () => (
    <div className="hs-stamp">
      iMessage
      <br />
      <b>{t('Today')}</b> 9:41
    </div>
  );

  return [
    <div key="party">
      <div className="hs-chat-cap">
        <span className="n">01</span>
        <h3 className="hs-h3">{t('A joint birthday party')}</h3>
      </div>
      {wrap(
        <article className="hs-card hs-chat">
          <div className="hs-chat-head">
            <div className="hs-avs">
              <span className="hs-av">D</span>
              <img className="hs-av hale" src={logoSrc} alt="" />
              <span className="hs-av">M</span>
            </div>
            <div>
              <div className="hs-chat-name">{t('Room 4 parents 🍎')}</div>
              <div className="hs-chat-members">{t('Dana, Marco + 7 more')}</div>
            </div>
          </div>
          <div className="hs-thread" data-motion-scene="chat">
            {stamp()}
            <div className="hs-who">Dana</div>
            <div className="hs-row">
              <span className="hs-pic mono show">D</span>
              <div className="hs-msg in">{t('Joint party for Leo and Aria? Somewhere indoor 🎈')}</div>
            </div>
            <div className="hs-who" {...step('0.6')}>
              Hale
            </div>
            <div className="hs-row" {...step('0.6')}>
              <img className="hs-pic show" src={logoSrc} alt="" />
              <TypingBubble />
              <div className="hs-msg in">
                {t(
                  'Two nearby take Saturday groups of 8: the climbing gym (ages 3–7) or the clay café (ages 4+). Want me to track RSVPs?',
                )}
              </div>
            </div>
            <div className="hs-who" {...step('2.2')}>
              Dana
            </div>
            <div className="hs-row" {...step('2.2')}>
              <span className="hs-pic mono show">D</span>
              <TypingBubble />
              <div className="hs-msg in">{t('Climbing gym! Booked Sat the 14th at 2')}</div>
            </div>
            <span className="hs-did" {...step('3')}>
              <Check />
              {t('6 yes, 2 to go · on everyone’s calendar')}
            </span>
          </div>
        </article>,
      )}
    </div>,
    <div key="carpool">
      <div className="hs-chat-cap">
        <span className="n">02</span>
        <h3 className="hs-h3">{t('Who’s driving this week')}</h3>
      </div>
      {wrap(
        <article className="hs-card hs-chat">
          <div className="hs-chat-head">
            <div className="hs-avs">
              <span className="hs-av">M</span>
              <img className="hs-av hale" src={logoSrc} alt="" />
              <span className="hs-av">T</span>
            </div>
            <div>
              <div className="hs-chat-name">{t('Soccer carpool 🚗')}</div>
              <div className="hs-chat-members">{t('Mei, Tom, Hale')}</div>
            </div>
          </div>
          <div className="hs-thread" data-motion-scene="chat">
            {stamp()}
            <div className="hs-msg out">{t('Can’t do Tuesday pickup this week 😩')}</div>
            <div className="hs-who" {...step('0.6')}>
              Tom
            </div>
            <div className="hs-row" {...step('0.6')}>
              <span className="hs-pic mono show">T</span>
              <TypingBubble />
              <div className="hs-msg in">{t('I’ll grab both Tue. You do Thu?')}</div>
            </div>
            <div className="hs-who" {...step('1.6')}>
              Hale
            </div>
            <div className="hs-row" {...step('1.6')}>
              <img className="hs-pic show" src={logoSrc} alt="" />
              <TypingBubble />
              <div className="hs-msg in">
                {t(
                  'Got it. Tom on Tuesday, Mei on Thursday, 5:30 after soccer. I’ll remind whoever’s driving the night before.',
                )}
              </div>
            </div>
            <span className="hs-did" {...step('3')}>
              <Check />
              {t('Driving · Tue Tom, Thu Mei')}
            </span>
          </div>
        </article>,
      )}
    </div>,
    <div key="swim">
      <div className="hs-chat-cap">
        <span className="n">03</span>
        <h3 className="hs-h3">{t('Same swim class, three families')}</h3>
      </div>
      {wrap(
        <article className="hs-card hs-chat">
          <div className="hs-chat-head">
            <div className="hs-avs">
              <span className="hs-av">A</span>
              <img className="hs-av hale" src={logoSrc} alt="" />
              <span className="hs-av">J</span>
            </div>
            <div>
              <div className="hs-chat-name">{t('Swim this winter? 🏊')}</div>
              <div className="hs-chat-members">{t('Aisha, Jordan, Kate, Hale')}</div>
            </div>
          </div>
          <div className="hs-thread" data-motion-scene="chat">
            {stamp()}
            <div className="hs-who">Aisha</div>
            <div className="hs-row">
              <span className="hs-pic mono show">A</span>
              <div className="hs-msg in">{t('Same swim class for all three kids this winter?')}</div>
            </div>
            <div className="hs-who" {...step('0.6')}>
              Hale
            </div>
            <div className="hs-row" {...step('0.6')}>
              <img className="hs-pic show" src={logoSrc} alt="" />
              <TypingBubble />
              <div className="hs-msg in">
                {t(
                  'Saturdays 9:30 at the community pool has room for all three. Sign-ups open Tuesday at 7. I’ll send you each the link the night before.',
                )}
              </div>
            </div>
            <span className="hs-did" {...step('2.2')}>
              <Check />
              {t('Reminder set · Mon 7 PM')}
            </span>
            <div className="hs-msg out" {...step('3')}>
              {t('Got in! 🙌')}
            </div>
          </div>
        </article>,
      )}
    </div>,
  ];
}
