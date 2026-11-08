import { ConditionGrade, REVIEW_ORDER, orderReviewQueue, type ConditionGrade as Grade, type ConfidenceBand } from '@domesday/domain';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { canRecognise, recogniseStoredRoom, useJobs } from '../capture/pipeline';
import {
  acceptLine,
  approveWalk,
  approverCheck,
  canLabel,
  editLine,
  mergeLines,
  rejectLine,
  reopenLine,
  reopenWalk,
  requestRefilm,
  splitLine,
  type DecisionResult,
  type LinePatch,
} from '../data/actions';
import {
  categoryName,
  duration,
  firstName,
  fmtDate,
  fmtShortDate,
  fmtTime,
  fmtTimeSec,
  framesOf,
  isLive,
  lineNo,
  lineTitle,
  megabytes,
  personName,
  plural,
  roomName,
  timecode,
  type FrameHit,
} from '../data/derive';
import { useData, usePersona, useToast, type WalkBundle } from '../data/store';
import type { Line, Reading, Site } from '../data/types';
import { urlFor } from '../runtime/media';
import { go } from '../route';
import { Bar, Btn, Cond, Conf, EvidenceFrame, Fingerprint, Label, LineNo, Note, Prov, type Region } from '../ui/bits';
import { FixBoxDialog, MissedItemDialog } from '../ui/label-dialogs';
import { Icon } from '../ui/icons';

type Mode = 'view' | 'edit' | 'reject' | 'merge' | 'split';

const REJECT_REASONS = ['Not an asset', 'Duplicate of another line', 'Personal belonging', 'Building fabric or fixture', 'Not in this room'];

function statusText(l: Line, site: Site | null): string {
  switch (l.status) {
    case 'accepted':
      return l.decision?.kind === 'edit' ? `edited, then accepted by ${firstName(site, l.decision.by)}` : `accepted by ${firstName(site, l.decision?.by)}${l.decision?.bulk ? ' in bulk' : ''}`;
    case 'rejected':
      return `rejected: ${l.decision?.reason ?? ''}`;
    case 'merged':
      return 'merged into another line';
    case 'split':
      return 'split into several lines';
    default:
      return 'needs a decision';
  }
}

function readingNote(r: Reading, frames: Map<string, FrameHit>): string {
  if (r.source === 'reviewer') return 'entered by a reviewer';
  const hit = r.frameId ? frames.get(r.frameId) : undefined;
  if (!hit) return 'read from a frame';
  return hit.frame.label ? 'read from the label shot' : `read at ${timecode(hit.frame.t)}`;
}

