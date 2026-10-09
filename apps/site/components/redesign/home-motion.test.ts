import { afterEach, expect, it, vi } from 'vitest';
import { HomeMotion } from './home-motion';

const hooks = vi.hoisted(() => ({
  root: {} as object,
  cleanup: undefined as undefined | (() => void),
  setEnabled: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => () => void) => {
    hooks.cleanup = effect();
  },
  useRef: (value: unknown) => ({ current: value === null ? { closest: () => hooks.root } : value }),
  useState: () => [false, hooks.setEnabled],
}));
afterEach(() => {
  hooks.cleanup?.();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('plays only the centered chat, replays on selection, and respects visibility and reduced motion', () => {
  const animations: ReturnType<typeof makeAnimation>[] = [];
  function makeAnimation() {
    const animation = {
      currentTime: 0,
      playState: 'running',
      pause: vi.fn(() => {
        animation.playState = 'paused';
      }),
      play: vi.fn(() => {
        animation.playState = 'running';
      }),
      cancel: vi.fn(() => {
        animation.playState = 'idle';
      }),
      finish: vi.fn(() => {
        animation.playState = 'finished';
      }),
      onfinish: null as null | ((event?: Event) => void),
    };
    return animation;
  }
  const target = {
    dataset: { motionStep: '1' },
    querySelector: () => null,
    animate: vi.fn(() => {
      const animation = makeAnimation();
      animations.push(animation);
      return animation;
    }),
  };
  const typing = {
    animate: target.animate,
    children: Array.from({ length: 3 }, () => ({ animate: target.animate })),
  };
  const chatTarget = {
    ...target,
    querySelector: (selector: string) =>
      selector === '[data-motion-typing]' ? typing : selector === '.im-b' ? target : null,
  };
  const hero = { querySelectorAll: () => [target], getAttribute: () => 'hero' };
  const beat = { querySelectorAll: () => [target], getAttribute: () => 'beat' };
  let selected = 0;
  let moving = false;
  let selectChat = () => {};
  const gallery = {
    addEventListener: (_: string, listener: () => void) => {
      selectChat = listener;
    },
    removeEventListener: vi.fn(),
  };
  const chats = [0, 1].map((index) => ({
    querySelectorAll: () => [chatTarget],
    getAttribute: () => 'chat',
    closest: (selector: string) => {
      if (selector === '[data-chat-gallery]') return gallery;
      if (selector === '[data-gallery-active="true"]') return selected === index ? gallery : null;
      return moving ? gallery : null;
    },
  }));
  hooks.root = {
    querySelectorAll: () => [hero, beat, ...chats],
    querySelector: (selector: string) => (selector === '[data-chat-gallery]' ? gallery : hero),
  };
  let notify: (entries: object[]) => void = () => {};
  const disconnect = vi.fn();
  class Observer {
    constructor(callback: typeof notify) {
      notify = callback;
    }
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = disconnect;
  }
  let change = () => {};
  const preference = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => {
      change = listener;
    },
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', { IntersectionObserver: Observer });
  vi.stubGlobal('IntersectionObserver', Observer);
  vi.stubGlobal('matchMedia', () => preference);
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) =>
      ({
        '--oct-motion-enter-ms': '400',
        '--oct-motion-step-ms': '1000',
        '--oct-chat-step-ms': '1200',
        '--oct-motion-distance': '8px',
        '--ease-breathe': 'cubic-bezier(0.4, 0, 0.2, 1)',
      })[name],
  }));

  HomeMotion();
  const [heroAnimation, beatAnimation, firstChat] = animations;
  const secondChat = animations[7];
  if (!heroAnimation || !beatAnimation || !firstChat || !secondChat)
    throw new Error('All examples need animations');
  expect(animations.slice(0, 7).every((a) => a.playState === 'paused')).toBe(true);
  expect(animations.slice(7).every((a) => a.playState === 'finished')).toBe(true);
  expect(typing.animate).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ delay: 360, duration: 840, fill: 'both' }),
  );
  expect(target.animate).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ duration: 400, delay: 1000 }),
  );
  notify([{ target: hero, isIntersecting: true, intersectionRatio: 0.25 }]);
  expect(heroAnimation.playState).toBe('paused');
  notify([{ target: hero, isIntersecting: true, intersectionRatio: 0.8 }]);
  expect(animations.slice(0, 2).map((a) => a.playState)).toEqual(['running', 'paused']);
  notify([{ target: hero, isIntersecting: false, intersectionRatio: 0 }]);
  expect(heroAnimation.playState).toBe('paused');
  heroAnimation.playState = 'finished';
  heroAnimation.currentTime = 500;
  const playCount = heroAnimation.play.mock.calls.length;
  vi.useFakeTimers();
  notify([{ target: hero, isIntersecting: true, intersectionRatio: 0.8 }]);
  expect(heroAnimation.play).toHaveBeenCalledTimes(playCount);
  vi.advanceTimersByTime(2999);
  expect(heroAnimation.currentTime).toBe(500);
  vi.advanceTimersByTime(1);
  const fade = animations.at(-1);
  if (!fade?.onfinish) throw new Error('Hero restart should fade out before it replays');
  fade.onfinish(new Event('finish'));
  expect(heroAnimation.currentTime).toBe(0);
  expect(heroAnimation.playState).toBe('running');
  expect(beatAnimation.playState).toBe('paused');
  vi.useRealTimers();

  notify(chats.map((chat) => ({ target: chat, isIntersecting: true, intersectionRatio: 0.8 })));
  expect(firstChat.playState).toBe('running');
  expect(secondChat.playState).toBe('finished');
  moving = true;
  selectChat();
  expect(firstChat.playState).toBe('paused');
  selected = 1;
  secondChat.currentTime = 3400;
  selectChat();
  expect(secondChat.currentTime).toBe(0);
  expect(secondChat.playState).toBe('paused');
  expect(secondChat.play).not.toHaveBeenCalled();
  moving = false;
  selectChat();
  expect(firstChat.playState).toBe('finished');
  expect(secondChat.currentTime).toBe(0);
  expect(secondChat.playState).toBe('running');
  notify([{ target: chats[1], isIntersecting: false, intersectionRatio: 0 }]);
  expect(secondChat.playState).toBe('paused');

  preference.matches = true;
  change();
  expect(animations.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
  expect(heroAnimation.play).toHaveBeenCalledTimes(playCount + 1);
  preference.matches = false;
  change();
  expect(animations).toHaveLength(25);
  expect(disconnect).toHaveBeenCalled();
});

