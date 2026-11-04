import { useEffect, useState } from 'react';

/** The views worth linking to. Only a plain #name passes through an artifact link. */
export const VIEWS = [
  { id: 'walks', label: 'Overview' },
  { id: 'capture', label: 'Capture' },
  { id: 'review', label: 'Review' },
  { id: 'compare', label: 'Comparison' },
  { id: 'reconcile', label: 'Reconciliation' },
  { id: 'report', label: 'Report' },
] as const;

/** Views reached from menus and buttons rather than the main bar. ("settings" is reserved by claude.ai, hence "site".) */
const OTHER_VIEWS = ['verify', 'site', 'cameras', 'guided'] as const;

export type ViewId = (typeof VIEWS)[number]['id'] | (typeof OTHER_VIEWS)[number];

const IDS = new Set<string>([...VIEWS.map((v) => v.id), ...OTHER_VIEWS]);

function read(): ViewId {
  const h = window.location.hash.replace(/^#/, '');
  return (IDS.has(h) ? h : 'walks') as ViewId;
}

export function go(view: ViewId): void {
  if (read() === view) return;
  window.location.hash = view;
}

export function useView(): ViewId {
  const [view, setView] = useState<ViewId>(read);
  useEffect(() => {
    const on = (): void => {
      setView(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return view;
}
