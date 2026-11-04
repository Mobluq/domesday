import { CHANGE_DISPLAY_ORDER, ChangeStatus } from '@domesday/domain';
import type { ReactElement } from 'react';

export function ComparisonPage(): ReactElement {
  return (
    <section aria-labelledby="comparison-title">
      <h1 id="comparison-title">Comparison</h1>
      <p>Placeholder. Changes since the previous approved walk come first; unchanged assets collapse into one count.</p>
      <h2>Change status</h2>
      <ul>
        {CHANGE_DISPLAY_ORDER.map((code) => (
          <li key={code}>{ChangeStatus.label(code)}</li>
        ))}
      </ul>
    </section>
  );
}
