import { expect, it } from 'vitest';
import { swipePassesCommit, updateGalleryFocus } from './chat-gallery';

it('blends outgoing and incoming cards during travel, using untransformed snap geometry', () => {
  const cards = [0, 1, 2].map((index) => ({
    offsetLeft: 390 + index * 484,
    offsetWidth: 420,
    style: { opacity: '', transform: '' },
  }));
  const node = { children: cards, clientWidth: 1200, scrollLeft: 242 };
  const [first, second] = cards;
  if (!first || !second) throw new Error('Gallery needs neighboring cards');
  const paint = () => updateGalleryFocus(node as unknown as HTMLDivElement, 48);
  paint();
  expect(cards.map((card) => card.style.opacity)).toEqual(['0.625', '0.625', '0.25']);
  expect(first.style.transform).toBe('translate3d(0, 24px, 0) scale(0.9)');
  expect(second.style.transform).toBe(first.style.transform);
  node.scrollLeft = 484;
  expect(paint()).toEqual({ nearest: 1, distance: 0 });
  expect(cards.map((card) => card.style.opacity)).toEqual(['0.25', '1', '0.25']);
  expect(second.style.transform).toBe('translate3d(0, 0px, 0) scale(1)');
});

it('does not advance a 50px swipe, and does once the swipe passes 30% or the snap midpoint', () => {
  const cardWidth = 342;
  const stride = 390;
  expect(swipePassesCommit(50, cardWidth, stride)).toBe(false);
  expect(swipePassesCommit(cardWidth * 0.3, cardWidth, stride)).toBe(false);
  expect(swipePassesCommit(cardWidth * 0.3 + 1, cardWidth, stride)).toBe(true);
  expect(swipePassesCommit(40, 400, 80)).toBe(false);
  expect(swipePassesCommit(41, 400, 80)).toBe(true);
});
