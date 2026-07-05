import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionApprovalCard } from './action-approval-card';

/**
 * Slice 2 — the inline approval gate. Once a chip drafts an action, the card lets
 * the parent approve or reject WITHOUT leaving the chat. It reuses the shipping
 * ApproveButton (→ /api/actions/:id/approve) and DismissButton (→ /decline), so its
 * own contract is: render the already-safe intent label (rule #1: label only, never
 * the payload), wire both buttons to THIS action's id, and keep the copy honest —
 * "approved" (queued), never "done"/"logged"/"scheduled".
 */

const ACTION_ID = '22222222-2222-4222-8222-222222222222';

describe('ActionApprovalCard — inline approve/reject gate', () => {
  it('renders the safe intent label as the proposal summary', () => {
    const html = renderToStaticMarkup(
      createElement(ActionApprovalCard, {
        actionId: ACTION_ID,
        label: 'help me book this',
        actionType: 'create_calendar_event',
      }),
    );
    expect(html).toContain('help me book this');
  });

  it('shows the human action-type label so the parent knows what they are approving', () => {
    const html = renderToStaticMarkup(
      createElement(ActionApprovalCard, {
        actionId: ACTION_ID,
        label: 'help me book this',
        actionType: 'create_calendar_event',
      }),
    );
    expect(html).toContain('Add to calendar');
  });

  it('wires the approve control to THIS action via a per-action accessible name', () => {
    const html = renderToStaticMarkup(
      createElement(ActionApprovalCard, {
        actionId: ACTION_ID,
        label: 'help me book this',
        actionType: 'create_calendar_event',
      }),
    );
    expect(html).toContain('aria-label="approve &amp; send: help me book this"');
  });

  it('offers a reject control (dismiss draft) alongside approve', () => {
    const html = renderToStaticMarkup(
      createElement(ActionApprovalCard, {
        actionId: ACTION_ID,
        label: 'help me book this',
        actionType: 'create_calendar_event',
      }),
    );
    expect(html).toContain('approve &amp; send');
    expect(html).toContain('dismiss draft');
  });

  it('never claims the action already happened (honest: no "done"/"logged"/"scheduled")', () => {
    const html = renderToStaticMarkup(
      createElement(ActionApprovalCard, {
        actionId: ACTION_ID,
        label: 'help me book this',
        actionType: 'create_calendar_event',
      }),
    ).toLowerCase();
    expect(html).not.toContain('done');
    expect(html).not.toContain('logged');
    expect(html).not.toContain('scheduled');
  });
});
