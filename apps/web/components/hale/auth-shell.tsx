import type { PropsWithChildren } from 'react';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import stage from '~/components/hale/connect/connect.module.css';
import door from '~/components/portal/signin.module.css';

/**
 * Auth door for the pages that still collect an email or a password.
 *
 * Same frame as the phone /sign-in: ConnectStage (shore, wordmark, the
 * approved footer) and the glass card. This page's own heading and form sit
 * in the card. No second set of sentences, and no theme logic — light, dark,
 * and auto come from the root `hale-theme` script.
 */
export function AuthShell({
  heading,
  subtitle,
  children,
}: PropsWithChildren<{ heading: string; subtitle?: string }>) {
  return (
    <ConnectStage>
      <section className={`${stage.card} ${stage.door}`}>
        <div className={stage.act}>
          <div className={door.stack}>
            <h1 className={stage.h1}>{heading}</h1>
            {subtitle ? <p className={stage.lede}>{subtitle}</p> : null}
            {children}
          </div>
        </div>
      </section>
    </ConnectStage>
  );
}
