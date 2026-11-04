import { UI_COPY } from '@domesday/domain';
import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { cameraAvailable, LiveCamera } from '../capture/live-camera';
import { clearJob, jobKey, processRoom, recogniseStoredRoom, stopJob, useJobs, canRecognise, type Job, type StepId } from '../capture/pipeline';
import { addRoom, skipRoom, unskipRoom } from '../data/actions';
import { duration, fmtDate, fmtDayMonth, fmtTime, megabytes, personName, plural, timecode, walkProgress } from '../data/derive';
import { useData, usePersona, useToast } from '../data/store';
import type { RoomDef, RoomVisit } from '../data/types';
import { urlFor } from '../runtime/media';
import { go } from '../route';
import { Btn, EvidenceFrame, Fingerprint, Label, Note } from '../ui/bits';
import { Icon } from '../ui/icons';

const STEP_LABEL: Record<StepId, string> = {
  fingerprint: 'Fingerprint the clip',
  frames: 'Pick the sharpest frames',
  recognise: 'Claude proposes asset lines',
  privacy: 'Blur faces, screens and documents',
  store: 'Save to the walk',
};

const SKIP_REASONS = ['Locked, no key on site', 'Occupied, guest in the room', 'Unsafe to enter', 'Under renovation'];

function roomSub(v: RoomVisit | undefined, job: Job | undefined): string {
  if (job?.phase === 'running') return 'Processing on this device…';
  if (!v || v.status === 'not_started') return v?.refilmRequested ? `Refilm requested: ${v.refilmRequested.reason}` : 'Not started';
  if (v.status === 'skipped') return `Skipped: ${v.skipReason ?? ''}`;
  if (v.refilmRequested) return `Refilm requested: ${v.refilmRequested.reason}`;
  if (v.analysis.status === 'running') return 'Filmed · Claude is looking';
  if (v.analysis.status === 'waiting') return 'Filmed · waiting for recognition';
  if (v.analysis.status === 'failed') return 'Filmed · recognition failed';
  return `Filmed · ${plural(v.analysis.linesProposed ?? 0, 'line', 'lines')} proposed`;
}

