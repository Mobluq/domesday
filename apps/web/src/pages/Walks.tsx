import { buildWhatsAppSummary } from '@domesday/domain';
import { useMemo, useState, type ReactElement } from 'react';
import { recogniseStoredRoom, useJobs, canRecognise } from '../capture/pipeline';
import { resetDemo, startNextWalk } from '../data/setup';
import {
  approvedLines,
  comparison,
  duration,
  fmtDate,
  fmtDateTime,
  fmtTime,
  liveLines,
  personName,
  plural,
  walkProgress,
} from '../data/derive';
import { useData, usePersona, useToast } from '../data/store';
import { go } from '../route';
import { Btn, Chip, Label, Note } from '../ui/bits';
import { Icon } from '../ui/icons';

const SUMMARY_LINK = 'https://domesday.example/walks/site';

function RoomStatus({ status, analysis, refilm }: { status: string; analysis: string; refilm: boolean }): ReactElement {
  if (refilm) return <Chip status="not-seen" quiet>Refilm requested</Chip>;
  if (status === 'skipped') return <Chip status="not-filmed" quiet>Skipped</Chip>;
  if (status !== 'filmed') return <span className="ui-body-s muted">Not started</span>;
  if (analysis === 'running') return <span className="ui-body-s">Claude is looking…</span>;
  if (analysis === 'waiting') return <Chip status="not-seen" quiet>Waiting for recognition</Chip>;
  if (analysis === 'failed') return <Chip status="unsafe" quiet>Recognition failed</Chip>;
  return <Chip status="confirmed" quiet>Filmed</Chip>;
}

