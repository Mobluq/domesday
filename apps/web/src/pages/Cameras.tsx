import { useState, type ReactElement } from 'react';
import { runCameraCheck, useRunningChecks } from '../capture/camera-check';
import { newId } from '../data/actions';
import { categoryName, fmtDayMonth, fmtTime, personName, plural, roomName } from '../data/derive';
import { useData, usePersona, useToast } from '../data/store';
import type { CameraCheck, CameraDef } from '../data/types';
import { urlFor } from '../runtime/media';
import type { Json } from '../runtime/types';
import { Btn, Chip, EvidenceFrame, Note } from '../ui/bits';
import { Icon } from '../ui/icons';

const SCHEDULE: Record<CameraDef['schedule'], string> = { off: 'No schedule', nightly: 'One still nightly at 02:00', 'every-4-hours': 'One still every 4 hours' };

/** The latest check for a camera. */
export function latestCheck(checks: readonly CameraCheck[], cameraId: string): CameraCheck | null {
  return checks.find((c) => c.cameraId === cameraId && c.status === 'done') ?? null;
}

/** The most recent sighting of a register line or approved line on any camera. */
export function cameraSighting(checks: readonly CameraCheck[], ref: { registerId?: string | null; lineId?: string | null }) {
  for (const c of checks) {
    const s = c.sightings.find((x) => (ref.registerId && x.registerId === ref.registerId) || (ref.lineId && x.lineId === ref.lineId));
    if (s) return { check: c, sighting: s };
  }
  return null;
}

/**
 * On a not-seen row: what the room's camera last showed for this item, or a link to check it.
 * The camera can only say visible or not visible from where it hangs, never missing.
 */
export function CameraHint({ roomId, registerId, lineId }: { roomId: string | null | undefined; registerId?: string | null; lineId?: string | null }): ReactElement | null {
  const { site, cameraChecks } = useData();
  if (!site || !roomId) return null;
  const cams = (site.cameras ?? []).filter((c) => c.roomId === roomId);
  if (!cams.length) return null;
  const hit = cameraSighting(
    cameraChecks.filter((c) => c.roomId === roomId),
    { registerId, lineId },
  );
  const cam = hit ? cams.find((c) => c.id === hit.check.cameraId) : cams[0];
  if (hit && cam) {
    const visible = hit.sighting.status === 'visible';
    return (
      <a href="#cameras" className="cam-hint" data-visible={visible || undefined}>
        <Icon name="camera" size={16} />
        {cam.name}, {fmtDayMonth(hit.check.capturedAt)} {fmtTime(hit.check.capturedAt)}: {visible ? 'visible in the still' : 'not visible from this camera'}
      </a>
    );
  }
  return (
    <a href="#cameras" className="cam-hint">
      <Icon name="camera" size={16} />
      Check {cam?.name ?? 'the camera'}
    </a>
  );
}

function CheckView({ check }: { check: CameraCheck }): ReactElement {
  const { site } = useData();
  const visible = check.sightings.filter((s) => s.status === 'visible');
  const notVisible = check.sightings.filter((s) => s.status === 'not_visible');
  const fresh = check.sightings.filter((s) => s.status === 'new');
  return (
    <div className="stack-m">
      {check.still ? (
        <EvidenceFrame
          src={urlFor(check.still.ref)}
          alt={`Camera still of ${roomName(site, check.roomId)}`}
          imageW={check.still.w}
          imageH={check.still.h}
          aspect={check.still.w / check.still.h}
          regions={visible.filter((s) => s.box).map((s) => ({ box: s.box as [number, number, number, number], read: categoryName(site, s.categoryId) }))}
          tc={`${fmtDayMonth(check.capturedAt)} · ${fmtTime(check.capturedAt)}`}
        />
      ) : null}
      <div className="stack-s">
        {visible.map((s, i) => (
          <div key={`v${i}`} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
            <Chip status="confirmed" quiet>
              Visible
            </Chip>
            <span className="ui-body">{s.description}</span>
            {s.note ? <span className="ui-body-s muted">{s.note}</span> : null}
          </div>
        ))}
        {notVisible.map((s, i) => (
          <div key={`n${i}`} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
            <Chip status="not-filmed" quiet>
              Not visible from this camera
            </Chip>
            <span className="ui-body">{s.description}</span>
          </div>
        ))}
        {fresh.map((s, i) => (
          <div key={`f${i}`} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
            <Chip status="new" quiet>
              Also in view
            </Chip>
            <span className="ui-body">{s.description}</span>
          </div>
        ))}
      </div>
      <span className="ui-body-s muted">
        {check.note ? `${check.note} ` : ''}
        {check.blurred ? `${plural(check.blurred, 'face or screen was', 'faces or screens were')} blurred. ` : ''}
        Fingerprint sha256 {check.sha256.slice(0, 10)}… · checked by {personName(site, check.by)} · {check.source === 'sample' ? 'sample still' : check.source === 'import' ? 'imported from the recorder' : 'sent by the gateway'}.
      </span>
    </div>
  );
}

