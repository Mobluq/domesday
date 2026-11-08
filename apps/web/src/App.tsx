import { useEffect, useState, type ReactElement } from 'react';
import { DataProvider, PersonaProvider, ToastProvider, useData, usePersona, useToast } from './data/store';
import { seedStore } from './data/actions';
import { walkProgress } from './data/derive';
import { defaultCategories } from './data/setup';
import type { Category } from './data/types';
import { saveAccessCode } from './runtime/runtime';
import { CamerasPage } from './pages/Cameras';
import { CapturePage } from './pages/Capture';
import { ComparisonPage } from './pages/Comparison';
import { GuidedCapture } from './pages/Guided';
import { ReconciliationPage } from './pages/Reconciliation';
import { ReportPage } from './pages/Report';
import { ReviewPage } from './pages/Review';
import { SetupWizard, SitePage } from './pages/Site';
import { VerifyPage } from './pages/Verify';
import { WalksPage } from './pages/Walks';
import { go, useView, VIEWS, type ViewId } from './route';
import { Note } from './ui/bits';
import { Hallmark, Wordmark } from './ui/brand';
import { Gate } from './ui/gate';
import { Icon } from './ui/icons';
import { AskDomesday, openAsk } from './ui/ask';
import { markTourSeen, Tour, tourSeen } from './ui/tour';

const TOUR_EVENT = 'domesday:tour';

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
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent): void => {
      if (!(e.target as Element).closest?.('.persona')) setOpen(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!site) return null;
  const link = (href: string, icon: Parameters<typeof Icon>[0]['name'], label: string): ReactElement => (
    <a href={href} className="persona__link" role="menuitem" onClick={() => setOpen(false)}>
      <Icon name={icon} size={18} />
      {label}
    </a>
  );
  return (
    <div className="persona">
      <button type="button" className="persona__button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">
          {person?.initials ?? '?'}
        </span>
        <span className="persona__who">
          <span className="persona__name">{person?.name ?? 'Choose who you are'}</span>
          <span className="persona__role">{person?.roleLabel ?? (site.demo ? 'Demo role' : 'Pick your name')}</span>
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
            {site.demo
              ? 'Demo roles. Each device remembers its own, so your phone can film as Tolu while your laptop reviews as Chinedu.'
              : 'Each device remembers who is using it, so a phone can film while a laptop reviews.'}
          </p>
          <div className="persona__links">
            {link('#guided', 'phone', 'Guided capture')}
            {link('#cameras', 'camera', 'Cameras')}
            {link('#site', 'room', 'Site setup')}
            <button
              type="button"
              className="persona__link"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new Event(TOUR_EVENT));
              }}
            >
              <Icon name="info" size={18} />
              Show me around
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TopBar({ view }: { view: ViewId }): ReactElement {
  const { site, current } = useData();
  const toReview = current ? current.lines.filter((l) => l.status === 'proposed').length : 0;
  const progress = site && current ? walkProgress(site, current) : null;
  const done: Partial<Record<ViewId, boolean>> = {
    capture: Boolean(progress && progress.total > 0 && progress.filmed + progress.skipped === progress.total),
    review: current?.walk.status === 'approved',
  };
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
          {VIEWS.map((v, i) => (
            <a key={v.id} href={`#${v.id}`} className="mainnav__link" aria-current={view === v.id ? 'page' : undefined} data-done={done[v.id] || undefined}>
              {i > 0 ? (
                <span className="mainnav__n" aria-hidden="true">
                  {done[v.id] ? <Icon name="found" size={12} /> : i}
                </span>
              ) : null}
              {v.label}
              {v.id === 'review' && toReview > 0 ? <span className="mainnav__count">{toReview}</span> : null}
            </a>
          ))}
        </nav>
        <div className="topbar__end">
          {site ? (
            <button type="button" className="topbar__ask" onClick={() => openAsk()} aria-label="Ask about the inventory" title="Ask Domesday AI (Ctrl K)">
              Ask<span className="topbar__ask-more">Domesday AI</span>
              <kbd className="dms-kbd">Ctrl K</kbd>
            </button>
          ) : null}
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
  const [wizard, setWizard] = useState(false);
  const [categories, setCategories] = useState<Category[] | null>(null);
  useEffect(() => {
    void defaultCategories()
      .then(setCategories)
      .catch(() => setCategories([{ id: 'other', name: 'Other asset', plural: 'other assets' }]));
  }, []);
  if (wizard && categories)
    return (
      <>
        <header className="topbar">
          <div className="topbar__inner">
            <span className="brand">
              <Hallmark size={26} />
              <span className="brand__word">
                <Wordmark height={19} />
              </span>
            </span>
          </div>
        </header>
        <SetupWizard categories={categories} onCancel={() => setWizard(false)} />
      </>
    );
  return (
    <Gate>
      <div className="gate__form">
        <div className="stack-s">
          <h1 className="gate__heading">How would you like to start?</h1>
          <p className="ui-body muted">You can try everything on a demo site first, or set up your own in about five minutes.</p>
        </div>
        <div className="setup-choices">
          <button
            type="button"
            className="choice choice--primary"
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
            <span className="choice__icon">
              <Icon name="play" />
            </span>
            <span className="stack-xs">
              <span className="ui-body-strong">{busy ? 'Loading…' : 'Try the demo site'}</span>
              <span className="ui-body-s muted">Ikeja branch: seven rooms, its register, and a walk from 3 October to compare against.</span>
            </span>
            <Icon name="next" />
          </button>
          <button type="button" className="choice" disabled={!categories} onClick={() => setWizard(true)}>
            <span className="choice__icon">
              <Icon name="room" />
            </span>
            <span className="stack-xs">
              <span className="ui-body-strong">Set up your own site</span>
              <span className="ui-body-s muted">Name it, add rooms and people, and bring in your register.</span>
            </span>
            <Icon name="next" />
          </button>
        </div>
        <p className="gate__help">
          {rt.shared ? 'Everyone who opens this copy of Domesday sees the same site.' : "This view can't share storage, so what you set up here stays on this device."}
        </p>
      </div>
    </Gate>
  );
}

