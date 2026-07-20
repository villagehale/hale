import { version } from '../package.json';

/** The web app's real version, read from package.json so the Settings → Support &
 * about row shows a true build number (never a hardcoded/fabricated one — rule #1). */
export const APP_VERSION: string = version;
