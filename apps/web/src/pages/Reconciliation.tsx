import { CorrectionKind, ReconStatus } from '@domesday/domain';
import type { ReactElement } from 'react';

export function ReconciliationPage(): ReactElement {
  return (
    <section aria-labelledby="reconciliation-title">
      <h1 id="reconciliation-title">Reconciliation</h1>
      <p>Placeholder. Approved lines matched to the imported register, with the book value of lines not seen.</p>
      <h2>Match status</h2>
      <ul>
        {ReconStatus.values.map((code) => (
          <li key={code}>{ReconStatus.label(code)}</li>
        ))}
      </ul>
      <h2>Corrections file</h2>
      <ul>
        {CorrectionKind.values.map((code) => (
          <li key={code}>{CorrectionKind.label(code)}</li>
        ))}
      </ul>
    </section>
  );
}
