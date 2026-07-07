import { TurtleLoader } from '~/components/hale/turtle-loader';

/**
 * The authed group's route-transition boundary. Every page here is
 * force-dynamic with DB reads, so navigation has a real wait — this turns the
 * previously blank gap into the same branded breathing-turtle moment the
 * mobile app opens with.
 */
export default function AuthedLoading() {
  return (
    <div className="main-stage flex min-h-[60dvh] items-center justify-center">
      <TurtleLoader label="just a moment…" />
    </div>
  );
}
