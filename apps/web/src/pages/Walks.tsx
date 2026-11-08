import { buildWhatsAppSummary } from '@domesday/domain';
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { insightsFor } from '../ai/insights';
import { recogniseStoredRoom, useJobs, canRecognise } from '../capture/pipeline';
import { resetDemo, startNextWalk } from '../data/setup';
import {
  approvedLines,
  comparison,
  fmtDate,
  fmtDateTime,
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
import { go } from '../route';
import { Btn, Chip, Note } from '../ui/bits';
import { Wall } from './Wall';
import { Icon, type IconName } from '../ui/icons';
import { openAsk } from '../ui/ask';

const SUMMARY_LINK = 'https://domesday.example/walks/site';

/** ₦12.4m, ₦380k, ₦45,000: compact for figures, exact under ₦100k. */
export function moneyShort(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined) return '₦0';
  const n = kobo / 100;
  if (Math.abs(n) >= 1_000_000) return `₦${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.0+$|(\.\d)0$/, '$1')}m`;
  if (Math.abs(n) >= 100_000) return `₦${Math.round(n / 1000)}k`;
  return money(kobo);
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
  const statusLine = approved
    ? `Approved by ${personName(site, current.walk.approvedBy)} on ${fmtDate(current.walk.approvedAt)}.`
    : started
      ? `In progress since ${fmtDate(started)}${current.walk.capturedBy.length ? `, filmed by ${current.walk.capturedBy.map((p) => personName(site, p)).join(' and ')}` : ''}.`
      : 'Not started yet.';
  const compared = previous ? ` Compared with the walk of ${fmtDate(previous.walk.startedAt)}.` : ' This is the first walk here.';
  const notSeenCount = recon?.counts.not_seen ?? 0;
  const counted = approvedLines(current).length > 0;

  return (
    <main className="ovp">
      <section className="hero" aria-label="This walk">
        <Wall
          site={site}
          current={current}
          previous={previous}
          running={(id) => current.rooms.get(id)?.analysis.status === 'running' || jobs.some((j) => j.roomId === id && j.walkId === current.walk.id && j.phase === 'running')}
          runnable={(id) => {
            const v = current.rooms.get(id);
            return Boolean(v?.status === 'filmed' && (v.analysis.status === 'waiting' || v.analysis.status === 'failed') && canRecognise(rt) && !jobs.some((j) => j.roomId === id && j.phase === 'running'));
          }}
          onRun={(id) => {
            const room = site.rooms.find((r) => r.id === id);
            if (room) void recogniseStoredRoom({ rt, site, bundle: current, room, personId, corrections });
          }}
        />
        <div className="strip">
          <header className="ov-head">
            <p className="ov-where">
              {site.name}, {site.city} · {plural(site.rooms.length, 'room', 'rooms')}
            </p>
            <h1 className="ov-title">{title}</h1>
            <p className="ov-state" data-s={status}>
              {statusLine}
              {compared}
            </p>
          </header>
          <div className="ov-next" aria-labelledby="next-h">
            <h2 id="next-h" className="ov-next__title">
              {next.title}
            </h2>
            <p className="ov-next__body">{next.body}</p>
            <div className="ov-actions">{next.action}</div>
            <p className="strip__key">
              <span data-k="seen">Colour: seen on this walk</span>
              <span data-k="last">Grey: seen last walk, not yet on this one</span>
            </p>
          </div>
        </div>
      </section>

      <div className="ov">
      <div className="ov-cols">
        <section className="ov-sec" aria-labelledby="ledger-h">
          <div className="ov-sec__head">
            <h2 id="ledger-h" className="ov-sec__title">
              This walk in figures
            </h2>
          </div>
          <dl className="ledger">
            <div>
              <dt>Rooms done</dt>
              <dd>
                {progress.filmed + progress.skipped} of {progress.total}
              </dd>
            </div>
            <div>
              <dt>Assets seen</dt>
              <dd>
                {live.length ? items.toLocaleString('en-NG') : 'None yet'}
                {prevItems !== null ? <small> · last walk {prevItems.toLocaleString('en-NG')}</small> : null}
              </dd>
            </div>
            <div>
              <dt>Lines decided</dt>
              <dd>{live.length ? `${decided} of ${live.length}` : 'None yet'}</dd>
            </div>
            {register ? (
              <>
                <div>
                  <dt>Register value seen</dt>
                  <dd>
                    {moneyShort(seenKobo)} <small>of {moneyShort(bookTotal)}</small>
                  </dd>
                </div>
                <div data-tone={counted && notSeenCount ? 'warn' : undefined}>
                  <dt>Not seen</dt>
                  <dd>{counted ? `${moneyShort(recon?.notSeenValueKobo ?? 0)} · ${plural(notSeenCount, 'line', 'lines')}` : 'Counted once lines are accepted'}</dd>
                </div>
              </>
            ) : (
              <div>
                <dt>Register</dt>
                <dd>Not imported</dd>
              </div>
            )}
            <div data-tone={unsafe.length ? 'bad' : undefined}>
              <dt>Safety flags</dt>
              <dd>{unsafe.length ? plural(unsafe.length, 'flag', 'flags') : 'None'}</dd>
            </div>
          </dl>
        </section>

        <section className="ov-sec" aria-labelledby="attn-h">
          <div className="ov-sec__head">
            <h2 id="attn-h" className="ov-sec__title">
              Needs attention
            </h2>
          </div>
          <ol className="attn">
            {insights.map((i) => (
              <li key={i.id} data-tone={i.tone}>
                <p className="attn__title">{i.title}</p>
                <p className="attn__body">{i.body}</p>
                {i.go || i.ask ? (
                  <p className="attn__links">
                    {i.go ? (
                      <button type="button" className="linklike" onClick={() => go(i.go?.view ?? 'walks')}>
                        {i.go.label}
                      </button>
                    ) : null}
                    {i.ask ? (
                      <button type="button" className="linklike" onClick={() => openAsk(i.ask)}>
                        Ask Domesday AI
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      </div>

      {register ? (
        <section className="ov-sec" aria-labelledby="cov-h">
          <div className="ov-sec__head">
            <h2 id="cov-h" className="ov-sec__title">
              Register value seen{approved ? '' : ' so far'}
            </h2>
            <button type="button" className="linklike" onClick={() => openAsk("What wasn't seen on this walk, and what's it worth?")}>
              Ask Domesday AI to explain
            </button>
          </div>
          <div className="hero-fig">
            <span className="hero-fig__value">{moneyShort(seenKobo)}</span>
            <span className="hero-fig__sub">
              of {moneyShort(bookTotal)} net book value in the register · {Math.round(share * 100)}%
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
        <section className="ov-sec" aria-labelledby="cov-h">
          <div className="ov-sec__head">
            <h2 id="cov-h" className="ov-sec__title">
              Add your register to see value
            </h2>
          </div>
          <p className="ui-body muted" style={{ maxWidth: '60ch' }}>
            With the fixed asset register in, this shows how much of the books' value each walk has seen, and what it hasn't.
          </p>
          <div>
            <Btn icon="books" onClick={() => go('site')}>
              Import the register
            </Btn>
          </div>
        </section>
      )}

      <div className="ov-cols">
        <section className="ov-sec" aria-labelledby="cond-h">
          <div className="ov-sec__head">
            <h2 id="cond-h" className="ov-sec__title">
              Condition
            </h2>
            <p className="ov-sec__meta">{plural(items, 'item', 'items')}</p>
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
            <p className="ov-flag">
              <Icon name="unsafe" size={16} /> {unsafe[0].safety ?? unsafe[0].conditionReason} · {roomName(site, unsafe[0].roomId)}
            </p>
          ) : null}
        </section>

        <section className="ov-sec" aria-labelledby="chg-h">
          <div className="ov-sec__head">
            <h2 id="chg-h" className="ov-sec__title">
              {previous ? `Since ${fmtDate(previous.walk.startedAt).replace(/ \d{4}$/, '')}` : 'Changes'}
            </h2>
            {cmp ? <p className="ov-sec__meta">{plural(cmp.changeCount, 'change', 'changes')}</p> : null}
          </div>
          {cmp ? (
            <>
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
              <p>
                <button type="button" className="linklike" onClick={() => go('compare')}>
                  Open the comparison
                </button>
              </p>
            </>
          ) : (
            <p className="ui-body-s muted">{previous ? 'Shown once this walk is approved: what is new, moved, not seen, worse or better since the last walk.' : 'This is the first walk here. Once approved, it becomes the baseline the next walk is compared against.'}</p>
          )}
        </section>
      </div>

      {roomRows.length ? (
        <section className="ov-sec" aria-labelledby="room-h">
          <div className="ov-sec__head">
            <h2 id="room-h" className="ov-sec__title">
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
                  <span className="vbars__bar" title={`${r.name}: ${money(r.total)} in the register, ${money(r.seen)} seen, ${money(r.notSeen)} not seen`}>
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

      <div className="ov-cols">
        <section className="ov-sec" aria-labelledby="act-h">
          <div className="ov-sec__head">
            <h2 id="act-h" className="ov-sec__title">
              Activity
            </h2>
          </div>
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

        <div className="stack-l">
          <section className="ov-sec" aria-labelledby="site-h">
            <div className="ov-sec__head">
              <h2 id="site-h" className="ov-sec__title">
                This site
              </h2>
            </div>
            <dl className="ledger">
              <div>
                <dt>Register</dt>
                <dd>{register ? `${plural(register.lines.length, 'line', 'lines')} · ${moneyShort(bookTotal)}` : 'Not imported'}</dd>
              </div>
              <div>
                <dt>Cameras</dt>
                <dd>{(site.cameras ?? []).length ? `${plural((site.cameras ?? []).length, 'camera', 'cameras')}${cameraChecks[0] ? `, checked ${fmtDate(cameraChecks[0].capturedAt)}` : ''}` : 'None linked'}</dd>
              </div>
              <div>
                <dt>Compared with</dt>
                <dd>{previous ? `${fmtDate(previous.walk.startedAt)}${previous.walk.demoHistory ? ' (demo)' : ''}` : 'Nothing yet'}</dd>
              </div>
              <div>
                <dt>People</dt>
                <dd>{site.people.map((p) => p.name.split(' ')[0]).join(', ')}</dd>
              </div>
            </dl>
            <p className="ov-links">
              <button type="button" className="linklike" onClick={() => go('cameras')}>
                Cameras
              </button>
              <button type="button" className="linklike" onClick={() => go('site')}>
                Site setup
              </button>
              <button type="button" className="linklike" onClick={() => go('verify')}>
                Verify a report
              </button>
            </p>
          </section>

          <section className="ov-sec" aria-labelledby="msg-h">
            <div className="ov-sec__head">
              <h2 id="msg-h" className="ov-sec__title">
                {site.demo ? 'Messages and demo' : 'Messages'}
              </h2>
            </div>
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
                    <button type="button" className="linklike" onClick={() => setConfirmReset(false)}>
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <p>
                  <button type="button" className="linklike" onClick={() => setConfirmReset(true)}>
                    Start the demo again
                  </button>
                </p>
              )
            ) : null}
          </section>
        </div>
      </div>
      </div>
    </main>
  );
}
