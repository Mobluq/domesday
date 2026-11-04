import { buildWhatsAppSummary } from '@domesday/domain';
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { insightsFor, type Insight } from '../ai/insights';
import { recogniseStoredRoom, useJobs, canRecognise } from '../capture/pipeline';
import { resetDemo, startNextWalk } from '../data/setup';
import {
  approvedLines,
  comparison,
  fmtDate,
  fmtDateTime,
  fmtTime,
  liveLines,
  money,
  personName,
  plural,
  reconciliation,
  registerEntry,
  roomName,
  walkProgress,
} from '../data/derive';
import { useData, usePersona, useToast } from '../data/store';
import type { Line } from '../data/types';
import { urlFor } from '../runtime/media';
import { go } from '../route';
import { Btn, Chip, Note } from '../ui/bits';
import { Icon, type IconName } from '../ui/icons';
import { openAsk, Orb } from '../ui/orb';

const SUMMARY_LINK = 'https://domesday.example/walks/site';

/** ₦12.4m, ₦380k, ₦45,000: compact for figures, exact under ₦100k. */
export function moneyShort(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined) return '₦0';
  const n = kobo / 100;
  if (Math.abs(n) >= 1_000_000) return `₦${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.0+$|(\.\d)0$/, '$1')}m`;
  if (Math.abs(n) >= 100_000) return `₦${Math.round(n / 1000)}k`;
  return money(kobo);
}

const TONE_ICON: Record<Insight['tone'], IconName> = { critical: 'unsafe', warning: 'not-seen', info: 'info', good: 'found' };

type RoomState = 'filmed' | 'skipped' | 'running' | 'waiting' | 'not_started';

/** The walk as a ring: one arc per room, in walking order. */
function RoomsRing({ states, done, total }: { states: readonly RoomState[]; done: number; total: number }): ReactElement {
  const r = 52;
  const c = 2 * Math.PI * r;
  const gap = total > 1 ? 4 : 0;
  const seg = total ? c / total : c;
  return (
    <figure className="ring" aria-label={`${done} of ${total} rooms filmed or skipped`}>
      <svg viewBox="0 0 128 128" width="100%" height="100%" aria-hidden="true">
        <circle cx="64" cy="64" r={r} className="ring__track" />
        {states.map((s, i) => (
          <circle
            key={i}
            cx="64"
            cy="64"
            r={r}
            className="ring__seg"
            data-s={s}
            strokeDasharray={`${Math.max(0, seg - gap)} ${c}`}
            strokeDashoffset={-i * seg}
            transform="rotate(-90 64 64)"
          />
        ))}
      </svg>
      <figcaption>
        <span className="ring__n">
          {done}
          <small>/{total}</small>
        </span>
        <span className="ring__l">rooms done</span>
      </figcaption>
    </figure>
  );
}

function Tile({ label, value, sub, icon, tone, meter }: { label: string; value: string; sub: string; icon?: IconName; tone?: 'warn' | 'bad'; meter?: number }): ReactElement {
  return (
    <div className="stat" data-tone={tone}>
      <span className="stat__label">
        {icon ? <Icon name={icon} size={16} /> : null}
        {label}
      </span>
      <span className="stat__value">{value}</span>
      {meter !== undefined ? (
        <span className="stat__meter" aria-hidden="true">
          <i style={{ width: `${Math.round(meter * 100)}%` }} />
        </span>
      ) : null}
      <span className="stat__sub">{sub}</span>
    </div>
  );
}

interface CoveragePart {
  readonly key: string;
  readonly label: string;
  readonly kobo: number;
}

