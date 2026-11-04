import type { ReactElement } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router';
import { NAV_ITEMS, type NavPath } from './navigation';
import { ComparisonPage } from './pages/Comparison';
import { ReconciliationPage } from './pages/Reconciliation';
import { ReportsPage } from './pages/Reports';
import { ReviewPage } from './pages/Review';
import { WalksPage } from './pages/Walks';

const PAGES: Record<NavPath, () => ReactElement> = {
  '/walks': WalksPage,
  '/review': ReviewPage,
  '/comparison': ComparisonPage,
  '/reconciliation': ReconciliationPage,
  '/reports': ReportsPage,
};

export function App(): ReactElement {
  return (
    <>
      <nav aria-label="Main">
        <ul>
          {NAV_ITEMS.map((item) => (
            <li key={item.path}>
              <NavLink to={item.path}>{item.label}</NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/walks" replace />} />
          {NAV_ITEMS.map((item) => {
            const Page = PAGES[item.path];
            return <Route key={item.path} path={item.path} element={<Page />} />;
          })}
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
