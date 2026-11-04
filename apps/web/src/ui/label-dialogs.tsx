import { ConditionGrade, type ConditionGrade as Grade } from '@domesday/domain';
import { useMemo, useState, type ReactElement } from 'react';
import { addMissedLine, correctBox } from '../data/actions';
import { framesOf, lineTitle, timecode, type FrameHit } from '../data/derive';
import { useData, usePersona, useToast, type WalkBundle } from '../data/store';
import type { Box, Line } from '../data/types';
import { urlFor } from '../runtime/media';
import { Btn } from './bits';
import { BoxEditor } from './box-editor';

/** Frames of one room that a reviewer may see: only after the privacy pass has run. */
function roomFrames(bundle: WalkBundle, roomId: string): FrameHit[] {
  const visit = bundle.rooms.get(roomId);
  if (!visit || visit.analysis.status !== 'done') return [];
  return [...visit.frames, ...visit.labelShots].map((frame) => ({ frame, room: visit }));
}

function FramePicker({ frames, value, onPick }: { frames: FrameHit[]; value: string | null; onPick: (id: string) => void }): ReactElement {
  return (
    <div className="frame-pick" role="group" aria-label="Choose a frame">
      {frames.map((h) => (
        <button key={h.frame.id} type="button" aria-pressed={value === h.frame.id} onClick={() => onPick(h.frame.id)} aria-label={h.frame.label ? 'Label shot' : `Frame at ${timecode(h.frame.t)}`}>
          <img src={urlFor(h.frame.ref) ?? ''} alt="" />
        </button>
      ))}
    </div>
  );
}

/** An admin labels an item the recogniser missed: pick the frame, draw the box, say what it is. */
export function MissedItemDialog({ bundle, initialRoomId, onClose }: { bundle: WalkBundle; initialRoomId: string | null; onClose: () => void }): ReactElement | null {
  const { site, rt } = useData();
  const { personId } = usePersona();
  const { say } = useToast();
  const rooms = (site?.rooms ?? []).filter((r) => roomFrames(bundle, r.id).length > 0);
  const [roomId, setRoomId] = useState<string>(initialRoomId && rooms.some((r) => r.id === initialRoomId) ? initialRoomId : (rooms[0]?.id ?? ''));
  const frames = useMemo(() => roomFrames(bundle, roomId), [bundle, roomId]);
  const [frameId, setFrameId] = useState<string | null>(frames[0]?.frame.id ?? null);
  const [box, setBox] = useState<Box | null>(null);
  const [categoryId, setCategory] = useState('other');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [condition, setCondition] = useState<Grade>('good');
  const [reason, setReason] = useState('No visible wear');
  const [busy, setBusy] = useState(false);
  if (!site) return null;
  const hit = frames.find((f) => f.frame.id === frameId) ?? frames[0];
  const ready = Boolean(hit && box && description.trim());
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Label an item the recogniser missed">
      <form
        className="dialog dialog--wide"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!hit || !box || !description.trim()) return;
          setBusy(true);
          const r = await addMissedLine(
            rt,
            site,
            bundle,
            { roomId, frameId: hit.frame.id, box, categoryId, description: description.trim(), quantity: Math.max(1, Math.round(Number(quantity) || 1)), condition, conditionReason: reason.trim() || 'No reason given' },
            personId,
          );
          setBusy(false);
          if (!r.ok) say(r.message, 'error');
          else {
            say('Item labelled and added. The recogniser will learn from it at this site.');
            onClose();
          }
        }}
      >
        <h2 className="ui-title-m">Label an item the recogniser missed</h2>
        {rooms.length === 0 ? <p className="ui-body muted">No room has frames ready yet. Film a room first.</p> : null}
        <div className="form-grid">
          <label className="field">
            <span>Room</span>
            <select
              id="missed-room"
              className="select"
              value={roomId}
              onChange={(e) => {
                setRoomId(e.target.value);
                setFrameId(roomFrames(bundle, e.target.value)[0]?.frame.id ?? null);
                setBox(null);
              }}
            >
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {frames.length ? (
          <FramePicker
            frames={frames}
            value={hit?.frame.id ?? null}
            onPick={(id) => {
              setFrameId(id);
              setBox(null);
            }}
          />
        ) : null}
        {hit ? <BoxEditor key={hit.frame.id} src={urlFor(hit.frame.ref) ?? ''} w={hit.frame.w} h={hit.frame.h} value={box} onChange={setBox} label="Draw a box around the item" /> : null}
        <div className="form-grid">
          <label className="field">
            <span>What it is</span>
            <select id="missed-category" className="select" value={categoryId} onChange={(e) => setCategory(e.target.value)}>
              {site.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Quantity</span>
            <input id="missed-quantity" className="input is-data" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>Description</span>
            <input id="missed-description" className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Wall-mounted whiteboard, aluminium frame" />
          </label>
          <label className="field">
            <span>Condition</span>
            <select id="missed-condition" className="select" value={condition} onChange={(e) => setCondition(e.target.value as Grade)}>
              {ConditionGrade.values.map((g) => (
                <option key={g} value={g}>
                  {ConditionGrade.label(g)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Visible reason</span>
            <input id="missed-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <Btn variant="primary" type="submit" icon="found" disabled={!ready || busy}>
            {busy ? 'Saving…' : 'Add the item'}
          </Btn>
          <Btn variant="quiet" onClick={onClose}>
            Cancel
          </Btn>
        </div>
        <span className="ui-body-s muted">It is added as accepted by you, with the box you drew as its evidence. The next recognition at this site is told about it.</span>
      </form>
    </div>
  );
}

/** An admin redraws the box around an item on a frame. */
export function FixBoxDialog({ bundle, line, onClose }: { bundle: WalkBundle; line: Line; onClose: () => void }): ReactElement | null {
  const { site, rt } = useData();
  const { personId } = usePersona();
  const { say } = useToast();
  const all = useMemo(() => framesOf(bundle), [bundle]);
  const frames = roomFrames(bundle, line.roomId);
  const first = line.evidence.find((e) => all.has(e.frameId))?.frameId ?? frames[0]?.frame.id ?? null;
  const [frameId, setFrameId] = useState<string | null>(first);
  const current = line.evidence.find((e) => e.frameId === frameId)?.box ?? null;
  const [box, setBox] = useState<Box | null>(current);
  if (!site) return null;
  const hit = frames.find((f) => f.frame.id === frameId);
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Redraw the box">
      <div className="dialog dialog--wide">
        <h2 className="ui-title-m">Redraw the box: {lineTitle(site, line)}</h2>
        <FramePicker
          frames={frames}
          value={frameId}
          onPick={(id) => {
            setFrameId(id);
            setBox(line.evidence.find((e) => e.frameId === id)?.box ?? null);
          }}
        />
        {hit ? <BoxEditor key={hit.frame.id} src={urlFor(hit.frame.ref) ?? ''} w={hit.frame.w} h={hit.frame.h} value={box} onChange={setBox} label="Draw a box around the item" /> : <p className="ui-body muted">No frame to draw on.</p>}
        <div className="row">
          <Btn
            variant="primary"
            icon="found"
            disabled={!box || !hit}
            onClick={async () => {
              if (!box || !hit) return;
              const r = await correctBox(rt, site, bundle, line, hit.frame.id, box, personId);
              if (!r.ok) say(r.message, 'error');
              else {
                say('Box saved');
                onClose();
              }
            }}
          >
            Save the box
          </Btn>
          <Btn variant="quiet" onClick={onClose}>
            Cancel
          </Btn>
        </div>
      </div>
    </div>
  );
}
