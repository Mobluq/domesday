/** The five areas of the web app, in the order they appear. */
export const NAV_ITEMS = [
  { path: '/walks', label: 'Walks' },
  { path: '/review', label: 'Review' },
  { path: '/comparison', label: 'Comparison' },
  { path: '/reconciliation', label: 'Reconciliation' },
  { path: '/reports', label: 'Reports' },
] as const;

export type NavPath = (typeof NAV_ITEMS)[number]['path'];
