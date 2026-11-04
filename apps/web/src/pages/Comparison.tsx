import { comparisonHeadline, type ChangeStatus, type WalkChange } from '@domesday/domain';
import { useMemo, useState, type ReactElement } from 'react';
import { addFollowup, requestRefilm } from '../data/actions';
import {
  approvedLines,
  categoryName,
  categoryPlural,
  comparison,
  fmtDate,
  fmtDayMonth,
  fmtShortDate,
  framesOf,
  money,
  personName,
  plural,
  reconciliation,
  registerEntry,
  roomName,
  timecode,
} from '../data/derive';
import { useData, usePersona, useToast, type WalkBundle } from '../data/store';
import type { Followup, Line, Site } from '../data/types';
import { urlFor } from '../runtime/media';
import { go } from '../route';
import { Btn, Chip, EvidenceFrame, Label, Note, type ChipStatus } from '../ui/bits';
import { Icon, type IconName } from '../ui/icons';

type Filter = 'all' | 'unsafe' | ChangeStatus;

function chipFor(c: WalkChange, after: Line | undefined): { status: ChipStatus; text: string } {
  switch (c.status) {
    case 'not_seen':
      return { status: 'not-seen', text: c.quantityDelta ? `${Math.abs(c.quantityDelta)} not seen on this walk` : 'Not seen on this walk' };
    case 'moved':
      return { status: 'moved', text: 'Moved' };
    case 'new':
      return { status: 'new', text: c.quantityDelta ? `${c.quantityDelta} more than last time` : 'New' };
    case 'condition_worse':
      return after?.condition === 'not_working_or_unsafe' ? { status: 'unsafe', text: 'Unsafe' } : { status: 'worse', text: 'Condition worse' };
    case 'condition_better':
      return { status: 'better', text: 'Condition better' };
    case 'room_not_filmed':
      return { status: 'not-filmed', text: 'Room not filmed' };
    default:
      return { status: 'confirmed', text: 'Unchanged' };
  }
}

function Side({ bundle, line, when, empty }: { bundle: WalkBundle | null; line: Line | undefined; when: string; empty: string }): ReactElement {
  const frames = useMemo(() => framesOf(bundle), [bundle]);
  const e = line?.evidence.find((x) => x.box) ?? line?.evidence[0];
  const hit = e ? frames.get(e.frameId) : undefined;
  if (!line || !hit) {
    return (
      <figure className="dms-change__side">
        <div className="dms-change__empty">{line && !hit ? 'No frame kept for this line' : empty}</div>
        <figcaption>{when}</figcaption>
      </figure>
    );
  }
  return (
    <figure className="dms-change__side">
      <EvidenceFrame
        src={urlFor(hit.frame.ref)}
        alt={`${line.description}, ${when}`}
        imageW={hit.frame.w}
        imageH={hit.frame.h}
        regions={e?.box ? [{ box: e.box }] : []}
        tc={`${when.split(' · ')[0]}${hit.frame.t !== null ? ` · ${timecode(hit.frame.t)}` : ''}`}
      />
      <figcaption>{when}</figcaption>
    </figure>
  );
}