const CODE_TRIED = 'domesday.codeTried';

/** The website asks for its access code once per browser; the code then rides on every request. */
function AccessCode(): ReactElement {
  const [code, setCode] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const tried = (() => {
    try {
      return sessionStorage.getItem(CODE_TRIED) === '1';
    } catch {
      return false;
    }
  })();
  return (
    <Gate>
      <form
        className="gate__form"
        data-shake={tried || undefined}
        onSubmit={(e) => {
          e.preventDefault();
          if (!code.trim()) return;
          setBusy(true);
          saveAccessCode(code);
          try {
            sessionStorage.setItem(CODE_TRIED, '1');
          } catch {
            // fine
          }
          window.location.reload();
        }}
      >
        <div className="stack-s">
          <h1 className="gate__heading">Enter the access code</h1>
          <p className="ui-body muted">Whoever shared this link with you has the code. You only need it once on this device.</p>
        </div>
        {tried ? (
          <Note tone="warn" icon="info">
            That code didn't work. Check it with whoever shared Domesday with you, then try again.
          </Note>
        ) : null}
        <label className="field">
          <span>Access code</span>
          <span className="pw">
            <input
              id="access-code"
              className="input"
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-invalid={tried || undefined}
              autoFocus
            />
            <button type="button" className="pw__toggle" onClick={() => setShow((v) => !v)} aria-pressed={show} aria-controls="access-code">
              {show ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>
        <button type="submit" className="dms-btn dms-btn--primary gate__go" disabled={!code.trim() || busy}>
          {busy ? 'Checking…' : 'Continue'}
          {busy ? null : <Icon name="next" />}
        </button>
        <p className="gate__help">The code is saved on this device, so you won't be asked again here.</p>
      </form>
    </Gate>
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

function useTour(view: ViewId): [boolean, () => void] {
  const { site, loaded } = useData();
  const { personId, person } = usePersona();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (loaded && site && person && view !== 'guided' && view !== 'verify' && !tourSeen(personId)) setOpen(true);
  }, [loaded, site, person, personId, view]);
  useEffect(() => {
    const on = (): void => setOpen(true);
    window.addEventListener(TOUR_EVENT, on);
    return () => window.removeEventListener(TOUR_EVENT, on);
  }, []);
  return [
    open,
    () => {
      markTourSeen(personId);
      setOpen(false);
    },
  ];
}

function Shell(): ReactElement {
  const view = useView();
  const { site, loaded, rt } = useData();
  const { person } = usePersona();
  const [tourOpen, closeTour] = useTour(view);
  if (rt.needsAccessCode) {
    return (
      <div className="app">
        <AccessCode />
      </div>
    );
  }
  try {
    sessionStorage.removeItem(CODE_TRIED);
  } catch {
    // fine
  }
  if (loaded && !site) {
    return (
      <div className="app">
        <SetUp />
        <Toasts />
      </div>
    );
  }
  let page: ReactElement;
  if (!loaded || !site) page = <Loading />;
  else {
    switch (view) {
      case 'capture':
        page = <CapturePage />;
        break;
      case 'guided':
        return (
          <div className="app app--guided">
            <GuidedCapture />
            <Toasts />
          </div>
        );
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
      case 'site':
        page = <SitePage />;
        break;
      case 'cameras':
        page = <CamerasPage />;
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
      {site && loaded ? <AskDomesday /> : null}
      {tourOpen && site ? <Tour role={person?.role} name={person?.name ?? null} onClose={closeTour} /> : null}
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
