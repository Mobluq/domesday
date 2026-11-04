import { RoomWalkStatus, WalkStatus } from '@domesday/domain';
import type { ReactElement } from 'react';

export function WalksPage(): ReactElement {
  return (
    <section aria-labelledby="walks-title">
      <h1 id="walks-title">Walks</h1>
      <p>Placeholder. Each walk is one site, filmed room by room on a phone.</p>
      <h2>Walk status</h2>
      <ul>
        {WalkStatus.values.map((code) => (
          <li key={code}>{WalkStatus.label(code)}</li>
        ))}
      </ul>
      <h2>Room status</h2>
      <ul>
        {RoomWalkStatus.values.map((code) => (
          <li key={code}>{RoomWalkStatus.label(code)}</li>
        ))}
      </ul>
    </section>
  );
}
