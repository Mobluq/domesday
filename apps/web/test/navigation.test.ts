import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../src/navigation';

describe('web app navigation', () => {
  it('has the five areas: walks, review, comparison, reconciliation and reports', () => {
    expect(NAV_ITEMS.map((i) => i.path)).toEqual(['/walks', '/review', '/comparison', '/reconciliation', '/reports']);
  });
});