it('plays a desktop chat once at the same threshold, and reduced motion stays on the end state', () => {
  const animations: ReturnType<typeof makeDesk>[] = [];
  function makeDesk() {
    const animation = {
      currentTime: 0,
      playState: 'paused',
      pause: vi.fn(),
      play: vi.fn(() => {
        animation.playState = 'running';
      }),
      cancel: vi.fn(),
      finish: vi.fn(() => {
        animation.playState = 'finished';
      }),
      onfinish: null as null | (() => void),
    };
    return animation;
  }
  const target = {
    dataset: { motionStep: '1' },
    querySelector: () => null,
    animate: vi.fn(() => {
      const animation = makeDesk();
      animations.push(animation);
      return animation;
    }),
  };
  const desk = {
    querySelectorAll: () => [target],
    getAttribute: () => 'chat',
    closest: () => null,
  };
  hooks.root = {
    querySelectorAll: () => [desk],
    querySelector: () => null,
  };
  let notify: (entries: object[]) => void = () => {};
  class Observer {
    constructor(callback: typeof notify) {
      notify = callback;
    }
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  const preference = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', { IntersectionObserver: Observer });
  vi.stubGlobal('IntersectionObserver', Observer);
  vi.stubGlobal('matchMedia', () => preference);
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) =>
      ({
        '--oct-motion-enter-ms': '400',
        '--oct-motion-step-ms': '1000',
        '--oct-chat-step-ms': '1200',
        '--oct-motion-distance': '8px',
        '--ease-breathe': 'cubic-bezier(0.4, 0, 0.2, 1)',
      })[name],
  }));

  HomeMotion();
  const animation = animations[0];
  if (!animation) throw new Error('Desktop chat needs an animation');
  expect(animation.finish).not.toHaveBeenCalled();
  expect(animation.playState).toBe('paused');
  notify([{ target: desk, isIntersecting: true, intersectionRatio: 0.25 }]);
  expect(animation.play).not.toHaveBeenCalled();
  notify([{ target: desk, isIntersecting: true, intersectionRatio: 0.8 }]);
  expect(animation.playState).toBe('running');
  animation.playState = 'finished';
  const plays = animation.play.mock.calls.length;
  notify([{ target: desk, isIntersecting: true, intersectionRatio: 0.8 }]);
  expect(animation.play).toHaveBeenCalledTimes(plays);

  preference.matches = true;
  const change = preference.addEventListener.mock.calls[1]?.[1] as (() => void) | undefined;
  change?.();
  expect(target.animate).toHaveBeenCalledTimes(1);
  expect(animation.cancel).toHaveBeenCalled();
});

