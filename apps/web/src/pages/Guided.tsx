import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { cameraAvailable, LiveCamera } from '../capture/live-camera';
import { clearJob, processRoom, useJobs, type Job } from '../capture/pipeline';
import { skipRoom } from '../data/actions';
import { plural } from '../data/derive';
import { useData, usePersona, useToast } from '../data/store';
import type { RoomDef } from '../data/types';
import { go } from '../route';
import { Hallmark } from '../ui/brand';
import { Icon } from '../ui/icons';

/**
 * Guided capture: one room at a time, big buttons, nothing else on screen. Made to be locked
 * in place with Guided Access (iPhone) or screen pinning (Android) and handed to whoever walks.
 */

const SKIP_REASONS = ['Locked, no key on site', 'Occupied right now', 'Unsafe to enter', 'Under renovation'];
const HINT_KEY = 'domesday.guided.hint-dismissed';
const HOLD_MS = 1500;

function stageOf(job: Job): string {
  const s = job.steps;
  if (job.phase === 'done') return `${plural(job.linesProposed ?? 0, 'item', 'items')} found`;
  if (job.phase === 'waiting') return 'Saved. Recognition will run later';
  if (job.phase === 'failed') return job.message ?? 'Something went wrong';
  if (s.store.state === 'doing') return 'Saving';
  if (s.privacy.state === 'doing') return 'Blurring faces and screens';
  if (s.recognise.state === 'doing') return job.found > 0 ? `Claude is reading the room: ${plural(job.found, 'item', 'items')} so far` : 'Claude is reading the room';
  if (s.frames.state === 'doing') return 'Picking the clearest frames';
  return 'Taking the fingerprint';
}

function useWakeLock(): void {
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    let gone = false;
    const ask = async (): Promise<void> => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === 'visible') lock = await wl.request('screen');
        if (gone && lock) void lock.release();
      } catch {
        // The screen may dim; capture still works.
      }
    };
    void ask();
    const onVis = (): void => {
      if (document.visibilityState === 'visible') void ask();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', onVis);
      if (lock) void lock.release();
    };
  }, []);
}

/** Press and hold to leave, so a tap in a pocket or by a curious child doesn't end the walk. */
function HoldToExit(): ReactElement {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);
  const stop = (): void => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  return (
    <button
      type="button"
      className="hold-exit"
      data-holding={holding || undefined}
      style={{ '--hold': `${HOLD_MS}ms` } as CSSProperties}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setHolding(true);
        timer.current = window.setTimeout(() => {
          stop();
          go('capture');
        }, HOLD_MS);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if (e.key === 'Escape') go('capture');
      }}
      aria-label="Hold to leave guided capture"
    >
      <span className="hold-exit__ring" aria-hidden="true" />
      {holding ? 'Keep holding…' : 'Hold to exit'}
    </button>
  );
}

