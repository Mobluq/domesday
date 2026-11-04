import { useState, type ReactElement } from 'react';
import { DataProvider, PersonaProvider, ToastProvider, useData, usePersona, useToast } from './data/store';
import { seedStore } from './data/actions';
import { CapturePage } from './pages/Capture';
import { ComparisonPage } from './pages/Comparison';
import { ReconciliationPage } from './pages/Reconciliation';
import { ReportPage } from './pages/Report';
import { ReviewPage } from './pages/Review';
import { VerifyPage } from './pages/Verify';
import { WalksPage } from './pages/Walks';
import { go, useView, VIEWS, type ViewId } from './route';
import { Btn, Note } from './ui/bits';
import { Hallmark, Wordmark } from './ui/brand';
import { Icon } from './ui/icons';

function Loading(): ReactElement {
  return (
    <div className="boot" role="status">
      <Hallmark size={40} />
      <span className="ui-body-s">Opening Domesday…</span>
    </div>
  );
}

function PersonaMenu(): ReactElement | null {
  const { site } = useData();
  const { person, setPersonId } = usePersona();
  const [open, setOpen] = useState(false);
  if (!site) return null;
  return (
    <div className="persona">
      <button type="button" className="persona__button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">
          {person?.initials ?? '?'}
        </span>
        <span className="persona__who">
          <span className="persona__name">{person?.name ?? 'Choose who you are'}</span>
          <span className="persona__role">{person?.roleLabel ?? 'Demo role'}</span>
        </span>
        <Icon name="down" size={16} />
      </button>
      {open ? (
        <div className="persona__menu" role="menu">
          <span className="ui-label">USE THIS DEVICE AS</span>
          {site.people.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === person?.id}
              className="persona__item"
              onClick={() => {
                setPersonId(p.id);
                setOpen(false);
              }}
            >
              <span className="avatar" aria-hidden="true">
                {p.initials}
              </span>
              <span className="persona__who">
                <span className="persona__name">{p.name}</span>
                <span className="persona__role">
                  {p.roleLabel} · {p.duty.toLowerCase()}
                </span>
              </span>
              {p.id === person?.id ? <Icon name="found" size={18} /> : null}
            </button>
          ))}
          <p className="ui-body-s" style={{ margin: 0, color: 'var(--text-secondary)' }}>
            Demo roles. Each device remembers its own, so your phone can film as Tolu while your laptop reviews as Chinedu.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function TopBar({ view }: { view: ViewId }): ReactElement {
  const { site, current } = useData();
  const toReview = current ? current.lines.filter((l) => l.status === 'proposed').length : 0;
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <a href="#walks" className="brand" aria-label="Domesday, walks">
          <Hallmark size={26} />
          <span className="brand__word">
            <Wordmark height={19} />
          </span>
        </a>
        <nav aria-label="Main" className="mainnav">
          {VIEWS.map((v) => (
            <a key={v.id} href={`#${v.id}`} className="mainnav__link" aria-current={view === v.id ? 'page' : undefined}>
              {v.label}
              {v.id === 'review' && toReview > 0 ? <span className="mainnav__count">{toReview}</span> : null}
            </a>
          ))}
        </nav>
        <div className="topbar__end">
          {site ? <span className="topbar__site ui-body-s">{site.name}</span> : null}
          <PersonaMenu />
        </div>
      </div>
    </header>
  );
}

function SetUp(): ReactElement {
  const { rt } = useData();
  const { say } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <main className="page page--narrow">
      <div className="stack-l" style={{ paddingBlock: '48px' }}>
        <Hallmark size={48} />
        <h1 className="display-m" style={{ margin: 0 }}>
          This copy of Domesday has no site yet
        </h1>
        <p className="ui-body" style={{ margin: 0, color: 'var(--text-secondary)' }}>
          Load the demo site: Ikeja branch, seven rooms, its fixed asset register, and an approved walk from 3 October to compare against.
          Everyone who opens this page will see the same data.
        </p>
        <div>
          <Btn
            variant="primary"
            icon="walk"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await seedStore(rt);
                say('Demo site loaded');
              } catch (e) {
                say(`Couldn't load the demo site: ${String((e as Error).message ?? e)}`, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Loading…' : 'Load the demo site'}
          </Btn>
        </div>
      </div>
    </main>
  );
}

function Toasts(): ReactElement {
  const { toasts } = useToast();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <Icon name={t.tone === 'ok' ? 'found' : 'unsafe'} size={18} />
          {t.text}
        </div>
      ))}
    </div>
  );
}

function Shell(): ReactElement {
  const view = useView();
  const { site, loaded, rt } = useData();
  let page: ReactElement;
  if (!loaded) page = <Loading />;
  else if (!site) page = <SetUp />;
  else {
    switch (view) {
      case 'capture':
        page = <CapturePage />;
        break;
      case 'review':
        page = <ReviewPage />;
        break;
      case 'compare':
        page = <ComparisonPage />;
        break;
      case 'reconcile':
        page = <ReconciliationPage />;
        break;
      case 'report':
        page = <ReportPage />;
        break;
      case 'verify':
        page = <VerifyPage />;
        break;
      default:
        page = <WalksPage />;
    }
  }
  return (
    <div className="app">
      <TopBar view={view} />
      {!rt.shared && loaded ? (
        <div className="page" style={{ paddingBlock: '12px 0' }}>
          <Note tone="warn" icon="info">
            Shared storage isn't available in this view, so what you do here stays on this device.
            {rt.seededLocally ? ' The demo site was loaded locally.' : ''}
          </Note>
        </div>
      ) : null}
      {page}
      <Toasts />
    </div>
  );
}

export function App(): ReactElement {
  return (
    <DataProvider fallback={<Loading />}>
      <PersonaProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </PersonaProvider>
    </DataProvider>
  );
}

export { go };
