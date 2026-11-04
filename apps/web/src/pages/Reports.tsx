import { ReportType, UI_COPY } from '@domesday/domain';
import type { ReactElement } from 'react';

export function ReportsPage(): ReactElement {
  return (
    <section aria-labelledby="reports-title">
      <h1 id="reports-title">Reports</h1>
      <p>Placeholder. {UI_COPY.reportCoverMethod}</p>
      <h2>Report types</h2>
      <ul>
        {ReportType.values.map((code) => (
          <li key={code}>{ReportType.label(code)}</li>
        ))}
      </ul>
      <p>{UI_COPY.evidenceBy}</p>
    </section>
  );
}