export function WalksPage(): ReactElement {
  const data = useData();
  const { site, current, previous, rt, register } = data;
  const { personId } = usePersona();
  const { say } = useToast();
  const jobs = useJobs();
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const isApproved = current?.walk.status === 'approved';
  const cmp = useMemo(() => (isApproved && site && current && previous ? comparison(site, current, previous) : null), [isApproved, site, current, previous]);
  if (!site || !current) return <main className="page" />;

  const progress = walkProgress(site, current);
  const live = liveLines(current);
  const open = live.filter((l) => l.status === 'proposed').length;
  const decided = current.lines.filter((l) => l.status !== 'proposed').length;
  const approved = current.walk.status === 'approved';
  const roomsDone = progress.filmed + progress.skipped === progress.total;
  const started = current.walk.startedAt;

  let next: { title: string; body: string; action?: ReactElement };
  if (approved) {
    next = {
      title: cmp ? `${plural(cmp.changeCount, 'change', 'changes')} since the walk on ${fmtDate(previous?.walk.startedAt).replace(/ \d{4}$/, '')}` : 'Walk approved',
      body: `Approved by ${personName(site, current.walk.approvedBy)} on ${fmtDateTime(current.walk.approvedAt)}. ${previous ? 'The comparison, the reconciliation and the report are ready.' : 'This first walk is the baseline: the next walk is compared against it. The reconciliation and the report are ready.'}`,
      action: (
        <div className="row">
          {previous ? (
            <Btn variant="primary" icon="moved" onClick={() => go('compare')}>
              See what changed
            </Btn>
          ) : null}
          <Btn icon="books" onClick={() => go('reconcile')}>
            Reconcile with the books
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
        </div>
      ),
    };
  } else if (!roomsDone) {
    next = {
      title: progress.filmed === 0 ? 'Film the first room' : `Film the next room: ${progress.notStarted} to go`,
      body: 'Open this page on your phone and go to Capture. Each room takes a minute: film it, and the lines Claude proposes appear here for review. Guided capture shows one room at a time with big buttons, for whoever does the walk.',
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
      body: 'Every line has a decision and every room is filmed or skipped. Approving runs the comparison and the reconciliation.',
      action: (
        <Btn variant="primary" icon="found" onClick={() => go('review')}>
          Approve the walk
        </Btn>
      ),
    };
  }

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

  return (
    <main className="page">
      <div className="page-head">
        <div className="page-head__text">
          <Label>
            {site.name.toUpperCase()} · {site.city.toUpperCase()} · {site.rooms.length} ROOMS
          </Label>
          <h1 className="display-l">{approved ? 'Walk approved' : started ? 'Walk in progress' : current.walk.label || 'Monthly walk'}</h1>
          <p className="ui-body muted">
            {started
              ? `Started ${fmtDate(started)} at ${fmtTime(started)}${current.walk.capturedBy.length ? ` by ${current.walk.capturedBy.map((p) => personName(site, p)).join(' and ')}` : ''}.`
              : 'Not started yet.'}{' '}
            {previous ? `Last walked ${fmtDate(previous.walk.startedAt)} by ${personName(site, previous.walk.capturedBy[0])}.` : ''}
          </p>
        </div>
      </div>

      <div className="walk-grid section">
        <div className="stack-l">
          <section className="panel stack-m" aria-label="Next step">
            <Label>NEXT</Label>
            <h2 className="ui-title-l">{next.title}</h2>
            <p className="ui-body muted">{next.body}</p>
            <div className="row">{next.action}</div>
          </section>

          <section className="stack-m" aria-label="Rooms">
            <div className="row row--between">
              <h2 className="ui-title-m">Rooms</h2>
              <span className="ui-body-s muted">
                {progress.filmed} filmed · {progress.skipped} skipped · {progress.notStarted} not started
              </span>
            </div>
            <div className="segbar" style={{ gridTemplateColumns: `repeat(${progress.total}, minmax(0, 1fr))` }} aria-hidden="true">
              {site.rooms.map((r) => {
                const v = current.rooms.get(r.id);
                const s = v?.analysis.status === 'running' ? 'running' : (v?.status ?? 'not_started');
                return <i key={r.id} data-s={s} />;
              })}
            </div>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th scope="col">Room</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Clip
                    </th>
                    <th scope="col" className="num">
                      Lines
                    </th>
                    <th scope="col">
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {site.rooms.map((r) => {
                    const v = current.rooms.get(r.id);
                    const lines = current.lines.filter((l) => l.roomId === r.id && (l.status === 'proposed' || l.status === 'accepted'));
                    const job = jobs.find((j) => j.roomId === r.id && j.walkId === current.walk.id && j.phase === 'running');
                    const waiting = v?.status === 'filmed' && (v.analysis.status === 'waiting' || v.analysis.status === 'failed');
                    return (
                      <tr key={r.id}>
                        <td>
                          <div className="stack-xs">
                            <span className="ui-body-strong">{r.name}</span>
                            <span className="ui-body-s muted">
                              {v?.status === 'skipped' ? `Skipped: ${v.skipReason}` : `${r.floor}${r.note ? ` · ${r.note}` : ''}`}
                            </span>
                          </div>
                        </td>
                        <td>{job ? <span className="ui-body-s">Processing on this device…</span> : <RoomStatus status={v?.status ?? 'not_started'} analysis={v?.analysis.status ?? 'idle'} refilm={Boolean(v?.refilmRequested)} />}</td>
                        <td className="num">{v?.clip ? duration(v.clip.durationS) : ''}</td>
                        <td className="num">{lines.length || ''}</td>
                        <td style={{ textAlign: 'right' }}>
                          {waiting && canRecognise(rt) && !job ? (
                            <Btn
                              variant="quiet"
                              icon="refresh"
                              style={{ minHeight: 36 }}
                              onClick={() => {
                                const room = site.rooms.find((x) => x.id === r.id);
                                if (room) void recogniseStoredRoom({ rt, site, bundle: current, room, personId, corrections: data.corrections });
                              }}
                            >
                              Run recognition
                            </Btn>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="stack-l">
          <section className="kpis" aria-label="This walk in numbers">
            <div>
              <span className="data-l">{live.length}</span>
              <span className="ui-body-s muted">lines proposed</span>
            </div>
            <div>
              <span className="data-l">{decided}</span>
              <span className="ui-body-s muted">decided</span>
            </div>
            <div>
              <span className="data-l">{register?.lines.length ?? 0}</span>
              <span className="ui-body-s muted">lines in the books</span>
            </div>
          </section>

          {previous ? (
            <section className="panel panel--tight stack-s" aria-label="Previous walk">
              <Label>COMPARED AGAINST</Label>
              <span className="ui-body-strong">Walk of {fmtDate(previous.walk.startedAt)}</span>
              <span className="ui-body-s muted">
                Filmed by {personName(site, previous.walk.capturedBy[0])}, approved by {personName(site, previous.walk.approvedBy)}. {approvedLines(previous).length} approved lines across{' '}
                {previous.rooms.size} rooms.{previous.walk.demoHistory ? ' Demo history.' : ''}
              </span>
            </section>
          ) : null}

          {summaries.length ? (
            <section className="stack-s" aria-label="Message summaries">
              <Label>WHATSAPP SUMMARY</Label>
              {summaries.map((s) => (
                <div key={s} className="dms-msg">
                  {s}
                  <span className="dms-msg__time">counts and a link only</span>
                </div>
              ))}
              <span className="ui-body-s muted">Preview of what the site group would receive: counts and a link that needs sign-in. No photos, no values.</span>
            </section>
          ) : null}

          {(site.cameras ?? []).length ? (
            <section className="panel panel--tight stack-s" aria-label="Cameras">
              <Label>CAMERAS</Label>
              <span className="ui-body-s muted">
                {plural((site.cameras ?? []).length, 'camera is', 'cameras are')} linked to rooms. A camera check takes one still and shows which recorded items it can see, between walks.
              </span>
              <a href="#cameras" className="ui-body-s">
                Check the cameras
              </a>
            </section>
          ) : null}

          {!site.demo ? (
            <section className="panel panel--tight stack-s" aria-label="Site setup">
              <Label>SITE SETUP</Label>
              <span className="ui-body-s muted">
                {plural(site.rooms.length, 'room', 'rooms')}, {plural(site.people.length, 'person', 'people')}, {register ? `register of ${plural(register.lines.length, 'line', 'lines')}` : 'no register yet'}.
              </span>
              <a href="#site" className="ui-body-s">
                Change rooms, people or the register
              </a>
            </section>
          ) : null}

          {site.demo ? (
          <section className="panel panel--tight stack-s" aria-label="Demo">
            <Label>DEMO</Label>
            <p className="ui-body-s muted">
              Open this page on your phone as Tolu to film, and on a laptop as Chinedu to review. Rooms with sample footage can be filmed from a laptop too.
            </p>
            {confirmReset ? (
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
            )}
          </section>
          ) : null}

          <a href="#verify" className="ui-body-s" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="verified" size={16} />
            Check a report's verification code
          </a>
        </aside>
      </div>
    </main>
  );
}