export function GuidedCapture(): ReactElement {
  const { rt, site, current, corrections } = useData();
  const { personId, person } = usePersona();
  const { say } = useToast();
  const jobs = useJobs();
  const [focus, setFocus] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [canFilm, setCanFilm] = useState(false);
  useEffect(() => {
    let on = true;
    void cameraAvailable().then((a) => {
      if (on) setCanFilm(a === 'ok');
    });
    return () => {
      on = false;
    };
  }, []);
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) !== '1';
    } catch {
      return true;
    }
  });
  useWakeLock();

  if (!site || !current) return <main className="guided" />;
  const walkJobs = jobs.filter((j) => j.walkId === current.walk.id);
  const running = (roomId: string): boolean => walkJobs.some((j) => j.roomId === roomId && j.phase === 'running');
  const todo = site.rooms.filter((r) => {
    const v = current.rooms.get(r.id);
    return (!v || v.status === 'not_started' || Boolean(v.refilmRequested)) && !running(r.id);
  });
  const doneCount = site.rooms.length - todo.length;
  const focusJob = focus ? walkJobs.find((j) => j.roomId === focus) : undefined;
  const room: RoomDef | undefined = focusJob ? site.rooms.find((r) => r.id === focusJob.roomId) : todo[0];
  const approved = current.walk.status === 'approved';
  const pending = walkJobs.filter((j) => j.phase === 'running');

  const next = (): void => {
    if (focusJob && focusJob.phase !== 'running') clearJob(focusJob.key);
    setFocus(null);
    setSkipping(false);
    setReason(null);
  };

  const start = async (file: Blob, fileName: string, source: 'camera' | 'sample', recordedAt: string | null, labels: Blob[] = []): Promise<void> => {
    if (!room) return;
    setFocus(room.id);
    await processRoom({ rt, site, bundle: current, room, personId, corrections }, { file, fileName, source, labelShots: labels, recordedAt });
  };

  const startSample = async (): Promise<void> => {
    if (!room?.sample) return;
    setBusy(true);
    try {
      const mp4 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.4D401F"') !== '';
      const path = !mp4 && room.sample.webm ? room.sample.webm : room.sample.video;
      const res = await fetch(path);
      if (!res.ok) throw new Error(`The sample clip did not load (${res.status}).`);
      const blob = await res.blob();
      const labels: Blob[] = [];
      for (const p of room.sample.labelShots) {
        const r = await fetch(p);
        if (r.ok) labels.push(await r.blob());
      }
      const fileName = path.split('/').pop() ?? 'sample.mp4';
      await start(new File([blob], fileName, { type: path.endsWith('.webm') ? 'video/webm' : 'video/mp4' }), fileName, 'sample', null, labels);
    } catch (err) {
      say(String((err as Error).message ?? err), 'error');
    } finally {
      setBusy(false);
    }
  };

  let body: ReactElement;
  if (approved) {
    body = (
      <div className="guided__centre">
        <span className="guided__done" aria-hidden="true">
          <Icon name="found" size={56} />
        </span>
        <h1 className="guided__title">This walk is approved</h1>
        <p className="guided__lead">Filming is closed until the next walk starts.</p>
      </div>
    );
  } else if (!site.rooms.length) {
    body = (
      <div className="guided__centre">
        <h1 className="guided__title">No rooms yet</h1>
        <p className="guided__lead">Ask whoever set up the site to add the rooms in Site setup.</p>
      </div>
    );
  } else if (focusJob && room) {
    const finished = focusJob.phase !== 'running';
    body = (
      <div className="guided__centre">
        <span className="guided__kicker">{room.floor}</span>
        <h1 className="guided__title">{room.name}</h1>
        <div className="guided__status" role="status" aria-live="polite" data-phase={focusJob.phase}>
          {finished ? <Icon name={focusJob.phase === 'done' ? 'found' : 'info'} size={28} /> : <span className="spinner" aria-hidden="true" />}
          <span>{stageOf(focusJob)}</span>
        </div>
        {focusJob.clip?.checks.length ? <p className="guided__lead">{focusJob.clip.checks.map((c) => c.message).join(' ')}</p> : null}
        {!finished ? <p className="guided__lead">You can film the next room while this one is read.</p> : null}
        <button type="button" className="guided__big" onClick={next}>
          <Icon name="next" size={28} />
          {todo.length ? `Next room: ${todo[0]?.name}` : 'Finish'}
        </button>
      </div>
    );
  } else if (!room) {
    body = (
      <div className="guided__centre">
        <span className="guided__done" aria-hidden="true">
          <Icon name="found" size={56} />
        </span>
        <h1 className="guided__title">{pending.length ? 'Last rooms are being read' : 'Every room is done'}</h1>
        <p className="guided__lead">
          {pending.length
            ? `Keep this screen open for a moment: ${pending.map((j) => site.rooms.find((r) => r.id === j.roomId)?.name).join(' and ')} ${pending.length === 1 ? 'is' : 'are'} still being read.`
            : 'Thank you. A reviewer checks what was found on their own device. You can hand the phone back.'}
        </p>
      </div>
    );
  } else if (skipping) {
    body = (
      <div className="guided__centre">
        <span className="guided__kicker">Skip {room.name}</span>
        <h1 className="guided__title">Why can't it be filmed?</h1>
        <div className="guided__choices" role="radiogroup" aria-label="Reason">
          {SKIP_REASONS.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={reason === r} className="guided__choice" onClick={() => setReason(r)}>
              {r}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="guided__big"
          disabled={!reason}
          onClick={async () => {
            if (!reason) return;
            await skipRoom(rt, current, room.id, reason, personId);
            say(`${room.name} skipped`);
            next();
          }}
        >
          <Icon name="minus" size={28} />
          Skip {room.name}
        </button>
        <button type="button" className="guided__quiet" onClick={() => setSkipping(false)}>
          Go back and film it
        </button>
      </div>
    );
  } else {
    body = (
      <div className="guided__centre">
        <span className="guided__kicker">
          Room {doneCount + 1} of {site.rooms.length} · {room.floor}
        </span>
        <h1 className="guided__title">{room.name}</h1>
        <p className="guided__lead">Two slow sweeps: one at shoulder height, one lower down. About a minute.</p>
        {live ? (
          <LiveCamera
            roomName={room.name}
            expectedSeconds={room.sample?.seconds ?? 60}
            onCancel={() => setLive(false)}
            onFallback={(why) => {
              setLive(false);
              setCanFilm(false);
              say(`${why} Use the phone's camera instead.`, 'error');
            }}
            onDone={(r) => {
              setLive(false);
              void start(r.clip, r.fileName, 'camera', r.startedAt, r.labelShots);
            }}
          />
        ) : null}
        {canFilm ? (
          <button type="button" className="guided__big guided__big--record" onClick={() => setLive(true)}>
            <Icon name="camera" size={30} />
            Film this room
          </button>
        ) : (
          <label className="guided__big guided__big--record">
            <Icon name="camera" size={30} />
            Film this room
            <input
              type="file"
              accept="video/*"
              capture="environment"
              aria-label={`Film ${room.name}`}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void start(f, f.name || `${room.name}.mp4`, 'camera', f.lastModified ? new Date(f.lastModified).toISOString() : null);
              }}
            />
          </label>
        )}
        {room.sample ? (
          <button type="button" className="guided__second" disabled={busy} onClick={() => void startSample()}>
            <Icon name="play" size={22} />
            {busy ? 'Loading the sample…' : 'Use the sample footage'}
          </button>
        ) : null}
        <button type="button" className="guided__quiet" onClick={() => setSkipping(true)}>
          I can't film this room
        </button>
      </div>
    );
  }

  return (
    <main className="guided">
      <header className="guided__bar">
        <span className="guided__brand">
          <Hallmark size={24} />
          <span>{site.name}</span>
        </span>
        <span className="guided__progress" aria-label={`${doneCount} of ${site.rooms.length} rooms done`}>
          {site.rooms.map((r) => {
            const v = current.rooms.get(r.id);
            const s = running(r.id) ? 'running' : (v?.status ?? 'not_started');
            return <i key={r.id} data-s={s} />;
          })}
        </span>
      </header>

      {hint && !approved ? (
        <aside className="guided__hint" aria-label="Lock this screen">
          <Icon name="shield" size={20} />
          <span>
            <strong>Lock the phone to this screen.</strong> iPhone: turn on Guided Access in Settings, Accessibility, then triple-click the side button. Android: turn on App pinning in
            Settings, Security, then pin this app from the recent apps view.
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setHint(false);
              try {
                localStorage.setItem(HINT_KEY, '1');
              } catch {
                // fine
              }
            }}
          >
            <Icon name="reject" size={18} />
          </button>
        </aside>
      ) : null}

      {body}

      <footer className="guided__foot">
        <span className="guided__who">Filming as {person?.name ?? 'someone not chosen yet'}</span>
        {pending.length && !(focusJob && focusJob.phase === 'running' && pending.length === 1) ? (
          <span className="guided__who">
            {plural(pending.length, 'room', 'rooms')} being read: {pending.map((j) => site.rooms.find((r) => r.id === j.roomId)?.name).join(', ')}
          </span>
        ) : null}
        <HoldToExit />
      </footer>
    </main>
  );
}