export function WalksPage(): ReactElement {
  const data = useData();
  const { site, current, previous, rt, register, cameraChecks, corrections } = data;
  const { personId } = usePersona();
  const { say } = useToast();
  const jobs = useJobs();
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const isApproved = current?.walk.status === 'approved';
  const cmp = useMemo(() => (isApproved && site && current && previous ? comparison(site, current, previous) : null), [isApproved, site, current, previous]);
  const recon = useMemo(() => (site && current && register ? reconciliation(site, register, current) : null), [site, current, register]);
  const insights = useMemo(() => insightsFor(data), [data]);
  if (!site || !current) return <main className="dash" />;

  const progress = walkProgress(site, current);
  const live = liveLines(current);
  const open = live.filter((l) => l.status === 'proposed').length;
  const decided = live.length - open;
  const approved = current.walk.status === 'approved';
  const roomsDone = progress.filmed + progress.skipped === progress.total;
  const started = current.walk.startedAt;

  // ---- Next step ------------------------------------------------------------------------
  let next: { title: string; body: string; action?: ReactElement };
  if (approved) {
    next = {
      title: cmp ? `${plural(cmp.changeCount, 'change', 'changes')} since ${fmtDate(previous?.walk.startedAt).replace(/ \d{4}$/, '')}` : 'Walk approved',
      body: `Approved by ${personName(site, current.walk.approvedBy)} on ${fmtDateTime(current.walk.approvedAt)}. ${previous ? 'The comparison, the reconciliation and the report are ready.' : 'This first walk is the baseline: the next walk is compared against it.'}`,
      action: (
        <>
          {previous ? (
            <Btn variant="primary" icon="moved" onClick={() => go('compare')}>
              See what changed
            </Btn>
          ) : null}
          <Btn icon="books" onClick={() => go('reconcile')}>
            Reconcile
          </Btn>
          <Btn icon="report" onClick={() => go('report')}>
            Report
          </Btn>
          <Btn
            variant="quiet"
            icon="walk"
            disabled={starting}
            onClick={async () => {
              setStarting(true);
              const r = await startNextWalk(rt, site, current, personId);
              setStarting(false);
              if (!r.ok) say(r.message, 'error');
              else say('Next walk started. It will be compared against this one.');
            }}
          >
            {starting ? 'Starting…' : 'Start the next walk'}
          </Btn>
        </>
      ),
    };
  } else if (!roomsDone) {
    next = {
      title: progress.filmed === 0 ? 'Film the first room' : `Film the next room: ${progress.notStarted} to go`,
      body: 'About a minute a room on a phone. Claude lists what it sees and every line waits for a person.',
      action: (
        <>
          <Btn variant="primary" icon="record" onClick={() => go('capture')}>
            Go to capture
          </Btn>
          <Btn icon="phone" onClick={() => go('guided')}>
            Guided capture
          </Btn>
        </>
      ),
    };
  } else if (open > 0) {
    next = {
      title: `Review ${plural(open, 'line', 'lines')}`,
      body: 'Every room is filmed or skipped with a reason. A named person decides each line before the walk can be approved.',
      action: (
        <Btn variant="primary" icon="found" onClick={() => go('review')}>
          Start reviewing
        </Btn>
      ),
    };
  } else {
    next = {
      title: 'Ready to approve',
      body: 'Every line has a decision and every room is filmed or skipped.',
      action: (
        <Btn variant="primary" icon="found" onClick={() => go('review')}>
          Approve the walk
        </Btn>
      ),
    };
  }

  // ---- Figures --------------------------------------------------------------------------
  const items = live.reduce((s, l) => s + l.quantity, 0);
  const prevItems = previous ? approvedLines(previous).reduce((s, l) => s + l.quantity, 0) : null;
  const unsafe = live.filter((l) => l.condition === 'not_working_or_unsafe' || l.safety);
  const states: RoomState[] = site.rooms.map((r) => {
    const v = current.rooms.get(r.id);
    const job = jobs.find((j) => j.roomId === r.id && j.walkId === current.walk.id && j.phase === 'running');
    if (job || v?.analysis.status === 'running') return 'running';
    if (v?.status === 'skipped') return 'skipped';
    if (v?.status === 'filmed') return v.analysis.status === 'waiting' || v.analysis.status === 'failed' ? 'waiting' : 'filmed';
    return 'not_started';
  });

  // Register coverage: what share of the books' value this walk has seen.
  const bookTotal = register?.lines.reduce((s, l) => s + (l.bookValueKobo ?? 0), 0) ?? 0;
  const value = (registerId: string | null): number => registerEntry(register, registerId)?.bookValueKobo ?? 0;
  const parts: CoveragePart[] = [];
  let seenKobo = 0;
  if (recon && register) {
    const byStatus = (s: string): number => recon.items.filter((i) => i.status === s).reduce((t, i) => t + value(i.registerId), 0);
    const inPlace = byStatus('found');
    const elsewhere = byStatus('found_elsewhere');
    const notSeen = recon.notSeenValueKobo;
    const notFilmed = recon.roomNotFilmedValueKobo;
    seenKobo = inPlace + elsewhere;
    const unchecked = Math.max(0, bookTotal - inPlace - elsewhere - notSeen - notFilmed);
    parts.push(
      { key: 'found', label: 'Seen where the books say', kobo: inPlace },
      { key: 'elsewhere', label: 'Seen in another room', kobo: elsewhere },
      { key: 'not-seen', label: 'Not seen', kobo: notSeen },
      { key: 'not-filmed', label: 'Room not filmed', kobo: notFilmed },
      { key: 'unchecked', label: approved ? 'Not matched' : 'Not checked yet', kobo: unchecked },
    );
  }
  const share = bookTotal ? seenKobo / bookTotal : 0;

  // Condition, counted in items rather than lines.
  const grades = [
    { key: 'good', label: 'Good' },
    { key: 'fair', label: 'Fair' },
    { key: 'poor', label: 'Poor' },
    { key: 'not_working_or_unsafe', label: 'Not working or unsafe' },
  ] as const;
  const gradeCount = (g: Line['condition']): number => live.filter((l) => l.condition === g).reduce((s, l) => s + l.quantity, 0);
  const gradeMax = Math.max(1, ...grades.map((g) => gradeCount(g.key)));

  // Book value by room: seen, not seen and the rest.
  const roomRows = register
    ? site.rooms
        .map((r) => {
          const lines = register.lines.filter((l) => l.roomId === r.id);
          const total = lines.reduce((s, l) => s + (l.bookValueKobo ?? 0), 0);
          let seen = 0;
          let notSeen = 0;
          for (const l of lines) {
            const item = recon?.items.find((i) => i.registerId === l.registerId);
            if (item?.status === 'found' || item?.status === 'found_elsewhere') seen += l.bookValueKobo ?? 0;
            else if (item?.status === 'not_seen') notSeen += item.valueKobo ?? l.bookValueKobo ?? 0;
          }
          return { id: r.id, name: r.name, total, seen, notSeen: Math.min(notSeen, total - seen) };
        })
        .filter((r) => r.total > 0)
        .sort((a, b) => b.total - a.total)
    : [];
  const roomMax = Math.max(1, ...roomRows.map((r) => r.total));

  // Changes since the last walk.
  const changeRows = cmp
    ? (
        [
          ['new', 'New', 'new'],
          ['moved', 'Moved', 'moved'],
          ['not_seen', 'Not seen', 'not-seen'],
          ['condition_worse', 'Worse condition', 'worse'],
          ['condition_better', 'Better condition', 'better'],
        ] as const
      ).map(([status, label, chip]) => ({ label, chip, n: cmp.items.filter((c) => c.status === status).length }))
    : [];

  // Activity: the walk's events, camera checks and corrections, newest first.
  const activity = [
    ...current.walk.events.map((e) => ({ at: e.at, text: e.text, who: e.by ? personName(site, e.by) : null, icon: 'walk' as IconName })),
    ...cameraChecks.slice(0, 5).map((c) => ({ at: c.capturedAt, text: `Camera check: ${(site.cameras ?? []).find((x) => x.id === c.cameraId)?.name ?? 'a camera'} on ${roomName(site, c.roomId)}`, who: personName(site, c.by), icon: 'camera' as IconName })),
    ...corrections.slice(0, 5).map((c) => ({ at: c.at, text: `Correction taught to Claude: ${c.kind === 'missed' ? 'a missed item labelled' : c.kind === 'box' ? 'a box redrawn' : c.kind === 'rejected' ? 'a line rejected' : 'a line relabelled'} in ${roomName(site, c.roomId)}`, who: personName(site, c.by), icon: 'edit' as IconName })),
  ]
    .filter((a) => a.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 7);

  const summaries: string[] = [];
  try {
    if (live.length > 0) summaries.push(buildWhatsAppSummary({ event: 'walk_processed', siteName: site.name, linesToReview: open, link: SUMMARY_LINK }).body);
    if (approved) summaries.push(buildWhatsAppSummary({ event: 'walk_approved', siteName: site.name, assetsChecked: approvedLines(current).length, link: SUMMARY_LINK }).body);
    if (cmp && previous?.walk.startedAt)
      summaries.push(
        buildWhatsAppSummary({ event: 'comparison_ready', siteName: site.name, assetsChecked: approvedLines(current).length, changeCount: cmp.changeCount, previousWalkDate: new Date(previous.walk.startedAt), link: SUMMARY_LINK }).body,
      );
  } catch {
    // A summary that fails its own checks is simply not shown.
  }

  const title = current.walk.label || 'Monthly walk';
  const status = approved ? 'approved' : started ? 'live' : 'idle';

  return (
    <main className="dash">
      <section className="page-head dash-hero" aria-label="This walk">
        <div className="dash-hero__inner">
          <div className="dash-hero__main">
            <div className="dash-kicker-row">
              <span className="dash-kicker">
                {site.name} · {site.city} · {plural(site.rooms.length, 'room', 'rooms')}
              </span>
              <span className="dash-status" data-s={status}>
                {approved ? 'Approved' : started ? 'In progress' : 'Not started'}
              </span>
            </div>
            <h1 className="dash-title">{title}</h1>
            <p className="dash-sub">
              {started
                ? `Started ${fmtDate(started)} at ${fmtTime(started)}${current.walk.capturedBy.length ? ` by ${current.walk.capturedBy.map((p) => personName(site, p)).join(' and ')}` : ''}.`
                : 'Not started yet.'}{' '}
              {previous ? `Last walked ${fmtDate(previous.walk.startedAt)}.` : ''}
            </p>
            <div className="dash-next">
              <span className="dash-next__label">Next</span>
              <h2 className="dash-next__title">{next.title}</h2>
              <p className="dash-next__body">{next.body}</p>
              <div className="row">{next.action}</div>
            </div>
          </div>
          <div className="dash-hero__ring">
            <RoomsRing states={states} done={progress.filmed + progress.skipped} total={progress.total} />
            <ul className="ring-legend" aria-label="Room states">
              <li data-s="filmed">{progress.filmed} filmed</li>
              <li data-s="skipped">{progress.skipped} skipped</li>
              <li data-s="not_started">{progress.notStarted} to go</li>
            </ul>
          </div>
          <aside className="dash-ai ai-edge" aria-label="What Domesday noticed">
            <header className="dash-ai__head">
              <Orb size={30} />
              <span className="stack-xs">
                <span className="dash-ai__title">Domesday noticed</span>
                <span className="dash-ai__sub">From this walk and the books</span>
              </span>
            </header>
            <ul className="dash-ai__list">
              {insights.map((i) => (
                <li key={i.id} data-tone={i.tone}>
                  <Icon name={TONE_ICON[i.tone]} size={18} />
                  <div className="stack-xs" style={{ minWidth: 0 }}>
                    <span className="dash-ai__item-title">{i.title}</span>
                    <span className="dash-ai__item-body">{i.body}</span>
                    <span className="row" style={{ gap: 6 }}>
                      {i.ask ? (
                        <button type="button" className="ai-chip" onClick={() => openAsk(i.ask)}>
                          <Orb size={12} /> Ask about this
                        </button>
                      ) : null}
                      {i.go ? (
                        <button type="button" className="ai-chip ai-chip--plain" onClick={() => go(i.go?.view ?? 'walks')}>
                          {i.go.label} <Icon name="next" size={12} />
                        </button>
                      ) : null}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" className="dash-ai__ask" onClick={() => openAsk()}>
              <span>Ask anything about this site</span>
              <kbd>Ctrl K</kbd>
            </button>
          </aside>
        </div>
      </section>

      <section className="dash-tiles" aria-label="This walk in numbers">
        <Tile label="Assets seen" value={items.toLocaleString('en-NG')} sub={`${plural(live.length, 'line', 'lines')}${prevItems !== null ? ` · last walk ${prevItems.toLocaleString('en-NG')}` : ''}`} icon="found" />
        <Tile label="Lines decided" value={`${decided}/${live.length}`} sub={open ? `${plural(open, 'line waits', 'lines wait')} for a person` : live.length ? 'Every line has a decision' : 'Nothing proposed yet'} icon="people" meter={live.length ? decided / live.length : 0} />
        {register ? (
          <Tile label={approved ? 'Not seen' : 'Not seen so far'} value={moneyShort(recon?.notSeenValueKobo ?? 0)} sub={`${plural(recon?.counts.not_seen ?? 0, 'register line', 'register lines')} in filmed rooms`} icon="not-seen" tone={(recon?.counts.not_seen ?? 0) > 0 ? 'warn' : undefined} />
        ) : (
          <Tile label="Register" value="None" sub="Import it in Site setup" icon="books" />
        )}
        <Tile label="Safety flags" value={String(unsafe.length)} sub={unsafe.length ? 'Unsafe or not working' : 'None on this walk'} icon="unsafe" tone={unsafe.length ? 'bad' : undefined} />
      </section>

      <div className="dash-grid">
        {register ? (
          <section className="dash-card dash-card--wide" aria-labelledby="cov-h">
            <div className="dash-card__head">
              <h2 id="cov-h" className="dash-card__title">
                Register value seen{approved ? '' : ' so far'}
              </h2>
              <button type="button" className="ai-chip" onClick={() => openAsk("What wasn't seen on this walk, and what's it worth?")}>
                <Orb size={12} /> Explain
              </button>
            </div>
            <div className="hero-fig">
              <span className="hero-fig__value">{moneyShort(seenKobo)}</span>
              <span className="hero-fig__sub">
                of {moneyShort(bookTotal)} net book value in the books · {Math.round(share * 100)}%
              </span>
            </div>
            <div className="segbar-tall" role="img" aria-label={parts.map((p) => `${p.label}: ${money(p.kobo)}`).join('; ')}>
              {parts
                .filter((p) => p.kobo > 0)
                .map((p) => {
                  const pct = bookTotal ? (p.kobo / bookTotal) * 100 : 0;
                  return (
                    <span key={p.key} data-k={p.key} style={{ flexGrow: p.kobo, flexBasis: 0 }} title={`${p.label}: ${money(p.kobo)} (${Math.round(pct)}%)`}>
                      {pct >= 12 ? `${Math.round(pct)}%` : ''}
                    </span>
                  );
                })}
            </div>
            <ul className="legend">
              {parts.map((p) => (
                <li key={p.key} data-k={p.key}>
                  <i aria-hidden="true" />
                  <span>{p.label}</span>
                  <span className="legend__v">{moneyShort(p.kobo)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="dash-card dash-card--wide dash-card--empty" aria-labelledby="cov-h">
            <h2 id="cov-h" className="dash-card__title">
              Add your register to see value
            </h2>
            <p className="ui-body muted">With the fixed asset register in, this card shows how much of the books' value each walk has seen, and what wasn't.</p>
            <div>
              <Btn icon="books" onClick={() => go('site')}>
                Import the register
              </Btn>
            </div>
          </section>
        )}

        <section className="dash-card" aria-labelledby="cond-h">
          <div className="dash-card__head">
            <h2 id="cond-h" className="dash-card__title">
              Condition
            </h2>
            <span className="dash-card__meta">{items.toLocaleString('en-NG')} items</span>
          </div>
          <ul className="hbars" aria-label="Items by condition">
            {grades.map((g) => {
              const n = gradeCount(g.key);
              return (
                <li key={g.key} data-k={g.key}>
                  <span className="hbars__label">{g.label}</span>
                  <span className="hbars__track">
                    <i style={{ width: `${(n / gradeMax) * 100}%` }} title={`${g.label}: ${n}`} />
                  </span>
                  <span className="hbars__v">{n}</span>
                </li>
              );
            })}
          </ul>
          {unsafe[0] ? (
            <p className="dash-card__foot">
              <Icon name="unsafe" size={14} /> {unsafe[0].safety ?? unsafe[0].conditionReason} · {roomName(site, unsafe[0].roomId)}
            </p>
          ) : null}
        </section>

        {roomRows.length ? (
          <section className="dash-card dash-card--wide" aria-labelledby="room-h">
            <div className="dash-card__head">
              <h2 id="room-h" className="dash-card__title">
                Book value by room
              </h2>
              <ul className="legend legend--inline">
                <li data-k="found">
                  <i aria-hidden="true" />
                  Seen
                </li>
                <li data-k="not-seen">
                  <i aria-hidden="true" />
                  Not seen
                </li>
                <li data-k="unchecked">
                  <i aria-hidden="true" />
                  Not checked
                </li>
              </ul>
            </div>
            <ul className="vbars" aria-label="Book value by room">
              {roomRows.map((r) => (
                <li key={r.id}>
                  <span className="vbars__label">{r.name}</span>
                  <span className="vbars__track" style={{ '--w': `${(r.total / roomMax) * 100}%` } as CSSProperties}>
                    <span className="vbars__bar" title={`${r.name}: ${money(r.total)} in the books, ${money(r.seen)} seen, ${money(r.notSeen)} not seen`}>
                      {r.seen ? <i data-k="found" style={{ flexGrow: r.seen }} /> : null}
                      {r.notSeen ? <i data-k="not-seen" style={{ flexGrow: r.notSeen }} /> : null}
                      {r.total - r.seen - r.notSeen > 0 ? <i data-k="unchecked" style={{ flexGrow: r.total - r.seen - r.notSeen }} /> : null}
                    </span>
                  </span>
                  <span className="vbars__v">{moneyShort(r.total)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="dash-card" aria-labelledby="chg-h">
          <div className="dash-card__head">
            <h2 id="chg-h" className="dash-card__title">
              {previous ? `Since ${fmtDate(previous.walk.startedAt).replace(/ \d{4}$/, '')}` : 'Changes'}
            </h2>
            {cmp ? <span className="dash-card__meta">{plural(cmp.changeCount, 'change', 'changes')}</span> : null}
          </div>
          {cmp ? (
            <ul className="changes">
              {changeRows.map((c) => (
                <li key={c.label} data-zero={c.n === 0 || undefined}>
                  <Chip status={c.chip} quiet>
                    {c.label}
                  </Chip>
                  <span className="changes__n">{c.n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ui-body-s muted">{previous ? 'Shown once this walk is approved: what is new, moved, not seen, worse or better since the last walk.' : 'This is the first walk here. Once approved, it becomes the baseline the next walk is compared against.'}</p>
          )}
          {cmp ? (
            <button type="button" className="ai-chip ai-chip--plain" onClick={() => go('compare')}>
              Open the comparison <Icon name="next" size={12} />
            </button>
          ) : null}
        </section>
      </div>

      <section className="dash-rooms" aria-labelledby="rooms-h">
        <div className="dash-section-head">
          <h2 id="rooms-h" className="dash-card__title">
            Rooms
          </h2>
          <span className="dash-card__meta">
            {progress.filmed} filmed · {progress.skipped} skipped · {progress.notStarted} not started
          </span>
        </div>
        <div className="room-tiles">
          {site.rooms.map((r, idx) => {
            const v = current.rooms.get(r.id);
            const st = states[idx] ?? 'not_started';
            const frame = v?.analysis.status === 'done' ? v.frames[0] : undefined;
            const img = frame ? urlFor(frame.ref) : (r.sample?.poster ?? null);
            const n = current.lines.filter((l) => l.roomId === r.id && (l.status === 'proposed' || l.status === 'accepted')).length;
            const regValue = register?.lines.filter((l) => l.roomId === r.id).reduce((s, l) => s + (l.bookValueKobo ?? 0), 0) ?? 0;
            const job = jobs.find((j) => j.roomId === r.id && j.walkId === current.walk.id && j.phase === 'running');
            return (
              <article key={r.id} className="room-tile" data-s={st}>
                <button type="button" className="room-tile__media" onClick={() => go(st === 'filmed' && n ? 'review' : 'capture')} aria-label={`${r.name}: ${st.replace('_', ' ')}`}>
                  {img ? <img src={img} alt="" loading="lazy" /> : <span className="room-tile__ph">{r.name.slice(0, 1)}</span>}
                  <span className="room-tile__state">
                    {st === 'running' ? (
                      <>
                        <Orb size={12} thinking /> Claude is looking
                      </>
                    ) : st === 'filmed' ? (
                      'Filmed'
                    ) : st === 'waiting' ? (
                      'Waiting for recognition'
                    ) : st === 'skipped' ? (
                      'Skipped'
                    ) : (
                      'Not started'
                    )}
                  </span>
                </button>
                <div className="room-tile__body">
                  <span className="room-tile__name">{r.name}</span>
                  <span className="room-tile__meta">
                    {v?.status === 'skipped' ? `Skipped: ${v.skipReason}` : `${r.floor}${n ? ` · ${plural(n, 'line', 'lines')}` : ''}${regValue ? ` · ${moneyShort(regValue)}` : ''}`}
                  </span>
                  {st === 'waiting' && canRecognise(rt) && !job ? (
                    <button type="button" className="ai-chip" onClick={() => void recogniseStoredRoom({ rt, site, bundle: current, room: r, personId, corrections })}>
                      <Orb size={12} /> Run recognition
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <div className="dash-grid dash-grid--3">
        <section className="dash-card" aria-labelledby="act-h">
          <h2 id="act-h" className="dash-card__title">
            Activity
          </h2>
          {activity.length ? (
            <ol className="activity">
              {activity.map((a, i) => (
                <li key={i}>
                  <span className="activity__icon">
                    <Icon name={a.icon} size={14} />
                  </span>
                  <span className="stack-xs" style={{ minWidth: 0 }}>
                    <span className="ui-body-s">{a.text}</span>
                    <span className="activity__meta">
                      {fmtDateTime(a.at)}
                      {a.who ? ` · ${a.who}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="ui-body-s muted">Nothing yet. Filming, decisions and camera checks show up here.</p>
          )}
        </section>

        <section className="dash-card" aria-labelledby="site-h">
          <h2 id="site-h" className="dash-card__title">
            This site
          </h2>
          <dl className="facts">
            <div>
              <dt>Register</dt>
              <dd>{register ? `${plural(register.lines.length, 'line', 'lines')} · ${moneyShort(bookTotal)}` : 'Not imported'}</dd>
            </div>
            <div>
              <dt>Cameras</dt>
              <dd>{(site.cameras ?? []).length ? `${plural((site.cameras ?? []).length, 'camera', 'cameras')}${cameraChecks[0] ? `, last check ${fmtDate(cameraChecks[0].capturedAt)}` : ''}` : 'None linked'}</dd>
            </div>
            <div>
              <dt>Compared with</dt>
              <dd>{previous ? `Walk of ${fmtDate(previous.walk.startedAt)}${previous.walk.demoHistory ? ' (demo history)' : ''}` : 'Nothing yet: first walk'}</dd>
            </div>
            <div>
              <dt>People</dt>
              <dd>{site.people.map((p) => p.name.split(' ')[0]).join(', ')}</dd>
            </div>
          </dl>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="ai-chip ai-chip--plain" onClick={() => go('cameras')}>
              Cameras <Icon name="next" size={12} />
            </button>
            <button type="button" className="ai-chip ai-chip--plain" onClick={() => go('site')}>
              Site setup <Icon name="next" size={12} />
            </button>
            <button type="button" className="ai-chip ai-chip--plain" onClick={() => go('verify')}>
              Verify a report <Icon name="next" size={12} />
            </button>
          </div>
        </section>

        <section className="dash-card" aria-labelledby="msg-h">
          <h2 id="msg-h" className="dash-card__title">
            {site.demo ? 'Messages and demo' : 'Messages'}
          </h2>
          {summaries.length ? (
            <div className="stack-s">
              {summaries.slice(-1).map((s) => (
                <div key={s} className="dms-msg">
                  {s}
                  <span className="dms-msg__time">counts and a link only</span>
                </div>
              ))}
              <span className="ui-body-s muted">What the site's WhatsApp group would receive: counts and a link that needs sign-in, no photos or values.</span>
            </div>
          ) : (
            <p className="ui-body-s muted">Once lines are proposed, a short summary for the site group appears here.</p>
          )}
          {site.demo ? (
            confirmReset ? (
              <div className="stack-s">
                <Note tone="warn" icon="info">
                  This removes everything filmed and decided on the current walk, and any issued reports, for everyone who has this page open.
                </Note>
                <div className="row">
                  <Btn
                    variant="danger"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await resetDemo(rt, site);
                        say('Demo reset to the start');
                        setConfirmReset(false);
                      } catch (e) {
                        say(`Reset failed: ${String((e as Error).message ?? e)}`, 'error');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? 'Resetting…' : 'Reset the demo'}
                  </Btn>
                  <Btn variant="quiet" onClick={() => setConfirmReset(false)}>
                    Keep it
                  </Btn>
                </div>
              </div>
            ) : (
              <div>
                <Btn variant="quiet" icon="refresh" onClick={() => setConfirmReset(true)}>
                  Start the demo again
                </Btn>
              </div>
            )
          ) : null}
        </section>
      </div>
    </main>
  );
}
