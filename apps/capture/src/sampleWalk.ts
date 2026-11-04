import { createWalk, type PhoneWalk } from '@domesday/capture-core';

/** Placeholder room list until the app loads the site's rooms from the API. */
export function sampleWalk(): PhoneWalk {
  return createWalk({
    walkId: '00000000-0000-4000-8000-000000000001',
    siteId: '00000000-0000-4000-8000-000000000002',
    rooms: [
      { roomId: '00000000-0000-4000-8000-0000000000a1', name: 'Room 1' },
      { roomId: '00000000-0000-4000-8000-0000000000a2', name: 'Room 2' },
      { roomId: '00000000-0000-4000-8000-0000000000a3', name: 'Room 3' },
    ],
  });
}