function RoomList({ onPick }: { onPick: (id: string) => void }): ReactElement {
  const { site, current, previous, rt } = useData();
  const { personId } = usePersona();
  const { say } = useToast();
  const jobs = useJobs();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [floor, setFloor] = useState('');
  if (!site || !current) return <div />;
  const progress = walkProgress(site, current);
  const nextRoom = site.rooms.find((r) => {
    const v = current.rooms.get(r.id);
    return !v || v.status === 'not_started' || Boolean(v.refilmRequested);
  });
  return (
    <>
      <div className="capture-head">
        <div className="stack-xs">
          <Label>MONTHLY WALK · {current.walk.startedAt ? fmtDate(current.walk.startedAt).toUpperCase() : 'NOT STARTED'}</Label>
          <h1 className="ui-title-l">{site.name}</h1>
          {previous ? (
            <span className="ui-body-s muted">
              Last walked {fmtDayMonth(previous.walk.startedAt)} by {personName(site, previous.walk.capturedBy[0])}
            </span>
          ) : null}
        </div>
        <div className="stack-s">
          <div className="row row--between">
            <span className="ui-body-strong">
              {progress.filmed} of {progress.total} rooms filmed
            </span>
            <span className="data-s muted">{progress.skipped ? `${progress.skipped} skipped` : ''}</span>
          </div>
          <div className="segbar" style={{ gridTemplateColumns: `repeat(${progress.total}, minmax(0, 1fr))` }} aria-hidden="true">
            {site.rooms.map((r) => {
              const v = current.rooms.get(r.id);
              return <i key={r.id} data-s={v?.analysis.status === 'running' ? 'running' : (v?.status ?? 'not_started')} />;
            })}
          </div>
        </div>
      </div>

      <section className="panel panel--tight stack-s" aria-label="How to film a room">
        <div className="row" style={{ gap: 10 }}>
          <Icon name="walk" />
          <span className="ui-body-strong">Two slow sweeps per room</span>
        </div>
        <span className="ui-body-s muted">
          One at shoulder height around the walls, one lower for items under desks and in corners. Take a label shot of any nameplate, serial plate or asset tag. About a minute
          a room.
        </span>
        <span className="ui-body-s muted">
          Filming as <strong>{personName(site, personId)}</strong>. Whoever films a room can't approve its lines.
        </span>
      </section>

      <section aria-label="Rooms" style={{ paddingTop: 18 }}>
        <Label>ROOMS</Label>
        <ul className="dms-rooms">
          {site.rooms.map((r) => {
            const v = current.rooms.get(r.id);
            const job = jobs.find((j) => j.key === jobKey(current.walk.id, r.id));
            const state = v?.status === 'filmed' ? 'filmed' : v?.status === 'skipped' ? 'skipped' : 'todo';
            return (
              <li
                key={r.id}
                className="dms-room"
                data-state={state}
                data-current={nextRoom?.id === r.id ? '' : undefined}
                onClick={() => onPick(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPick(r.id);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={`${r.name}: ${roomSub(v, job)}`}
              >
                <span className="dms-room__state">
                  {state === 'filmed' ? <Icon name="found" /> : state === 'skipped' ? <Icon name="minus" /> : null}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="dms-room__name">{r.name}</div>
                  <div className="dms-room__sub">{roomSub(v, job)}</div>
                </div>
                <span className="dms-room__meta">
                  {v?.clip ? (
                    <>
                      {duration(v.clip.durationS)}
                      <br />
                      {megabytes(v.clip.sizeBytes)}
                    </>
                  ) : (
                    <Icon name="next" />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="capture-foot">
        {current.walk.status === 'approved' ? (
          <Note icon="found">This walk is approved. Filming is closed.</Note>
        ) : nextRoom ? (
          <Btn variant="primary" capture icon="record" onClick={() => onPick(nextRoom.id)}>
            Film {nextRoom.name}
          </Btn>
        ) : (
          <Btn variant="primary" capture icon="found" onClick={() => go('review')}>
            All rooms done. Review the lines
          </Btn>
        )}
        {adding ? (
          <form
            className="stack-s panel panel--tight"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              const room = await addRoom(rt, site, current, name, floor);
              say(`${room.name} added to the walk`);
              setAdding(false);
              setName('');
              setFloor('');
              onPick(room.id);
            }}
          >
            <label className="field">
              <span>Room name</span>
              <input id="new-room-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Front office" autoFocus />
            </label>
            <label className="field">
              <span>Floor</span>
              <input id="new-room-floor" className="input" value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="Ground floor" />
            </label>
            <div className="row">
              <Btn variant="primary" type="submit" disabled={!name.trim()}>
                Add the room
              </Btn>
              <Btn variant="quiet" onClick={() => setAdding(false)}>
                Cancel
              </Btn>
            </div>
          </form>
        ) : current.walk.status !== 'approved' ? (
          <Btn variant="quiet" onClick={() => setAdding(true)}>
            Add a room that isn't listed
          </Btn>
        ) : null}
        {!canRecognise(rt) ? (
          <span className="ui-body-s muted" style={{ textAlign: 'center' }}>
            Claude can't look at images on this device, so recognition will run on your laptop.
          </span>
        ) : null}
      </div>
    </>
  );
}

function Processing({ job, room, onBack, onNext }: { job: Job; room: RoomDef; onBack: () => void; onNext: (() => void) | null }): ReactElement {
  const { rt, site, current, corrections } = useData();
  const { personId } = usePersona();
  const steps: StepId[] = ['fingerprint', 'frames', 'recognise', 'privacy', 'store'];
  const elapsed = useElapsed(job.phase === 'running' ? job.startedAt : null);
  return (
    <div className="stack-m" style={{ paddingTop: 20 }}>
      <div className="row row--between">
        <Btn variant="quiet" icon="back" onClick={onBack} style={{ marginLeft: -10 }}>
          Rooms
        </Btn>
        {job.phase === 'running' ? <span className="data-s muted">{elapsed}</span> : null}
      </div>
      <div className="stack-xs">
        <Label>{job.phase === 'running' ? 'PROCESSING ON THIS DEVICE' : job.phase === 'done' ? 'DONE' : job.phase === 'waiting' ? 'SAVED, WAITING FOR RECOGNITION' : 'STOPPED'}</Label>
        <h1 className="ui-title-l">{room.name}</h1>
        {job.clip ? (
          <span className="ui-body-s muted">
            {duration(job.clip.durationS)} · {megabytes(job.clip.sizeBytes)} · {job.clip.width}×{job.clip.height} · {job.clip.source === 'sample' ? 'sample footage' : job.clip.device}
          </span>
        ) : null}
      </div>

      {job.sha256 ? (
        <div className="row panel panel--tight" style={{ gap: 14 }}>
          <Fingerprint hex={job.sha256} />
          <div className="stack-xs" style={{ minWidth: 0 }}>
            <span className="ui-body-strong">Fingerprint taken on this device</span>
            <span className="data-s muted" style={{ overflowWrap: 'anywhere' }}>
              sha256 {job.sha256.slice(0, 12)}…{job.sha256.slice(-8)}
            </span>
          </div>
        </div>
      ) : null}

      <ol className="process" style={{ margin: 0, padding: 0 }}>
        {steps.map((id) => {
          const s = job.steps[id];
          return (
            <li key={id} data-state={s.state}>
              <span className="dot">{s.state === 'done' ? <Icon name="found" /> : s.state === 'failed' ? <Icon name="reject" /> : null}</span>
              <div className="stack-xs">
                <span className="ui-body-strong" style={{ fontWeight: s.state === 'todo' ? 400 : 700, color: s.state === 'todo' ? 'var(--text-secondary)' : undefined }}>
                  {STEP_LABEL[id]}
                </span>
                {s.state === 'doing' && s.progress !== undefined ? <span className="bar" style={{ maxWidth: 260 }}><span style={{ width: `${Math.round(s.progress * 100)}%` }} /></span> : null}
                {id === 'recognise' && s.state === 'doing' ? (
                  <span className="ui-body-s muted">
                    {job.found > 0 ? (
                      <>
                        <span className="found-count">{job.found}</span> {job.found === 1 ? 'item' : 'items'} so far
                      </>
                    ) : (
                      (s.detail ?? 'Thinking…')
                    )}
                  </span>
                ) : s.detail ? (
                  <span className="ui-body-s muted">{s.detail}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {job.clip?.checks.length ? (
        <Note tone="warn" icon="info">
          {job.clip.checks.map((c) => c.message).join(' ')}
        </Note>
      ) : null}

      {job.previews.length ? (
        <div className="thumbs" aria-label="Frames picked from the clip">
          {job.previews.map((p, i) => (
            <EvidenceFrame key={i} src={p.url} alt={p.label ? 'Label shot' : `Frame at ${timecode(p.t)}`} tc={p.label ? undefined : timecode(p.t)} tag={p.label ? 'Label' : undefined} />
          ))}
        </div>
      ) : null}

      {job.phase === 'running' ? (
        <Btn variant="quiet" icon="stop" onClick={() => stopJob(job.key)}>
          Stop
        </Btn>
      ) : null}
      {job.phase === 'done' ? (
        <div className="stack-s">
          <Note tone="ok" icon="found">
            {plural(job.linesProposed ?? 0, 'line', 'lines')} proposed for {room.name}. They're waiting in Review for a named person to decide each one.
          </Note>
          {onNext ? (
            <Btn variant="primary" capture icon="record" onClick={onNext}>
              Film the next room
            </Btn>
          ) : (
            <Btn variant="primary" capture icon="found" onClick={() => go('review')}>
              Review the lines
            </Btn>
          )}
        </div>
      ) : null}
      {job.phase === 'waiting' || job.phase === 'failed' ? (
        <div className="stack-s">
          <Note tone="warn" icon="info">
            {job.message ?? 'Recognition has not run yet.'}
          </Note>
          {canRecognise(rt) && site && current && job.steps.store.state === 'done' ? (
            <Btn
              variant="primary"
              icon="refresh"
              onClick={() => {
                clearJob(job.key);
                void recogniseStoredRoom({ rt, site, bundle: current, room, personId, corrections });
              }}
            >
              Run recognition again
            </Btn>
          ) : null}
          {onNext ? (
            <Btn icon="record" onClick={onNext}>
              Film the next room
            </Btn>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function useElapsed(since: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === null) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [since]);
  if (since === null) return '';
  const s = Math.floor((Date.now() - since) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function RoomScreen({ room, onBack, onNext }: { room: RoomDef; onBack: () => void; onNext: (() => void) | null }): ReactElement {
  const { rt, site, current, corrections } = useData();
  const { personId } = usePersona();
  const { say } = useToast();
  const jobs = useJobs();
  const [labels, setLabels] = useState<{ blob: Blob; url: string }[]>([]);
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refilm, setRefilm] = useState(false);
  const [live, setLive] = useState(false);
  const [canFilm, setCanFilm] = useState(false);
  const labelInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let on = true;
    void cameraAvailable().then((a) => {
      if (on) setCanFilm(a === 'ok');
    });
    return () => {
      on = false;
    };
  }, []);
  if (!site || !current) return <div />;
  const key = jobKey(current.walk.id, room.id);
  const job = jobs.find((j) => j.key === key);
  const visit = current.rooms.get(room.id);
  const approved = current.walk.status === 'approved';

  if (job) return <Processing job={job} room={room} onBack={onBack} onNext={onNext} />;

  const start = async (file: Blob, fileName: string, source: 'camera' | 'library' | 'sample', recordedAt: string | null, extraLabels: Blob[] = []): Promise<void> => {
    await processRoom({ rt, site, bundle: current, room, personId, corrections }, { file, fileName, source, labelShots: [...labels.map((l) => l.blob), ...extraLabels], recordedAt });
  };

  const onVideo = (source: 'camera' | 'library') => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void start(file, file.name || `${room.name}.mp4`, source, file.lastModified ? new Date(file.lastModified).toISOString() : null);
  };

  const startSample = async (): Promise<void> => {
    if (!room.sample) return;
    setBusy(true);
    try {
      const mp4 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.4D401F"') !== '';
      const path = !mp4 && room.sample.webm ? room.sample.webm : room.sample.video;
      const res = await fetch(path);
      if (!res.ok) throw new Error(`The sample clip did not load (${res.status}).`);
      const blob = await res.blob();
      const extra: Blob[] = [];
      for (const path of room.sample.labelShots) {
        const r = await fetch(path);
        if (r.ok) extra.push(await r.blob());
      }
      const fileName = path.split('/').pop() ?? 'sample.mp4';
      await start(new File([blob], fileName, { type: path.endsWith('.webm') ? 'video/webm' : 'video/mp4' }), fileName, 'sample', null, extra);
    } catch (err) {
      say(String((err as Error).message ?? err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const filmedAlready = visit?.status === 'filmed' && !refilm;
  return (
    <div className="stack-m" style={{ paddingTop: 20, paddingBottom: 24 }}>
      <div>
        <Btn variant="quiet" icon="back" onClick={onBack} style={{ marginLeft: -10 }}>
          Rooms
        </Btn>
      </div>
      <div className="stack-xs">
        <Label>{room.floor.toUpperCase()}</Label>
        <h1 className="ui-title-l">{room.name}</h1>
        {room.note ? <span className="ui-body-s muted">{room.note}</span> : null}
      </div>

      {visit?.refilmRequested ? (
        <Note tone="warn" icon="refresh">
          {personName(site, visit.refilmRequested.by)} asked for a refilm: {visit.refilmRequested.reason}
        </Note>
      ) : null}

      {filmedAlready && visit ? (
        <FilmedSummary visit={visit} room={room} onRefilm={approved ? null : () => setRefilm(true)} />
      ) : visit?.status === 'skipped' && !refilm ? (
        <div className="stack-s">
          <Note icon="not-filmed">Skipped: {visit.skipReason}</Note>
          {!approved ? (
            <Btn
              onClick={async () => {
                await unskipRoom(rt, current, room.id);
              }}
            >
              Film it after all
            </Btn>
          ) : null}
        </div>
      ) : approved ? (
        <Note icon="found">This walk is approved. Filming is closed.</Note>
      ) : (
        <>
          <div className="film-card">
            {room.sample ? <img src={room.sample.poster} alt="" /> : null}
            <span className="rec-notice" style={{ background: 'var(--camera-scrim)', padding: '6px 12px 6px 10px', borderRadius: 999, alignSelf: 'flex-start' }}>
              {UI_COPY.recordingNotice}
            </span>
            <div className="stack-xs">
              <span className="ui-capture">{room.name}</span>
              <span className="dms-cam__meta" style={{ color: 'var(--camera-text)' }}>
                Sweep 1 at shoulder height, sweep 2 lower down
              </span>
            </div>
          </div>

          {live ? (
            <LiveCamera
              roomName={room.name}
              expectedSeconds={room.sample?.seconds ?? 60}
              onCancel={() => setLive(false)}
              onFallback={(why) => {
                setLive(false);
                setCanFilm(false);
                say(`${why} Use your phone's camera instead.`, 'error');
              }}
              onDone={(r) => {
                setLive(false);
                void start(r.clip, r.fileName, 'camera', r.startedAt, r.labelShots);
              }}
            />
          ) : null}
          <div className="big-choices">
            {canFilm ? (
              <button type="button" className="choice choice--primary" onClick={() => setLive(true)}>
                <span className="choice__icon">
                  <Icon name="camera" />
                </span>
                <span className="stack-xs">
                  <span className="ui-body-strong">Record the room</span>
                  <span className="ui-body-s muted">Films in the app, with live labels on what it spots. Stop when both sweeps are done.</span>
                </span>
                <Icon name="next" />
              </button>
            ) : (
              <label className="choice choice--primary">
                <span className="choice__icon">
                  <Icon name="camera" />
                </span>
                <span className="stack-xs">
                  <span className="ui-body-strong">Record the room</span>
                  <span className="ui-body-s muted">Opens your camera. Stop when both sweeps are done.</span>
                </span>
                <Icon name="next" />
                <input id={`rec-${room.id}`} type="file" accept="video/*" capture="environment" onChange={onVideo('camera')} aria-label={`Record ${room.name}`} />
              </label>
            )}
            <label className="choice">
              <span className="choice__icon">
                <Icon name="clip" />
              </span>
              <span className="stack-xs">
                <span className="ui-body-strong">Choose a clip already on this phone</span>
                <span className="ui-body-s muted">A video of this room you filmed earlier</span>
              </span>
              <Icon name="next" />
              <input id={`pick-${room.id}`} type="file" accept="video/*" onChange={onVideo('library')} aria-label={`Choose a clip of ${room.name}`} />
            </label>
            {room.sample ? (
              <button type="button" className="choice" onClick={() => void startSample()} disabled={busy}>
                <span className="choice__icon">
                  <Icon name="play" />
                </span>
                <span className="stack-xs">
                  <span className="ui-body-strong">{busy ? 'Loading the sample…' : 'Use the sample footage'}</span>
                  <span className="ui-body-s muted">
                    {Math.round(room.sample.seconds)} seconds of {room.name}
                    {room.sample.labelShots.length ? `, with ${plural(room.sample.labelShots.length, 'label shot', 'label shots')}` : ''}. Works on a laptop.
                  </span>
                </span>
                <Icon name="next" />
              </button>
            ) : null}
          </div>

          <section className="stack-s" aria-label="Label shots">
            <div className="row row--between">
              <span className="ui-body-strong">Label shots</span>
              <Btn variant="quiet" icon="label-shot" onClick={() => labelInput.current?.click()} style={{ minHeight: 40 }}>
                Add a label shot
              </Btn>
              <input
                ref={labelInput}
                id={`label-${room.id}`}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) setLabels((l) => [...l, { blob: f, url: URL.createObjectURL(f) }]);
                }}
              />
            </div>
            {labels.length ? (
              <div className="thumbs">
                {labels.map((l, i) => (
                  <EvidenceFrame key={i} src={l.url} alt={`Label shot ${i + 1}`} tag="Label" />
                ))}
              </div>
            ) : (
              <span className="ui-body-s muted">Photograph nameplates, serial plates and asset tags up close. They go to Claude with the clip, so serials are read from the plate.</span>
            )}
          </section>

          {skipping ? (
            <form
              className="panel panel--tight stack-s"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!reason.trim()) return;
                await skipRoom(rt, current, room.id, reason, personId);
                say(`${room.name} skipped`);
                setSkipping(false);
                onBack();
              }}
            >
              <span className="ui-body-strong">Why is this room being skipped?</span>
              <div className="row">
                {SKIP_REASONS.map((r) => (
                  <Btn key={r} variant={reason === r ? 'primary' : 'secondary'} onClick={() => setReason(r)} style={{ minHeight: 40, fontWeight: 400 }}>
                    {r}
                  </Btn>
                ))}
              </div>
              <label className="field">
                <span>Reason</span>
                <input id={`skip-${room.id}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Locked, key with the chief engineer" />
              </label>
              <div className="row">
                <Btn variant="primary" type="submit" disabled={!reason.trim()}>
                  Skip {room.name}
                </Btn>
                <Btn variant="quiet" onClick={() => setSkipping(false)}>
                  Cancel
                </Btn>
              </div>
              <span className="ui-body-s muted">Nothing in a skipped room is called not seen. The report lists it as room not filmed.</span>
            </form>
          ) : (
            <Btn variant="quiet" icon="minus" onClick={() => setSkipping(true)}>
              Skip this room
            </Btn>
          )}
        </>
      )}
    </div>
  );
}

function FilmedSummary({ visit, room, onRefilm }: { visit: RoomVisit; room: RoomDef; onRefilm: (() => void) | null }): ReactElement {
  const { site, current, rt, corrections } = useData();
  const { personId } = usePersona();
  const lines = current ? current.lines.filter((l) => l.roomId === room.id && (l.status === 'proposed' || l.status === 'accepted')) : [];
  const hidden = visit.analysis.status !== 'done';
  return (
    <div className="stack-m">
      {visit.clip ? (
        <div className="row panel panel--tight" style={{ gap: 14 }}>
          <Fingerprint hex={visit.clip.sha256} />
          <div className="stack-xs" style={{ minWidth: 0 }}>
            <span className="ui-body-strong">
              Filmed by {personName(site, visit.filmedBy)} at {fmtTime(visit.filmedAt)}
            </span>
            <span className="data-s muted">
              {duration(visit.clip.durationS)} · {megabytes(visit.clip.sizeBytes)} · sha256 {visit.clip.sha256.slice(0, 10)}…
            </span>
          </div>
        </div>
      ) : null}
      {visit.analysis.status === 'done' ? (
        <Note tone="ok" icon="found">
          {plural(lines.length, 'line', 'lines')} proposed{visit.analysis.privacy && visit.analysis.privacy.faces + visit.analysis.privacy.screens + visit.analysis.privacy.documents > 0 ? '. Faces, screens or documents were blurred first' : ''}.
          {visit.analysis.note ? ` ${visit.analysis.note}` : ''}
        </Note>
      ) : (
        <Note tone="warn" icon="info">
          {visit.analysis.error ?? (visit.analysis.status === 'running' ? 'Claude is looking at the frames on another device.' : 'Waiting for recognition. Frames stay hidden until faces and screens are blurred.')}
        </Note>
      )}
      {!hidden && visit.frames.length ? (
        <div className="thumbs">
          {[...visit.frames, ...visit.labelShots].map((f) => (
            <EvidenceFrame key={f.id} src={urlFor(f.ref)} alt={f.label ? 'Label shot' : `Frame at ${timecode(f.t)}`} imageW={f.w} imageH={f.h} tc={f.label ? undefined : timecode(f.t)} tag={f.label ? 'Label' : undefined} />
          ))}
        </div>
      ) : null}
      <div className="row">
        {lines.length ? (
          <Btn variant="primary" icon="found" onClick={() => go('review')}>
            Review {room.name}
          </Btn>
        ) : null}
        {(visit.analysis.status === 'waiting' || visit.analysis.status === 'failed') && canRecognise(rt) && site && current ? (
          <Btn variant="primary" icon="refresh" onClick={() => void recogniseStoredRoom({ rt, site, bundle: current, room, personId, corrections })}>
            Run recognition
          </Btn>
        ) : null}
        {onRefilm ? (
          <Btn icon="record" onClick={onRefilm}>
            Film again
          </Btn>
        ) : null}
      </div>
      {visit.clip?.checks.length ? <span className="ui-body-s muted">{visit.clip.checks.map((c) => c.message).join(' ')}</span> : null}
    </div>
  );
}

export function CapturePage(): ReactElement {
  const { site, current } = useData();
  const jobs = useJobs();
  const [roomId, setRoomId] = useState<string | null>(null);
  if (!site || !current) return <main className="capture" />;
  const room = roomId ? (site.rooms.find((r) => r.id === roomId) ?? null) : null;
  const order = site.rooms.map((r) => r.id);
  const nextAfter = (id: string): string | null => {
    const i = order.indexOf(id);
    for (const rid of [...order.slice(i + 1), ...order.slice(0, i)]) {
      const v = current.rooms.get(rid);
      if (!v || v.status === 'not_started' || v.refilmRequested) return rid;
    }
    return null;
  };
  const next = room ? nextAfter(room.id) : null;
  const leave = (to: string | null): void => {
    if (room) {
      const key = jobKey(current.walk.id, room.id);
      const job = jobs.find((j) => j.key === key);
      if (job && job.phase !== 'running') clearJob(key);
    }
    setRoomId(to);
  };
  return (
    <main className="capture">
      {room ? (
        <RoomScreen key={room.id} room={room} onBack={() => leave(null)} onNext={next ? () => leave(next) : null} />
      ) : (
        <RoomList onPick={setRoomId} />
      )}
    </main>
  );
}