it('plays a year card once on the gallery clock, pauses off-screen, and keeps the end frame', () => {
  const animations: ReturnType<typeof makeClip>[] = [];
  function makeClip() {
    const animation = {
      currentTime: 0,
      playState: 'paused',
      pause: vi.fn(() => {
        animation.playState = 'paused';
      }),
      play: vi.fn(() => {
        animation.playState = 'running';
      }),
      cancel: vi.fn(),
      finish: vi.fn(() => {
        animation.playState = 'finished';
      }),
      onfinish: null as null | (() => void),
    };
    return animation;
  }
  const animate = vi.fn(() => {
    const animation = makeClip();
    animations.push(animation);
    return animation;
  });
  const typing = { animate, children: Array.from({ length: 3 }, () => ({ animate })) };
  const bubble = { animate };
  const hale = {
    dataset: { motionStep: '0.4' },
    querySelector: (selector: string) =>
      selector === '.im-b' ? bubble : selector === '[data-motion-typing]' ? typing : null,
    animate,
  };
  const event = {
    dataset: { motionStep: '1.4' },
    querySelector: () => null,
    animate,
  };
  const card = {
    querySelectorAll: () => [hale, event],
    getAttribute: () => 'chat',
    closest: () => null,
  };
  hooks.root = {
    querySelectorAll: () => [card],
    querySelector: () => null,
  };
  let notify: (entries: object[]) => void = () => {};
  class Observer {
    constructor(callback: typeof notify) {
      notify = callback;
    }
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  let change = () => {};
  const preference = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => {
      change = listener;
    },
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', { IntersectionObserver: Observer });
  vi.stubGlobal('IntersectionObserver', Observer);
  vi.stubGlobal('matchMedia', () => preference);
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) =>
      ({
        '--oct-motion-enter-ms': '400',
        '--oct-motion-step-ms': '1000',
        '--oct-chat-step-ms': '1200',
        '--oct-motion-distance': '8px',
        '--ease-breathe': 'cubic-bezier(0.4, 0, 0.2, 1)',
      })[name],
  }));

  HomeMotion();
  expect(animations.every((clip) => clip.playState === 'paused')).toBe(true);
  expect(animations.some((clip) => clip.finish.mock.calls.length > 0)).toBe(false);
  expect(bubble.animate).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ duration: 400, delay: 480 }),
  );
  expect(event.animate).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ duration: 400, delay: 1680 }),
  );
  expect(typing.animate).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ delay: 0, duration: 480, fill: 'both' }),
  );

  notify([{ target: card, isIntersecting: true, intersectionRatio: 0.25 }]);
  expect(animations[0]?.play).not.toHaveBeenCalled();
  notify([{ target: card, isIntersecting: true, intersectionRatio: 0.8 }]);
  expect(animations.every((clip) => clip.playState === 'running')).toBe(true);
  notify([{ target: card, isIntersecting: false, intersectionRatio: 0 }]);
  expect(animations.every((clip) => clip.playState === 'paused')).toBe(true);
  notify([{ target: card, isIntersecting: true, intersectionRatio: 0.8 }]);
  expect(animations.every((clip) => clip.playState === 'running')).toBe(true);
  for (const clip of animations) clip.playState = 'finished';
  const plays = animations[0]?.play.mock.calls.length ?? 0;
  notify([{ target: card, isIntersecting: true, intersectionRatio: 0.8 }]);
  expect(animations[0]?.play).toHaveBeenCalledTimes(plays);

  const created = animate.mock.calls.length;
  preference.matches = true;
  change();
  expect(animate).toHaveBeenCalledTimes(created);
  expect(animations.every((clip) => clip.cancel.mock.calls.length === 1)).toBe(true);
});