function InvestigateForm({ site, onCancel, onSave }: { site: Site; onCancel: () => void; onSave: (owner: string, due: string, note: string) => void }): ReactElement {
  const inAWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const [owner, setOwner] = useState(site.people.find((p) => p.role === 'site_manager')?.id ?? site.people[0]?.id ?? '');
  const [due, setDue] = useState(inAWeek);
  const [note, setNote] = useState('');
  return (
    <form
      className="panel panel--tight stack-s"
      style={{ width: '100%' }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(owner, due, note.trim());
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>Owner</span>
          <select id="investigate-owner" className="select" value={owner} onChange={(e) => setOwner(e.target.value)}>
            {site.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Due</span>
          <input id="investigate-due" type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
      </div>
      <input id="investigate-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the owner (optional)" />
      <div className="row">
        <Btn variant="primary" type="submit" icon="investigate">
          Assign
        </Btn>
        <Btn variant="quiet" onClick={onCancel}>
          Cancel
        </Btn>
      </div>
      <span className="ui-body-s muted">It stays "not seen on this walk" until the owner records an outcome.</span>
    </form>
  );
}

export function ComparisonPage(): ReactElement {
  const { site, current, previous, register, rt } = useData();
  const { personId } = usePersona();
  const { say } = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [investigating, setInvestigating] = useState<string | null>(null);

  const result = useMemo(() => (site && current && previous ? comparison(site, current, previous) : null), [site, current, previous]);
  const recon = useMemo(() => (site && current ? reconciliation(site, register, current) : null), [site, register, current]);

  if (!site || !current || !previous || !result) return <main className="page" />;
  const approved = current.walk.status === 'approved';
  const before = new Map(previous.lines.map((l) => [l.id, l]));
  const after = new Map(current.lines.map((l) => [l.id, l]));
  const prevDate = previous.walk.startedAt ? new Date(previous.walk.startedAt) : new Date();
  const curDate = current.walk.startedAt;
  const curShort = curDate ? fmtShortDate(curDate) : 'This walk';
  const prevShort = fmtShortDate(previous.walk.startedAt);
  const lineCount = approvedLines(current).length;
  const reconByLine = new Map((recon?.items ?? []).filter((i) => i.lineId && i.registerId).map((i) => [i.lineId as string, i.registerId as string]));

  const valueOf = (c: WalkChange): number | null => {
    const b = c.beforeLineId ? before.get(c.beforeLineId) : undefined;
    const reg = registerEntry(register, b?.registerId ?? (c.afterLineId ? reconByLine.get(c.afterLineId) : null));
    if (!reg?.bookValueKobo) return null;
    if (c.status === 'not_seen' && c.quantityDelta && reg.quantity > 0) return Math.round((reg.bookValueKobo * Math.abs(c.quantityDelta)) / reg.quantity);
    return reg.bookValueKobo;
  };

  const changes = result.items.filter((c) => c.status !== 'unchanged' && c.status !== 'room_not_filmed');
  const notFilmed = result.items.filter((c) => c.status === 'room_not_filmed');
  const notFilmedRooms = [...new Set(notFilmed.map((c) => before.get(c.beforeLineId ?? '')?.roomId).filter((r): r is string => Boolean(r)))];
  const unchanged = result.items.filter((c) => c.status === 'unchanged');
  const notSeenValue = changes.filter((c) => c.status === 'not_seen').reduce((s, c) => s + (valueOf(c) ?? 0), 0);
  const notSeenCount = changes.filter((c) => c.status === 'not_seen').length;
  const isUnsafe = (c: WalkChange): boolean => c.status === 'condition_worse' && after.get(c.afterLineId ?? '')?.condition === 'not_working_or_unsafe';

  const counts: Record<string, number> = { all: changes.length + notFilmedRooms.length, unsafe: changes.filter(isUnsafe).length };
  for (const c of changes) counts[c.status] = (counts[c.status] ?? 0) + 1;
  counts.room_not_filmed = notFilmedRooms.length;

  const shown = filter === 'all' ? changes : filter === 'unsafe' ? changes.filter(isUnsafe) : changes.filter((c) => c.status === filter);
  const hasFollowup = (kind: string, lineId: string | null): Followup | undefined => current.followups.find((f) => f.kind === kind && f.lineId === lineId && f.status === 'open');

  const filters: { id: Filter; label: string; icon?: IconName; color?: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'unsafe', label: 'Unsafe', icon: 'unsafe', color: 'var(--unsafe-mark)' },
    { id: 'not_seen', label: 'Not seen', icon: 'not-seen', color: 'var(--not-seen-mark)' },
    { id: 'condition_worse', label: 'Condition worse', icon: 'worse', color: 'var(--worse-mark)' },
    { id: 'moved', label: 'Moved', icon: 'moved', color: 'var(--moved-mark)' },
    { id: 'new', label: 'New', icon: 'new', color: 'var(--new-mark)' },
    { id: 'condition_better', label: 'Condition better', icon: 'better', color: 'var(--better-mark)' },
    { id: 'room_not_filmed', label: 'Room not filmed', icon: 'not-filmed', color: 'var(--not-filmed-mark)' },
  ];

  const row = (c: WalkChange): ReactElement => {
    const b = c.beforeLineId ? before.get(c.beforeLineId) : undefined;
    const a = c.afterLineId ? after.get(c.afterLineId) : undefined;
    const line = a ?? b;
    if (!line) return <div key={`${c.beforeLineId}|${c.afterLineId}`} />;
    const chip = chipFor(c, a);
    const name = categoryName(site, line.categoryId);
    const value = valueOf(c);
    const key = `${c.beforeLineId ?? ''}|${c.afterLineId ?? ''}`;
    const subjectId = (a ?? b)?.id ?? null;
    let detail: ReactElement;
    let actions: ReactElement | null = null;
    switch (c.status) {
      case 'not_seen': {
        const inv = hasFollowup('investigation', subjectId);
        detail = (
          <>
            {roomName(site, line.roomId)} was filmed {c.quantityDelta ? 'and fewer were counted' : 'in full'}.{' '}
            {value !== null ? (
              <>
                Book value{c.quantityDelta ? ` of the ${Math.abs(c.quantityDelta)}` : ''} <span className="data-m" style={{ color: 'var(--text)' }}>{money(value)}</span>
              </>
            ) : null}
          </>
        );
        actions = inv ? (
          <span className="ui-body-s">
            <Icon name="investigate" size={16} style={{ verticalAlign: '-3px' }} /> Investigation open · {personName(site, inv.owner)} · due {fmtDayMonth(inv.due ? `${inv.due}T12:00:00+01:00` : null)}
          </span>
        ) : investigating === key ? (
          <InvestigateForm
            site={site}
            onCancel={() => setInvestigating(null)}
            onSave={async (owner, due, note) => {
              await addFollowup(rt, current, { kind: 'investigation', title: `${name} not seen in ${roomName(site, line.roomId)}`, lineId: subjectId, registerId: b?.registerId ?? null, roomId: line.roomId, owner, due, note }, personId);
              setInvestigating(null);
              say(`Assigned to ${personName(site, owner)}`);
            }}
          />
        ) : (
          <Btn icon="investigate" onClick={() => setInvestigating(key)}>
            Investigate
          </Btn>
        );
        break;
      }
      case 'moved':
        detail = (
          <>
            {roomName(site, c.from?.roomId)} to {roomName(site, c.to?.roomId)}. Matched by {c.matchedBy === 'tag' ? 'asset tag' : c.matchedBy === 'serial' ? 'serial' : 'appearance'}{' '}
            {c.matchedBy === 'tag' && a?.tagCode ? <span className="data-m" style={{ color: 'var(--text)' }}>{a.tagCode.value}</span> : null}
            {c.matchedBy === 'serial' && a?.serial ? <span className="data-m" style={{ color: 'var(--text)' }}>{a.serial.value}</span> : null}.
          </>
        );
        actions = hasFollowup('location', subjectId) ? (
          <span className="ui-body-s">Location change added to the corrections file</span>
        ) : (
          <Btn
            onClick={async () => {
              await addFollowup(rt, current, { kind: 'location', title: `Move ${name} to ${roomName(site, c.to?.roomId)} in the register`, lineId: subjectId, roomId: c.to?.roomId ?? null }, personId);
              say('Location change noted for the register');
            }}
          >
            Update location
          </Btn>
        );
        break;
      case 'new':
        detail = (
          <>
            {roomName(site, line.roomId)}. {c.quantityDelta ? `Counted ${c.quantityAfter}, was ${c.quantityBefore}.` : reconByLine.has(line.id) ? 'In the books, but not on the last walk.' : 'Not in the books either, so the reconciliation lists it as unrecorded.'}
          </>
        );
        actions = reconByLine.has(line.id) ? null : (
          <Btn onClick={() => go('reconcile')} icon="books">
            Add to register
          </Btn>
        );
        break;
      case 'condition_worse':
      case 'condition_better': {
        const kind = isUnsafe(c) ? 'safety' : 'maintenance';
        detail = (
          <>
            {roomName(site, line.roomId)} · {b ? `${b.condition.replace(/_/g, ' ')} to ${a?.condition.replace(/_/g, ' ')}` : ''} · {a?.conditionReason}
            {a?.safety ? `. Safety: ${a.safety}` : ''}
          </>
        );
        actions =
          c.status === 'condition_worse' ? (
            hasFollowup(kind, subjectId) ? (
              <span className="ui-body-s">On the {kind === 'safety' ? 'safety' : 'maintenance'} list</span>
            ) : (
              <Btn
                onClick={async () => {
                  await addFollowup(rt, current, { kind, title: `${name} in ${roomName(site, line.roomId)}: ${a?.conditionReason ?? ''}`, lineId: subjectId, roomId: line.roomId }, personId);
                  say(`Added to the ${kind === 'safety' ? 'safety' : 'maintenance'} list`);
                }}
              >
                Add to {kind === 'safety' ? 'safety' : 'maintenance'} list
              </Btn>
            )
          ) : null;
        break;
      }
      default:
        detail = <>{roomName(site, line.roomId)}</>;
    }
    return (
      <div key={key} className="dms-change">
        <Side bundle={previous} line={b} when={b ? `${prevShort} · ${b.condition === 'good' ? 'graded good' : `graded ${b.condition.replace(/_/g, ' ')}`}` : `${prevShort} · ${roomName(site, line.roomId)}`} empty={`Not on the walk of ${fmtDayMonth(previous.walk.startedAt)}`} />
        <Side
          bundle={current}
          line={a}
          when={a ? `${curShort} · ${c.status === 'moved' ? roomName(site, a.roomId) : a.kind === 'counted_group' ? `${a.quantity} ${categoryPlural(site, a.categoryId)}` : `graded ${a.condition.replace(/_/g, ' ')}`}` : `${curShort} · ${roomName(site, line.roomId)}`}
          empty={c.status === 'not_seen' ? `Not seen in ${roomName(site, line.roomId)}` : 'No frame'}
        />
        <div className="dms-change__info">
          <Chip status={chip.status}>{chip.text}</Chip>
          <h2 className="ui-title-m">
            {c.quantityDelta && c.quantityAfter !== null && c.quantityBefore !== null ? (
              <>
                {roomName(site, line.roomId)} {categoryPlural(site, line.categoryId)}{' '}
                <span className="data-m" style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>
                  {c.quantityAfter}, was {c.quantityBefore}
                </span>
              </>
            ) : (
              name
            )}
          </h2>
          <p className="ui-body-s muted">{detail}</p>
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      </div>
    );
  };

  return (
    <main className="page">
      <div className="page-head" style={{ paddingTop: 40 }}>
        <div className="page-head__text" style={{ gap: 12 }}>
          <Label>
            {site.name.toUpperCase()} · WALK OF {curDate ? fmtDate(curDate).toUpperCase() : 'TODAY'} · {approved ? `APPROVED BY ${personName(site, current.walk.approvedBy).toUpperCase()}` : 'DRAFT, NOT YET APPROVED'}
          </Label>
          <h1 className="display-l">{comparisonHeadline(result.changeCount, prevDate)}</h1>
          <p className="ui-body muted">
            {plural(lineCount, 'asset line', 'asset lines')} checked. {plural(unchanged.length, 'unchanged', 'unchanged')}.{' '}
            {notFilmedRooms.length
              ? `${plural(notFilmedRooms.length, 'room was', 'rooms were')} not filmed, so nothing is claimed about what is in ${notFilmedRooms.length === 1 ? 'it' : 'them'}.`
              : 'Every room was filmed.'}
          </p>
        </div>
        {notSeenCount ? (
          <div className="big-figure">
            <span className="data-l">{money(notSeenValue)}</span>
            <span className="ui-body-s muted">book value of {plural(notSeenCount, 'line', 'lines')} not seen on this walk</span>
          </div>
        ) : null}
      </div>

      {!approved ? (
        <div style={{ paddingBottom: 16 }}>
          <Note tone="warn" icon="info">
            Draft. This compares the {plural(lineCount, 'line', 'lines')} accepted so far with the walk of {fmtDayMonth(previous.walk.startedAt)}. It becomes the comparison of record when the walk is
            approved.
          </Note>
        </div>
      ) : null}

      <div className="filters" role="group" aria-label="Filter changes" style={{ paddingBottom: 8 }}>
        {filters
          .filter((f) => f.id === 'all' || (counts[f.id] ?? 0) > 0)
          .map((f) => (
            <button key={f.id} type="button" className="dms-btn dms-btn--secondary" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.icon ? <Icon name={f.icon} style={{ color: filter === f.id ? 'currentColor' : f.color }} /> : null}
              {f.label} {counts[f.id] ?? 0}
            </button>
          ))}
      </div>

      <div className="change-list">
        {filter !== 'room_not_filmed' ? shown.map(row) : null}
        {(filter === 'all' || filter === 'room_not_filmed') &&
          notFilmedRooms.map((roomId) => {
            const v = current.rooms.get(roomId);
            const n = notFilmed.filter((c) => before.get(c.beforeLineId ?? '')?.roomId === roomId).length;
            const refilm = v?.refilmRequested;
            return (
              <div key={roomId} className="dms-change">
                <figure className="dms-change__side">
                  <div className="dms-change__empty">
                    {roomName(site, roomId)} was filmed on {fmtDayMonth(previous.walk.startedAt)}
                  </div>
                  <figcaption>
                    {prevShort} · {plural(n, 'asset', 'assets')}
                  </figcaption>
                </figure>
                <figure className="dms-change__side">
                  <div className="dms-change__empty">Not filmed {curDate ? `on ${fmtDayMonth(curDate)}` : 'on this walk'}</div>
                  <figcaption>{curShort} · no footage</figcaption>
                </figure>
                <div className="dms-change__info">
                  <Chip status="not-filmed">Room not filmed</Chip>
                  <h2 className="ui-title-m">{roomName(site, roomId)}</h2>
                  <p className="ui-body-s muted">
                    {v?.status === 'skipped' ? `Skipped: "${v.skipReason}." ` : 'Not filmed on this walk. '}
                    Its {plural(n, 'asset is', 'assets are')} neither seen nor not seen.
                  </p>
                  <div className="row">
                    {refilm ? (
                      <span className="ui-body-s">Refilm requested by {personName(site, refilm.by)}</span>
                    ) : (
                      <Btn
                        onClick={async () => {
                          await requestRefilm(rt, current, roomId, personId, 'Not filmed on this walk');
                          say(`Refilm of ${roomName(site, roomId)} requested`);
                        }}
                      >
                        Request a refilm
                      </Btn>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        {shown.length === 0 && filter !== 'room_not_filmed' && filter !== 'all' ? <p className="ui-body muted" style={{ padding: '18px 0' }}>Nothing in this group.</p> : null}
        {changes.length === 0 && filter === 'all' && notFilmedRooms.length === 0 ? (
          <p className="ui-body muted" style={{ padding: '18px 0', borderTop: '1px solid var(--rule)' }}>
            No changes since the last walk.
          </p>
        ) : null}
        <div style={{ borderTop: '1px solid var(--rule-strong)', borderBottom: showUnchanged ? undefined : '1px solid var(--rule-strong)', padding: '18px 0' }} className="row row--between">
          <span className="row" style={{ gap: 10 }}>
            <Icon name="found" />
            <span className="ui-body-strong">{plural(unchanged.length, 'asset', 'assets')} unchanged</span>
          </span>
          {unchanged.length ? (
            <Btn variant="quiet" onClick={() => setShowUnchanged((s) => !s)}>
              {showUnchanged ? 'Hide unchanged' : 'Show unchanged'}
            </Btn>
          ) : null}
        </div>
        {showUnchanged ? unchanged.map(row) : null}
      </div>
    </main>
  );
}
