import { defineTool } from '@hale/agent';
import { z } from 'zod';
import type { RegistrationWatchContext, RegistrationWindowContext } from './registration-context';

export const READ_REGISTRATION_PAGE = 'read_registration_page';

export function readRegistrationPageTool(args: {
  watches: readonly RegistrationWatchContext[];
  read: (watchId: string) => Promise<RegistrationWindowContext | null>;
  onRead: (reading: RegistrationWindowContext) => void;
}) {
  const reads = new Map<string, Promise<RegistrationWindowContext | null>>();
  return defineTool({
    name: READ_REGISTRATION_PAGE,
    description:
      "Read and parse the official page for one of this family's registrationWatches RIGHT NOW. Use its exact id as watchId. Call before answering any registration date/time question, including follow-ups and enrollment questions, even if an earlier message gave a date. Returns verified dates, source timezone, URL and reminder status, or an explicit verification failure. It refreshes existing watch state but does not create or approve a reminder. Do not call for unrelated conversation.",
    monetary: false,
    touchesChildContent: false,
    inputSchema: z.object({ watchId: z.string().uuid() }),
    handler: async ({ watchId }) => {
      if (!args.watches.some((watch) => watch.id === watchId)) {
        throw new Error(
          "Choose an id from this family's registrationWatches. No other watch or URL may be read.",
        );
      }
      let pending = reads.get(watchId);
      if (!pending) {
        pending = args.read(watchId);
        reads.set(watchId, pending);
      }
      const reading = await pending;
      if (!reading)
        throw new Error('This watch is no longer active. Do not reuse an earlier date.');
      args.onRead(reading);
      return { registrationWindows: [reading] };
    },
  });
}
