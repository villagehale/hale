'use client';

import { Component, type ReactNode } from 'react';

/**
 * Per-panel error boundary: one dead query never blanks the page. It wraps a
 * panel's BODY only, so the panel frame and its external console link survive
 * every failure (the panel-state law).
 */
export class PanelBoundary extends Component<
  { children: ReactNode; label: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className="adm-state adm-state-fail">{this.props.label} didn’t load — check the logs.</p>
      );
    }
    return this.props.children;
  }
}
