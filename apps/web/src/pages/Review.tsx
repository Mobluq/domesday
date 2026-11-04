import { ConfidenceBand, REVIEW_ORDER, ReviewDecisionKind } from '@domesday/domain';
import type { ReactElement } from 'react';

export function ReviewPage(): ReactElement {
  return (
    <section aria-labelledby="review-title">
      <h1 id="review-title">Review</h1>
      <p>Placeholder. Proposed lines are reviewed lowest confidence first; only high-confidence lines can be approved in bulk.</p>
      <h2>Queue order</h2>
      <ol>
        {REVIEW_ORDER.map((band) => (
          <li key={band}>{ConfidenceBand.label(band)}</li>
        ))}
      </ol>
      <h2>Decisions</h2>
      <ul>
        {ReviewDecisionKind.values.map((code) => (
          <li key={code}>{ReviewDecisionKind.label(code)}</li>
        ))}
      </ul>
    </section>
  );
}