function LineCard({
  line,
  bundle,
  mode,
  setMode,
  decide,
}: {
  line: Line;
  bundle: WalkBundle;
  mode: Mode;
  setMode: (m: Mode) => void;
  decide: (fn: () => Promise<DecisionResult | void>, done: string) => Promise<void>;
}): ReactElement {
  const { site, rt } = useData();
  const { personId } = usePersona();
  const frames = useMemo(() => framesOf(bundle), [bundle]);
  const [zoom, setZoom] = useState<{ src: string; alt: string; regions: Region[]; w: number; h: number; tc?: string } | null>(null);
  const [fixing, setFixing] = useState(false);
  if (!site) return <div />;
  const labeller = canLabel(site, personId) && bundle.walk.id === site.currentWalkId && bundle.walk.status !== 'approved' && (line.status === 'proposed' || line.status === 'accepted');
  const no = lineNo(bundle, line.id);
  const room = site.rooms.find((r) => r.id === line.roomId);
  const visit = bundle.rooms.get(line.roomId);
  const times = line.evidence.map((e) => frames.get(e.frameId)?.frame.t).filter((t): t is number => typeof t === 'number');
  const span = times.length ? (Math.min(...times) === Math.max(...times) ? `at ${timecode(times[0])}` : `between ${timecode(Math.min(...times))} and ${timecode(Math.max(...times))}`) : '';
  const approvedWalk = bundle.walk.status === 'approved';
  const reads: [string, Reading | null][] = [
    ['Make', line.make],
    ['Model', line.model],
    ['Serial', line.serial],
    ['Asset tag', line.tagCode],
  ];

  return (
    <article className="card" aria-label={`Line ${no}, ${categoryName(site, line.categoryId)}`}>
      <div className="card__head">
        <div className="row" style={{ alignItems: 'baseline', gap: 12, flexWrap: 'nowrap', minWidth: 0 }}>
          <LineNo no={no} approved={line.status === 'accepted'} current />
          <div className="stack-xs" style={{ minWidth: 0 }}>
            <h2 className="ui-title-l">{lineTitle(site, line)}</h2>
            <span className="ui-body-s muted">
              {room?.name} · {room?.floor}
              {line.evidence.length ? ` · seen in ${plural(line.evidence.length, 'image', 'images')}` : ''}
              {span ? ` ${span}` : ''}
            </span>
          </div>
        </div>
        <Conf band={line.band} suffix={line.band === 'low' && line.status === 'proposed' ? 'needs its own decision' : undefined} />
      </div>

      {line.evidence.length ? (
        <div className="frames-grid">
          {line.evidence.map((e) => {
            const hit = frames.get(e.frameId);
            if (!hit) return null;
            const src = urlFor(hit.frame.ref);
            const regions: Region[] = [];
            if (e.box) regions.push({ box: e.box });
            for (const [label, r] of reads) {
              if (r?.frameId === e.frameId && r.box) regions.push({ box: r.box, read: `${label}: ${r.value}` });
            }
            const tc = hit.frame.label ? undefined : timecode(hit.frame.t);
            return (
              <EvidenceFrame
                key={e.frameId}
                src={src}
                alt={`${categoryName(site, line.categoryId)} in ${room?.name ?? 'the room'}`}
                imageW={hit.frame.w}
                imageH={hit.frame.h}
                regions={regions}
                tc={tc}
                tag={hit.frame.label ? 'Label shot' : undefined}
                onClick={src ? () => setZoom({ src, alt: line.description, regions, w: hit.frame.w, h: hit.frame.h, tc }) : undefined}
              />
            );
          })}
        </div>
      ) : (
        <Note icon="info">No frames are kept for this line in the demo history.</Note>
      )}

      {mode === 'edit' ? (
        <EditForm line={line} site={site} approvedWalk={approvedWalk} onCancel={() => setMode('view')} onSave={(patch, reason) => decide(() => editLine(rt, site, bundle, line, personId, patch, reason), `Line ${no} edited and accepted`)} />
      ) : (
        <dl className="dms-line__fields" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: '16px 24px' }}>
          <div>
            <dt>Category</dt>
            <dd>{categoryName(site, line.categoryId)}</dd>
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <dt>Description</dt>
            <dd>{line.description}</dd>
          </div>
          {reads.map(([label, r]) => (
            <div key={label}>
              <dt>{label}</dt>
              {r ? (
                <dd className={label === 'Make' ? undefined : 'is-data'}>
                  {r.value}{' '}
                  <span className="ui-body-s" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
                    · {readingNote(r, frames)}
                  </span>
                </dd>
              ) : (
                <dd className="is-empty">Not readable</dd>
              )}
            </div>
          ))}
          <div style={{ gridColumn: 'span 2' }}>
            <dt>Condition</dt>
            <dd>
              <Cond grade={line.condition} reason={line.conditionReason} />
            </dd>
          </div>
          <div>
            <dt>Quantity</dt>
            <dd className="is-data">{line.quantity}</dd>
          </div>
        </dl>
      )}

      {line.safety ? (
        <Note tone="warn" icon="unsafe">
          Safety: {line.safety}
        </Note>
      ) : null}
      {line.bandReason ? <span className="ui-body-s muted">Confidence: {line.bandReason}.</span> : null}
      {line.notes.length ? (
        <Note icon="info">
          {line.notes.join(' ')}
        </Note>
      ) : null}

      {mode === 'reject' ? <RejectForm onCancel={() => setMode('view')} onReject={(reason) => decide(() => rejectLine(rt, site, bundle, line, personId, reason), `Line ${no} rejected`)} /> : null}
      {mode === 'merge' ? (
        <MergeForm
          line={line}
          bundle={bundle}
          site={site}
          onCancel={() => setMode('view')}
          onMerge={(other) => decide(() => mergeLines(rt, site, bundle, line, other, personId), `Lines ${no} and ${lineNo(bundle, other.id)} merged`)}
        />
      ) : null}
      {mode === 'split' ? <SplitForm line={line} onCancel={() => setMode('view')} onSplit={(qs) => decide(() => splitLine(rt, site, bundle, line, personId, qs), `Line ${no} split into ${qs.length}`)} /> : null}

      {mode === 'view' ? (
        <div className="card__foot">
          {line.status === 'proposed' ? (
            <div className="dms-line__actions">
              <Btn variant="primary" icon="found" kbd="A" onClick={() => decide(() => acceptLine(rt, site, bundle, line, personId), `Line ${no} accepted`)}>
                Accept
              </Btn>
              <Btn icon="edit" kbd="E" onClick={() => setMode('edit')}>
                Edit
              </Btn>
              <Btn icon="merge" kbd="M" onClick={() => setMode('merge')}>
                Merge
              </Btn>
              <Btn icon="split" kbd="S" onClick={() => setMode('split')}>
                Split
              </Btn>
              <Btn variant="danger" icon="reject" kbd="R" onClick={() => setMode('reject')}>
                Reject
              </Btn>
            </div>
          ) : (
            <div className="row">
              <span className="ui-body-s">
                <strong>{line.status === 'accepted' ? 'Accepted' : line.status === 'rejected' ? 'Rejected' : line.status === 'merged' ? 'Merged' : 'Split'}</strong> by {personName(site, line.decision?.by)} at {fmtTime(line.decision?.at)}
                {line.decision?.reason ? `: ${line.decision.reason}` : ''}
              </span>
              {!approvedWalk && (line.status === 'accepted' || line.status === 'rejected') ? (
                <Btn variant="quiet" kbd="U" onClick={() => decide(() => reopenLine(rt, bundle, line, personId), `Line ${no} back in the queue`)}>
                  Undo
                </Btn>
              ) : null}
              {approvedWalk && line.status === 'accepted' ? (
                <Btn variant="quiet" icon="edit" onClick={() => setMode('edit')}>
                  Edit with a reason
                </Btn>
              ) : null}
            </div>
          )}
          <span className="data-s faint">
            {line.proposedBy.kind === 'recogniser'
              ? `Proposed by ${line.proposedBy.model ?? 'the recogniser'} · prompt ${line.proposedBy.prompt ?? ''} · ${fmtShortDate(line.proposedBy.at)} ${fmtTime(line.proposedBy.at)}`
              : line.proposedBy.kind === 'reviewer'
                ? `Created by a reviewer · ${fmtShortDate(line.proposedBy.at)} ${fmtTime(line.proposedBy.at)}`
                : 'Demo history'}
            {line.version > 1 ? ` · version ${line.version}` : ''}
          </span>
        </div>
      ) : null}

      {mode === 'view' && labeller ? (
        <div className="row">
          <Btn variant="quiet" icon="edit" onClick={() => setFixing(true)}>
            Redraw the box
          </Btn>
          <span className="ui-body-s muted">If the box is on the wrong thing. Use Edit to relabel what it is.</span>
        </div>
      ) : null}
      {fixing ? <FixBoxDialog bundle={bundle} line={line} onClose={() => setFixing(false)} /> : null}

      {line.history.length > 1 || line.decision ? (
        <details>
          <summary className="ui-body-s" style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>
            History ({line.history.length})
          </summary>
          <ul className="history" style={{ marginTop: 10 }}>
            {line.history.map((h, i) => (
              <li key={i}>
                <span className="data-s">{fmtTimeSec(h.at)}</span>
                <span>
                  {h.action}
                  {h.by ? ` · ${personName(site, h.by)}` : ''}
                  {h.reason ? ` · "${h.reason}"` : ''}
                  {h.changes && Object.keys(h.changes).length
                    ? ` · ${Object.entries(h.changes)
                        .map(([k, [a, b]]) => `${k}: ${fmtVal(a)} → ${fmtVal(b)}`)
                        .join('; ')}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {visit?.analysis.note ? <span className="ui-body-s muted">Room note from the recogniser: {visit.analysis.note}</span> : null}

      {zoom ? (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Frame" onClick={() => setZoom(null)}>
          <div className="dialog dialog--wide" onClick={(e) => e.stopPropagation()}>
            <EvidenceFrame src={zoom.src} alt={zoom.alt} imageW={zoom.w} imageH={zoom.h} aspect={zoom.w / zoom.h} regions={zoom.regions} tc={zoom.tc} />
            <div className="row row--between">
              <span className="ui-body-s muted">{zoom.alt}</span>
              <Btn onClick={() => setZoom(null)}>Close</Btn>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'object' && v && 'value' in (v as Record<string, unknown>)) return String((v as Reading).value);
  return String(v).replace(/_/g, ' ');
}

function EditForm({ line, site, approvedWalk, onCancel, onSave }: { line: Line; site: Site; approvedWalk: boolean; onCancel: () => void; onSave: (p: LinePatch, reason: string | null) => void }): ReactElement {
  const [categoryId, setCategory] = useState(line.categoryId);
  const [description, setDescription] = useState(line.description);
  const [quantity, setQuantity] = useState(String(line.quantity));
  const [condition, setCondition] = useState<Grade>(line.condition);
  const [conditionReason, setConditionReason] = useState(line.conditionReason);
  const [make, setMake] = useState(line.make?.value ?? '');
  const [model, setModel] = useState(line.model?.value ?? '');
  const [serial, setSerial] = useState(line.serial?.value ?? '');
  const [tag, setTag] = useState(line.tagCode?.value ?? '');
  const [reason, setReason] = useState('');
  const read = (v: string, prev: Reading | null): Reading | null => {
    const t = v.trim();
    if (!t) return null;
    if (prev && prev.value === t) return prev;
    return { value: t, source: 'reviewer', frameId: null, box: null };
  };
  const q = Math.max(1, Math.round(Number(quantity) || 1));
  return (
    <form
      className="stack-m"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(
          {
            categoryId,
            description: description.trim() || line.description,
            quantity: q,
            condition,
            conditionReason: conditionReason.trim(),
            make: read(make, line.make),
            model: read(model, line.model),
            serial: read(serial, line.serial),
            tagCode: read(tag, line.tagCode),
          },
          reason.trim() || null,
        );
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>Category</span>
          <select id="edit-category" className="select" value={categoryId} onChange={(e) => setCategory(e.target.value)}>
            {site.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Quantity</span>
          <input id="edit-quantity" className="input is-data" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>Description</span>
          <input id="edit-description" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span>Condition</span>
          <select id="edit-condition" className="select" value={condition} onChange={(e) => setCondition(e.target.value as Grade)}>
            {ConditionGrade.values.map((g) => (
              <option key={g} value={g}>
                {ConditionGrade.label(g)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Visible reason</span>
          <input id="edit-condition-reason" className="input" value={conditionReason} onChange={(e) => setConditionReason(e.target.value)} />
        </label>
        <label className="field">
          <span>Make</span>
          <input id="edit-make" className="input" value={make} onChange={(e) => setMake(e.target.value)} />
        </label>
        <label className="field">
          <span>Model</span>
          <input id="edit-model" className="input is-data" value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="field">
          <span>Serial</span>
          <input id="edit-serial" className="input is-data" value={serial} onChange={(e) => setSerial(e.target.value)} />
        </label>
        <label className="field">
          <span>Asset tag</span>
          <input id="edit-tag" className="input is-data" value={tag} onChange={(e) => setTag(e.target.value)} />
        </label>
        {approvedWalk ? (
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>Reason for the change (required after approval)</span>
            <input id="edit-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example, counted again on site" />
          </label>
        ) : null}
      </div>
      <span className="ui-body-s muted">Values you type are marked as entered by a reviewer, not read from a frame.</span>
      <div className="row">
        <Btn variant="primary" type="submit" icon="found" disabled={approvedWalk && !reason.trim()}>
          Save and accept
        </Btn>
        <Btn variant="quiet" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </form>
  );
}

function RejectForm({ onCancel, onReject }: { onCancel: () => void; onReject: (reason: string) => void }): ReactElement {
  const [reason, setReason] = useState('');
  return (
    <form
      className="stack-s panel panel--tight"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onReject(reason.trim());
      }}
    >
      <span className="ui-body-strong">Why reject this line?</span>
      <div className="row">
        {REJECT_REASONS.map((r) => (
          <Btn key={r} variant={reason === r ? 'primary' : 'secondary'} style={{ minHeight: 40, fontWeight: 400 }} onClick={() => setReason(r)}>
            {r}
          </Btn>
        ))}
      </div>
      <input id="reject-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or write a reason" />
      <div className="row">
        <Btn variant="danger" type="submit" icon="reject" disabled={!reason.trim()}>
          Reject
        </Btn>
        <Btn variant="quiet" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </form>
  );
}

function MergeForm({ line, bundle, site, onCancel, onMerge }: { line: Line; bundle: WalkBundle; site: Site; onCancel: () => void; onMerge: (other: Line) => void }): ReactElement {
  const others = bundle.lines.filter((l) => l.id !== line.id && isLive(l) && l.roomId === line.roomId);
  return (
    <div className="stack-s panel panel--tight">
      <span className="ui-body-strong">Merge with which line in {roomName(site, line.roomId)}?</span>
      <span className="ui-body-s muted">This line stays, keeps both sets of frames, and is accepted. Matching counted groups add their quantities.</span>
      {others.length === 0 ? <span className="ui-body-s muted">No other open lines in this room.</span> : null}
      {others.map((o) => (
        <button key={o.id} type="button" className="choice" style={{ minHeight: 56 }} onClick={() => onMerge(o)}>
          <LineNo no={lineNo(bundle, o.id)} approved={o.status === 'accepted'} />
          <span className="stack-xs">
            <span className="ui-body-strong">{lineTitle(site, o)}</span>
            <span className="ui-body-s muted">{o.description}</span>
          </span>
          <Icon name="merge" />
        </button>
      ))}
      <div>
        <Btn variant="quiet" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

function SplitForm({ line, onCancel, onSplit }: { line: Line; onCancel: () => void; onSplit: (qs: number[]) => void }): ReactElement {
  const group = line.quantity > 1;
  const [a, setA] = useState(String(group ? Math.ceil(line.quantity / 2) : 1));
  const [b, setB] = useState(String(group ? Math.floor(line.quantity / 2) : 1));
  const qa = Math.max(1, Math.round(Number(a) || 1));
  const qb = Math.max(1, Math.round(Number(b) || 1));
  return (
    <form
      className="stack-s panel panel--tight"
      onSubmit={(e) => {
        e.preventDefault();
        onSplit([qa, qb]);
      }}
    >
      <span className="ui-body-strong">Split into two lines</span>
      <span className="ui-body-s muted">{group ? `For example, ${line.quantity} chairs that are really two different models.` : 'For example, two different items proposed as one.'} Each part comes back for its own decision.</span>
      <div className="form-grid">
        <label className="field">
          <span>First line, quantity</span>
          <input id="split-a" className="input is-data" inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} />
        </label>
        <label className="field">
          <span>Second line, quantity</span>
          <input id="split-b" className="input is-data" inputMode="numeric" value={b} onChange={(e) => setB(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <Btn variant="primary" type="submit" icon="split">
          Split
        </Btn>
        <Btn variant="quiet" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </form>
  );
}

function BulkGrid({ lines, bundle, onDone }: { lines: Line[]; bundle: WalkBundle; onDone: () => void }): ReactElement {
  const { site, rt } = useData();
  const { personId } = usePersona();
  const { say } = useToast();
  const frames = useMemo(() => framesOf(bundle), [bundle]);
  const [busy, setBusy] = useState(false);
  if (!site) return <div />;
  const open = lines.filter((l) => l.status === 'proposed');
  return (
    <div className="stack-m">
      <div className="row row--between">
        <span className="ui-body-s muted">High-confidence lines, shown together so you can check them at a glance before approving them in one go.</span>
        <Btn
          variant="primary"
          icon="found"
          disabled={busy || open.length === 0}
          onClick={async () => {
            setBusy(true);
            let refused = 0;
            for (const l of open) {
              const r = await acceptLine(rt, site, bundle, l, personId, { bulk: true });
              if (!r.ok) refused += 1;
            }
            setBusy(false);
            if (refused) say(`${refused} ${refused === 1 ? 'line was' : 'lines were'} not approved: you filmed ${refused === 1 ? 'its room' : 'their rooms'}`, 'error');
            else say(`${plural(open.length, 'line', 'lines')} approved in bulk`);
            onDone();
          }}
        >
          Approve the {plural(open.length, 'line', 'lines')} shown
        </Btn>
      </div>
      <div className="grid-tiles">
        {lines.map((l) => {
          const e = l.evidence[0];
          const hit = e ? frames.get(e.frameId) : undefined;
          return (
            <div key={l.id} className="tile">
              <EvidenceFrame src={hit ? urlFor(hit.frame.ref) : null} alt={l.description} imageW={hit?.frame.w} imageH={hit?.frame.h} regions={e?.box ? [{ box: e.box }] : []} />
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <LineNo no={lineNo(bundle, l.id)} approved={l.status === 'accepted'} />
                <span className="ui-body-s" style={{ fontWeight: 700, minWidth: 0 }}>
                  {lineTitle(site, l)}
                </span>
              </div>
              <span className="ui-body-s muted">{roomName(site, l.roomId)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ReviewPage(): ReactElement {
  const { site, current, previous, rt, corrections } = useData();
  const { personId, setPersonId } = usePersona();
  const { say } = useToast();
  const jobs = useJobs();
  const [walkKey, setWalkKey] = useState<'current' | 'previous'>('current');
  const bundle = walkKey === 'previous' ? previous : current;
  const [band, setBand] = useState<ConfidenceBand | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [grid, setGrid] = useState(false);
  const [refilm, setRefilm] = useState<string | null>(null);
  const [refilmReason, setRefilmReason] = useState('');
  const [labelMissed, setLabelMissed] = useState(false);

  const lines = bundle?.lines ?? [];
  const visibleLines = lines.filter((l) => l.status !== 'merged' && l.status !== 'split');
  const counts = useMemo(() => {
    const c: Record<ConfidenceBand, { all: number; open: number }> = { low: { all: 0, open: 0 }, medium: { all: 0, open: 0 }, high: { all: 0, open: 0 } };
    for (const l of visibleLines) {
      c[l.band].all += 1;
      if (l.status === 'proposed') c[l.band].open += 1;
    }
    return c;
  }, [visibleLines]);
  const activeBand: ConfidenceBand = band ?? REVIEW_ORDER.find((b) => counts[b].open > 0) ?? REVIEW_ORDER.find((b) => counts[b].all > 0) ?? 'low';
  const queue = useMemo(() => orderReviewQueue(visibleLines).filter((l) => l.band === activeBand), [visibleLines, activeBand]);
  const line = lines.find((l) => l.id === selected) ?? queue.find((l) => l.status === 'proposed') ?? queue[0] ?? null;
  const open = visibleLines.filter((l) => l.status === 'proposed').length;
  const decided = visibleLines.length - open;

  useEffect(() => {
    setMode('view');
  }, [line?.id]);

  const advance = useCallback(
    (fromId: string) => {
      const all = orderReviewQueue(visibleLines);
      const idx = all.findIndex((l) => l.id === fromId);
      const next = [...all.slice(idx + 1), ...all.slice(0, idx)].find((l) => l.status === 'proposed' && l.id !== fromId);
      if (next) {
        setBand(next.band);
        setSelected(next.id);
      }
    },
    [visibleLines],
  );

  const decide = useCallback(
    async (fn: () => Promise<DecisionResult | void>, done: string) => {
      if (!line) return;
      const id = line.id;
      const r = await fn();
      if (r && !r.ok) {
        say(r.message, 'error');
        return;
      }
      say(done);
      setMode('view');
      advance(id);
    },
    [line, say, advance],
  );

  // Keyboard: A accept, E edit, M merge, S split, R reject, U undo, J/K next and previous.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (!line || !site || !bundle || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (mode !== 'view') {
        if (k === 'escape') setMode('view');
        return;
      }
      const idx = queue.findIndex((l) => l.id === line.id);
      if (k === 'j' || k === 'arrowdown') {
        const n = queue[idx + 1];
        if (n) setSelected(n.id);
      } else if (k === 'k' || k === 'arrowup') {
        const p = queue[idx - 1];
        if (p) setSelected(p.id);
      } else if (line.status === 'proposed' && bundle.walk.status !== 'approved') {
        if (k === 'a') void decide(() => acceptLine(rt, site, bundle, line, personId), `Line ${lineNo(bundle, line.id)} accepted`);
        else if (k === 'e') setMode('edit');
        else if (k === 'm') setMode('merge');
        else if (k === 's') setMode('split');
        else if (k === 'r') setMode('reject');
        else return;
      } else if (k === 'u' && (line.status === 'accepted' || line.status === 'rejected') && bundle.walk.status !== 'approved') {
        void decide(() => reopenLine(rt, bundle, line, personId), `Line ${lineNo(bundle, line.id)} back in the queue`);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [line, site, bundle, mode, queue, rt, personId, decide]);

  if (!site || !bundle) return <main className="page" />;
  const isPrevious = walkKey === 'previous';
  const approved = bundle.walk.status === 'approved';
  const capturers = bundle.walk.capturedBy.map((p) => personName(site, p));
  const sep = line ? approverCheck(site, bundle, [line.roomId], personId) : null;
  const waitingRooms = site.rooms.filter((r) => {
    const v = bundle.rooms.get(r.id);
    return v?.status === 'filmed' && v.analysis.status !== 'done';
  });
  const visit = line ? bundle.rooms.get(line.roomId) : undefined;

  return (
    <main className="page">
      <div className="page-head">
        <div className="page-head__text" style={{ gap: 6 }}>
          <span className="ui-body-s muted">
            <a href="#walks">Overview</a> / {site.name} / {bundle.walk.startedAt ? fmtDate(bundle.walk.startedAt) : 'current walk'}
            {capturers.length ? ` · filmed by ${capturers.join(' and ')}` : ''}
          </span>
          <h1 className="ui-title-l">Review</h1>
          <div className="row" style={{ gap: 12 }}>
            <span style={{ width: 220 }}>
              <Bar value={decided} total={visibleLines.length} label="Lines decided" />
            </span>
            <span className="ui-body-s">
              <strong>
                {decided} of {visibleLines.length}
              </strong>{' '}
              lines decided
            </span>
          </div>
        </div>
        <div className="page-head__actions">
          {previous ? (
            <div className="seg" role="tablist" aria-label="Walk">
              <button type="button" role="tab" aria-selected={!isPrevious} onClick={() => { setWalkKey('current'); setSelected(null); setBand(null); }}>
                This walk
              </button>
              <button type="button" role="tab" aria-selected={isPrevious} onClick={() => { setWalkKey('previous'); setSelected(null); setBand(null); }}>
                {fmtShortDate(previous.walk.startedAt)} walk
              </button>
            </div>
          ) : null}
          {!isPrevious && !approved ? (
            <>
              <span className="ui-body-s muted">{open ? `${plural(open, 'line still needs', 'lines still need')} a decision` : visibleLines.length ? 'Every line has a decision' : ''}</span>
              {canLabel(site, personId) && visibleLines.length ? (
                <Btn onClick={() => setLabelMissed(true)} icon="label-shot">
                  Label a missed item
                </Btn>
              ) : null}
              {line ? (
                <Btn onClick={() => setRefilm(line.roomId)} icon="refresh">
                  Request refilm
                </Btn>
              ) : null}
              <Btn
                variant="primary"
                icon="found"
                disabled={visibleLines.length === 0}
                onClick={async () => {
                  const r = await approveWalk(rt, site, bundle, personId);
                  if (!r.ok) say(r.message, 'error');
                  else {
                    say('Walk approved. The comparison and reconciliation are ready.');
                    go('compare');
                  }
                }}
              >
                Approve walk
              </Btn>
            </>
          ) : null}
          {!isPrevious && approved ? (
            <>
              <span className="ui-body-s">
                Approved by <strong>{personName(site, bundle.walk.approvedBy)}</strong> at {fmtTime(bundle.walk.approvedAt)}
              </span>
              <Btn variant="quiet" onClick={async () => { await reopenWalk(rt, bundle, personId); say('Approval withdrawn. The walk is back in review.'); }}>
                Withdraw approval
              </Btn>
            </>
          ) : null}
        </div>
      </div>

      {isPrevious ? (
        <div style={{ paddingBottom: 16 }}>
          <Note icon="info">The approved walk of {fmtDate(bundle.walk.startedAt)}, kept as demo history. Read only.</Note>
        </div>
      ) : null}

      {waitingRooms.length && !isPrevious ? (
        <div style={{ paddingBottom: 16 }}>
          <Note tone="warn" icon="clock">
            <div className="stack-s">
              <span>
                {waitingRooms.map((r) => r.name).join(', ')} {waitingRooms.length === 1 ? 'is' : 'are'} filmed but not recognised yet. Frames stay hidden until faces and screens are
                blurred.
              </span>
              {canRecognise(rt) ? (
                <div className="row">
                  {waitingRooms.map((r) => {
                    const running = jobs.some((j) => j.roomId === r.id && j.phase === 'running') || bundle.rooms.get(r.id)?.analysis.status === 'running';
                    return (
                      <Btn key={r.id} icon="refresh" disabled={running} onClick={() => void recogniseStoredRoom({ rt, site, bundle, room: r, personId, corrections })} style={{ minHeight: 40 }}>
                        {running ? `Recognising ${r.name}…` : `Run recognition for ${r.name}`}
                      </Btn>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </Note>
        </div>
      ) : null}

      {visibleLines.length === 0 ? (
        <section className="panel stack-m" style={{ marginBottom: 48 }}>
          <h2 className="ui-title-m">Nothing to review yet</h2>
          <p className="ui-body muted">Lines appear here as rooms are filmed, usually within a minute of each clip. Film a room on your phone, or use a room's sample footage from Capture.</p>
          <div>
            <Btn variant="primary" icon="record" onClick={() => go('capture')}>
              Go to capture
            </Btn>
          </div>
        </section>
      ) : (
        <div className="review-grid">
          <aside aria-label="Review queue" className="stack-s">
            <div className="seg" role="tablist" aria-label="Confidence">
              {REVIEW_ORDER.map((b) => (
                <button key={b} type="button" role="tab" aria-selected={activeBand === b} onClick={() => { setBand(b); setSelected(null); setGrid(false); }}>
                  {b === 'low' ? 'Low' : b === 'medium' ? 'Medium' : 'High'} {counts[b].all}
                </button>
              ))}
            </div>
            <p className="ui-body-s muted">
              {activeBand === 'low'
                ? "Low-confidence lines each need their own decision. They can't be approved in bulk."
                : activeBand === 'high'
                  ? 'High-confidence lines can be approved together once you have seen them in the grid.'
                  : 'Medium-confidence lines are decided one at a time.'}
            </p>
            {activeBand === 'high' && !isPrevious && !approved ? (
              <Btn variant={grid ? 'primary' : 'secondary'} onClick={() => setGrid((g) => !g)} style={{ minHeight: 40 }}>
                {grid ? 'Back to one at a time' : `Show all ${counts.high.all} as a grid`}
              </Btn>
            ) : null}
            <ol className="queue">
              {queue.map((l) => (
                <li key={l.id}>
                  <button type="button" aria-current={line?.id === l.id && !grid ? 'true' : undefined} onClick={() => { setSelected(l.id); setGrid(false); }}>
                    <LineNo no={lineNo(bundle, l.id)} approved={l.status === 'accepted'} current={line?.id === l.id} />
                    <span className="stack-xs" style={{ gap: 0 }}>
                      <span className="ui-body-strong" style={{ fontWeight: l.status === 'proposed' ? 700 : 400, textDecoration: l.status === 'rejected' ? 'line-through' : undefined }}>
                        {lineTitle(site, l)}
                      </span>
                      <span className="ui-body-s muted">
                        {roomName(site, l.roomId)} · {statusText(l, site)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>

          <div className="stack-m" style={{ minWidth: 0 }}>
            {sep && !sep.allowed && line?.status === 'proposed' && !isPrevious ? (
              <Note tone="warn" icon="people">
                <div className="stack-s">
                  <span>
                    {personName(site, personId)} filmed {roomName(site, line.roomId)}, so {firstName(site, personId)} can't approve its lines.
                    {sep.suggestedReviewer ? ` ${sep.suggestedReviewer.displayName} can.` : ''}
                  </span>
                  {sep.suggestedReviewer ? (
                    <div>
                      <Btn onClick={() => setPersonId(sep.suggestedReviewer?.userId ?? personId)} style={{ minHeight: 40 }}>
                        Use this device as {sep.suggestedReviewer.displayName}
                      </Btn>
                    </div>
                  ) : null}
                </div>
              </Note>
            ) : null}
            {grid && activeBand === 'high' ? (
              <BulkGrid lines={queue} bundle={bundle} onDone={() => setGrid(false)} />
            ) : line ? (
              <LineCard line={line} bundle={bundle} mode={isPrevious ? 'view' : mode} setMode={setMode} decide={decide} />
            ) : null}
          </div>

          <aside className="prov-col stack-l" aria-label="Provenance">
            {visit ? (
              <section className="stack-s">
                <Label>WHERE THIS CAME FROM</Label>
                <Prov
                  rows={[
                    ['Filmed by', personName(site, visit.filmedBy) || 'Not recorded'],
                    ['Phone time', visit.filmedAt ? `${fmtShortDate(visit.filmedAt)} · ${fmtTimeSec(visit.clip?.fingerprintedAt ?? visit.filmedAt)}` : ''],
                    ['Device', visit.clip ? (visit.clip.source === 'sample' ? 'Sample footage' : visit.clip.device) : 'Not kept'],
                    ['Clip', visit.clip ? `${roomName(site, visit.roomId)} · ${duration(visit.clip.durationS)} · ${megabytes(visit.clip.sizeBytes)}` : 'Not kept in the demo history'],
                    ['Print', visit.clip ? `sha256 ${visit.clip.sha256.slice(0, 8)}…${visit.clip.sha256.slice(-6)}` : 'None'],
                  ]}
                />
                {visit.clip ? (
                  <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
                    <Fingerprint hex={visit.clip.sha256} />
                    <span className="ui-body-s" style={{ color: 'var(--confirmed-text)' }}>
                      Taken on the phone when the clip was handed over. The clip itself stays on the phone in this demo.
                    </span>
                  </div>
                ) : null}
                {visit.analysis.privacy ? (
                  <span className="ui-body-s muted">
                    Privacy pass: {visit.analysis.privacy.faces} faces, {visit.analysis.privacy.screens} screens and {visit.analysis.privacy.documents} documents blurred before review.
                  </span>
                ) : null}
              </section>
            ) : null}
            <section className="stack-s">
              <Label>KEYS</Label>
              <dl className="ui-body-s" style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', alignItems: 'center' }}>
                <dt>
                  <span className="dms-kbd">A</span>
                </dt>
                <dd style={{ margin: 0 }}>Accept as proposed</dd>
                <dt>
                  <span className="dms-kbd">E</span>
                </dt>
                <dd style={{ margin: 0 }}>Edit fields</dd>
                <dt>
                  <span className="dms-kbd">M</span> <span className="dms-kbd">S</span>
                </dt>
                <dd style={{ margin: 0 }}>Merge or split</dd>
                <dt>
                  <span className="dms-kbd">R</span>
                </dt>
                <dd style={{ margin: 0 }}>Reject, with a reason</dd>
                <dt>
                  <span className="dms-kbd">J</span> <span className="dms-kbd">K</span>
                </dt>
                <dd style={{ margin: 0 }}>Next or previous line</dd>
                <dt>
                  <span className="dms-kbd">U</span>
                </dt>
                <dd style={{ margin: 0 }}>Undo a decision</dd>
              </dl>
            </section>
            {capturers.length && !isPrevious ? (
              <p className="ui-body-s muted">
                {capturers.join(' and ')} filmed this walk, so {capturers.length === 1 ? 'they' : 'neither'} can't approve {capturers.length === 1 ? 'it alone' : 'it alone'}. Your decisions count as the
                second name.
              </p>
            ) : null}
          </aside>
        </div>
      )}

      {labelMissed ? <MissedItemDialog bundle={bundle} initialRoomId={line?.roomId ?? null} onClose={() => setLabelMissed(false)} /> : null}
      {refilm ? (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Request a refilm">
          <form
            className="dialog"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!refilmReason.trim()) return;
              await requestRefilm(rt, bundle, refilm, personId, refilmReason.trim());
              say(`Refilm of ${roomName(site, refilm)} requested. It shows on the capturer's phone.`);
              setRefilm(null);
              setRefilmReason('');
            }}
          >
            <h2 className="ui-title-m">Request a refilm of {roomName(site, refilm)}</h2>
            <p className="ui-body-s muted">The room shows as a task on the capturer's phone, with your reason.</p>
            <input id="refilm-reason" className="input" value={refilmReason} onChange={(e) => setRefilmReason(e.target.value)} placeholder="Too dark to read the labels" autoFocus />
            <div className="row">
              <Btn variant="primary" type="submit" disabled={!refilmReason.trim()}>
                Request refilm
              </Btn>
              <Btn variant="quiet" onClick={() => setRefilm(null)}>
                Cancel
              </Btn>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