function CameraCard({ camera }: { camera: CameraDef }): ReactElement {
  const data = useData();
  const { site, cameraChecks } = data;
  const { personId } = usePersona();
  const { say } = useToast();
  const running = useRunningChecks().find((r) => r.cameraId === camera.id);
  const [history, setHistory] = useState(false);
  const latest = latestCheck(cameraChecks, camera.id);
  const past = cameraChecks.filter((c) => c.cameraId === camera.id && c.id !== latest?.id);

  const run = async (file: Blob, source: CameraCheck['source']): Promise<void> => {
    const r = await runCameraCheck(data, camera, { file, source, capturedAt: new Date().toISOString() }, personId);
    say(r.message, r.ok ? 'ok' : 'error');
  };

  return (
    <section className="panel stack-m" aria-label={`${camera.name}, ${roomName(site, camera.roomId)}`}>
      <div className="row row--between" style={{ alignItems: 'flex-start' }}>
        <div className="stack-xs">
          <span className="ui-title-m">
            {camera.name} · {roomName(site, camera.roomId)}
          </span>
          <span className="ui-body-s muted">
            {camera.brand} · {camera.connection === 'gateway' ? 'through the on-site gateway' : 'stills imported from the recorder'} · {SCHEDULE[camera.schedule]}
          </span>
        </div>
        {latest ? (
          <span className="ui-body-s muted">
            Last check {fmtDayMonth(latest.capturedAt)}, {fmtTime(latest.capturedAt)}
          </span>
        ) : (
          <span className="ui-body-s muted">Not checked yet</span>
        )}
      </div>
      {running ? (
        <Note icon="clock">{running.stage}…</Note>
      ) : latest ? (
        <CheckView check={latest} />
      ) : (
        <p className="ui-body-s muted">Run a check to see which of the room's recorded items this camera can see.</p>
      )}
      <div className="row">
        {camera.sampleStill ? (
          <Btn
            variant="primary"
            icon="refresh"
            disabled={Boolean(running)}
            onClick={async () => {
              try {
                const res = await fetch(camera.sampleStill as string);
                if (!res.ok) throw new Error(String(res.status));
                await run(await res.blob(), 'sample');
              } catch {
                say('The sample still did not load.', 'error');
              }
            }}
          >
            Check now with the sample still
          </Btn>
        ) : null}
        <label className="dms-btn dms-btn--secondary" style={{ position: 'relative' }} aria-disabled={Boolean(running)}>
          <Icon name="upload" />
          Import a still or recorder export
          <input
            id={`import-${camera.id}`}
            type="file"
            accept="image/*,video/mp4,video/webm,video/quicktime"
            style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
            disabled={Boolean(running)}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void run(f, 'import');
            }}
          />
        </label>
        {past.length ? (
          <Btn variant="quiet" onClick={() => setHistory((h) => !h)}>
            {history ? 'Hide earlier checks' : `Earlier checks (${past.length})`}
          </Btn>
        ) : null}
      </div>
      {history ? (
        <div className="stack-l">
          {past.map((c) => (
            <div key={c.id} className="stack-s" style={{ borderTop: '1px solid var(--rule)', paddingTop: 16 }}>
              <span className="ui-body-strong">
                {fmtDayMonth(c.capturedAt)}, {fmtTime(c.capturedAt)}
              </span>
              <CheckView check={c} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function CamerasPage(): ReactElement {
  const { site, rt } = useData();
  const { say } = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [brand, setBrand] = useState('');
  const [connection, setConnection] = useState<CameraDef['connection']>('gateway');
  const [schedule, setSchedule] = useState<CameraDef['schedule']>('nightly');
  if (!site) return <main className="page" />;
  const cameras = site.cameras ?? [];
  return (
    <main className="page">
      <div className="page-head">
        <div className="page-head__text">
          <p className="kicker">{site.name} · Cameras</p>
          <h1 className="display-m">Camera checks between walks</h1>
          <p className="ui-body muted">
            The cameras a site already has, linked to rooms. Each check takes one still and asks which of the room's recorded items can be seen. It is useful for rooms that are
            locked or rarely filmed, and for following up an item that was not seen on a walk.
          </p>
        </div>
        <div className="page-head__actions">
          <Btn icon="plus" onClick={() => setAdding((a) => !a)}>
            Link a camera
          </Btn>
        </div>
      </div>

      <div style={{ paddingBottom: 20 }}>
        <Note icon="shield">
          Spaces, not people. Domesday takes stills, never live video or sound. Faces and screens are blurred before anyone sees a still, nobody can search for a person, and an item
          that can't be seen is "not visible from this camera", never missing. In this demo the on-site gateway isn't connected, so checks use a camera's sample still or a file
          exported from the recorder.
        </Note>
      </div>

      {adding ? (
        <form
          className="panel stack-m"
          style={{ marginBottom: 20 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim() || !roomId) return;
            const cam: CameraDef = { id: newId('cam'), name: name.trim(), roomId, brand: brand.trim() || 'IP camera', connection, schedule, sampleStill: null };
            await rt.db.doc('site/main').update({ cameras: [...cameras, cam] } as unknown as Json);
            say(`${cam.name} linked to ${roomName(site, roomId)}`);
            setAdding(false);
            setName('');
            setBrand('');
          }}
        >
          <h2 className="ui-title-m">Link a camera</h2>
          <div className="form-grid">
            <label className="field">
              <span>Name on the recorder</span>
              <input id="cam-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="CAM 04" />
            </label>
            <label className="field">
              <span>Room it looks at</span>
              <select id="cam-room" className="select" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                <option value="">Choose a room</option>
                {site.rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Camera or recorder</span>
              <input id="cam-brand" className="input" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="IP camera on the NVR, channel 4" />
            </label>
            <label className="field">
              <span>How stills arrive</span>
              <select id="cam-connection" className="select" value={connection} onChange={(e) => setConnection(e.target.value as CameraDef['connection'])}>
                <option value="gateway">On-site gateway (RTSP or ONVIF)</option>
                <option value="import">Imported from the recorder by hand</option>
              </select>
            </label>
            <label className="field">
              <span>Schedule</span>
              <select id="cam-schedule" className="select" value={schedule} onChange={(e) => setSchedule(e.target.value as CameraDef['schedule'])}>
                <option value="nightly">One still nightly at 02:00</option>
                <option value="every-4-hours">One still every 4 hours</option>
                <option value="off">No schedule</option>
              </select>
            </label>
          </div>
          <div className="row">
            <Btn variant="primary" type="submit" disabled={!name.trim() || !roomId}>
              Link the camera
            </Btn>
            <Btn variant="quiet" onClick={() => setAdding(false)}>
              Cancel
            </Btn>
          </div>
        </form>
      ) : null}

      {cameras.length === 0 ? (
        <section className="panel stack-s" style={{ marginBottom: 48 }}>
          <h2 className="ui-title-m">No cameras linked yet</h2>
          <p className="ui-body muted">Link the cameras that look at stores, plant rooms and other places with valuable assets.</p>
        </section>
      ) : (
        <div className="stack-l" style={{ paddingBottom: 48 }}>
          {cameras.map((c) => (
            <CameraCard key={c.id} camera={c} />
          ))}
        </div>
      )}
    </main>
  );
}
