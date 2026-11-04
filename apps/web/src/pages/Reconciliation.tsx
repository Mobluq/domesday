import { correctionsFrom, type ReconItem } from '@domesday/domain';
import { useMemo, useState, type ReactElement } from 'react';
import { addFollowup, answerMatch, requestRefilm } from '../data/actions';
import {
  amount,
  categoryName,
  fmtDate,
  fmtDayMonth,
  fmtShortDate,
  framesOf,
  lineNo,
  money,
  personName,
  plural,
  reconciliation,
  registerEntry,
  roomName,
  timecode,
} from '../data/derive';
import { useData, usePersona, useToast } from '../data/store';
import type { Line } from '../data/types';
import { saveFile, urlFor } from '../runtime/media';
import { Btn, Chip, EvidenceFrame, Label, Note } from '../ui/bits';
import { CameraHint } from './Cameras';
import { go } from '../route';

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ReconciliationPage(): ReactElement {
  const { site, current, previous, register, rt } = useData();
  const { personId } = usePersona();
  const { say } = useToast();
  const [showFound, setShowFound] = useState(false);
  const result = useMemo(() => (site && current ? reconciliation(site, register, current) : null), [site, register, current]);
  const frames = useMemo(() => framesOf(current), [current]);
  if (!site || !current || !result) return <main className="page" />;
  if (!register) {
    return (
      <main className="page page--narrow">
        <div className="stack-l" style={{ paddingBlock: '40px' }}>
          <Label>RECONCILIATION · {site.name.toUpperCase()}</Label>
          <h1 className="display-m" style={{ margin: 0 }}>
            Add the register to check this walk against the books
          </h1>
          <p className="ui-body muted" style={{ margin: 0 }}>
            Export the fixed asset register from Excel, Sage or your ERP as CSV and bring it in from Site setup. Each approved walk is then reconciled against it: what was found,
            what was found in another room, what wasn't seen, and what isn't in the books at all.
          </p>
          <div>
            <Btn variant="primary" icon="books" onClick={() => go('site')}>
              Import the register
            </Btn>
          </div>
        </div>
      </main>
    );
  }

  const approved = current.walk.status === 'approved';
  const lines = new Map(current.lines.map((l) => [l.id, l]));
  const reg = (id: string | null) => registerEntry(register, id);
  const by = (s: ReconItem['status']) => result.items.filter((i) => i.status === s);
  const notSeen = by('not_seen');
  const notFilmed = by('room_not_filmed');
  const elsewhere = by('found_elsewhere');
  const unrecorded = by('unrecorded');
  const found = by('found');
  const notFilmedRooms = [...new Set(notFilmed.map((i) => i.bookRoomId).filter((r): r is string => Boolean(r)))];
  const corrections = correctionsFrom(result);
  const lastSeen = (registerId: string | null): string => {
    if (!registerId || !previous) return 'Never';
    const l = previous.lines.find((x) => x.registerId === registerId && x.status === 'accepted');
    return l ? fmtShortDate(previous.walk.startedAt) : 'Never';
  };
  const walkDate = current.walk.startedAt ? fmtDate(current.walk.startedAt) : 'today';

  const thumb = (l: Line | undefined): ReactElement | null => {
    const e = l?.evidence.find((x) => x.box) ?? l?.evidence[0];
    const hit = e ? frames.get(e.frameId) : undefined;
    if (!l || !hit) return null;
    return (
      <div style={{ width: 120, flex: 'none' }}>
        <EvidenceFrame src={urlFor(hit.frame.ref)} alt={l.description} imageW={hit.frame.w} imageH={hit.frame.h} regions={e?.box ? [{ box: e.box }] : []} />
      </div>
    );
  };

  const exportCsv = async (): Promise<void> => {
    const header = ['Correction', 'Register ID', 'Description', 'Category', 'Quantity', 'In the books at', 'Seen in', 'Walk', 'Line', 'Evidence', 'Approved by'];
    const rows = corrections.map((c) => {
      const l = lines.get(c.lineId);
      const ev = l ? l.evidence.map((e) => frames.get(e.frameId)).filter(Boolean).map((h) => (h?.frame.label ? 'label shot' : timecode(h?.frame.t))).join(' · ') : '';
      if (c.kind === 'new_line') {
        return ['New line to add', '', l?.description ?? '', categoryName(site, l?.categoryId), c.quantity, '', roomName(site, c.roomId), walkDate, lineNo(current, c.lineId), `${roomName(site, c.roomId)} clip, frames ${ev}`, personName(site, l?.decision?.by)];
      }
      const r = reg(c.registerId);
      return ['Location to change', c.registerId, r?.description ?? l?.description ?? '', categoryName(site, l?.categoryId), l?.quantity ?? 1, r?.locationLabel ?? roomName(site, c.fromRoomId), roomName(site, c.toRoomId), walkDate, lineNo(current, c.lineId), `${roomName(site, c.toRoomId)} clip, frames ${ev}`, personName(site, l?.decision?.by)];
    });
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const name = `corrections-${site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(current.walk.startedAt ?? new Date().toISOString()).slice(0, 10)}.csv`;
    const r = await saveFile(rt, name, `\uFEFF${csv}\r\n`, 'text/csv');
    if (r === 'saved') say(`${name} saved`);
    else if (r === 'unavailable') say('Saving files is not available in this view', 'error');
  };

  return (
    <main className="page">
      <div className="page-head" style={{ paddingTop: 40 }}>
        <div className="page-head__text" style={{ gap: 12 }}>
          <Label>
            {site.name.toUpperCase()} · WALK OF {walkDate.toUpperCase()} AGAINST THE REGISTER IMPORTED ON {fmtDayMonth(register.importedAt).toUpperCase()}
          </Label>
          <h1 className="display-l">
            {notSeen.length
              ? `${plural(notSeen.length, 'register line', 'register lines')} not seen at ${site.name}, with a book value of ${money(result.notSeenValueKobo)}`
              : `Every register line in the filmed rooms was found`}
          </h1>
          <p className="ui-body muted">
            {notFilmed.length
              ? `${plural(notFilmed.length, 'more line', 'more lines')}, worth ${money(result.roomNotFilmedValueKobo)}, ${notFilmed.length === 1 ? 'is' : 'are'} in ${plural(notFilmedRooms.length, 'room', 'rooms')} that ${notFilmedRooms.length === 1 ? 'was' : 'were'} not filmed. Nothing is claimed about them until those rooms are filmed.`
              : 'Every room with register lines was filmed.'}
          </p>
        </div>
        <div className="page-head__actions">
          {notFilmedRooms.length ? (
            <Btn
              onClick={async () => {
                for (const r of notFilmedRooms) await requestRefilm(rt, current, r, personId, 'Register lines here were not checked');
                say(`Refilm requested for ${plural(notFilmedRooms.length, 'room', 'rooms')}`);
              }}
            >
              Request refilm of {plural(notFilmedRooms.length, 'room', 'rooms')}
            </Btn>
          ) : null}
          <Btn variant="primary" icon="download" onClick={() => void exportCsv()} disabled={corrections.length === 0}>
            Export corrections
          </Btn>
        </div>
      </div>

      {!approved ? (
        <div style={{ paddingBottom: 16 }}>
          <Note tone="warn" icon="info">
            Draft. Reconciliation of record runs when the walk is approved. This uses the {plural(found.length + elsewhere.length + unrecorded.length, 'line', 'lines')} accepted so far.
          </Note>
        </div>
      ) : null}

      <section aria-label="Summary" className="section" style={{ paddingTop: 0, paddingBottom: 32 }}>
        <dl className="kpis" style={{ margin: 0 }}>
          <div>
            <dt>
              <Chip status="confirmed" quiet>
                Found
              </Chip>
            </dt>
            <dd style={{ margin: 0 }}>
              <span className="data-l">{found.length}</span> <span className="ui-body-s muted">where the books say</span>
            </dd>
          </div>
          <div>
            <dt>
              <Chip status="found-elsewhere" quiet>
                Found elsewhere
              </Chip>
            </dt>
            <dd style={{ margin: 0 }}>
              <span className="data-l">{elsewhere.length}</span> <span className="ui-body-s muted">in the books somewhere else</span>
            </dd>
          </div>
          <div>
            <dt>
              <Chip status="unrecorded" quiet>
                Unrecorded
              </Chip>
            </dt>
            <dd style={{ margin: 0 }}>
              <span className="data-l">{unrecorded.length}</span> <span className="ui-body-s muted">seen and approved, not in the books</span>
            </dd>
          </div>
          <div>
            <dt>
              <Chip status="not-seen" quiet>
                Not seen on this walk
              </Chip>
            </dt>
            <dd style={{ margin: 0 }}>
              <span className="data-l">{notSeen.length}</span> <span className="ui-body-s muted">· {money(result.notSeenValueKobo)}</span>
            </dd>
          </div>
          <div>
            <dt>
              <Chip status="not-filmed" quiet>
                Room not filmed
              </Chip>
            </dt>
            <dd style={{ margin: 0 }}>
              <span className="data-l">{notFilmed.length}</span> <span className="ui-body-s muted">· {money(result.roomNotFilmedValueKobo)}</span>
            </dd>
          </div>
        </dl>
      </section>

      <div className="stack-l" style={{ paddingBottom: 48 }}>
        {result.candidates.length ? (
          <section className="stack-m" aria-label="Matches to confirm">
            <div className="row row--between">
              <h2 className="ui-title-m">Confirm {plural(result.candidates.length, 'match', 'matches')}</h2>
              <Btn
                icon="found"
                onClick={async () => {
                  for (const c of result.candidates) await answerMatch(rt, current, { registerId: c.registerId, lineId: c.lineId, decision: 'confirmed', by: personId, score: c.score });
                  say(`${plural(result.candidates.length, 'match', 'matches')} confirmed`);
                }}
              >
                Confirm all {result.candidates.length} shown
              </Btn>
            </div>
            <p className="ui-body-s muted">No tag or serial was read for these, so they are matched on description, category and room. A person confirms each one before it counts.</p>
            <div>
              {result.candidates.map((c) => {
                const l = lines.get(c.lineId);
                const r = reg(c.registerId);
                return (
                  <div key={`${c.registerId}|${c.lineId}`} className="match-card">
                    <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                      {thumb(l)}
                      <div className="stack-xs">
                        <span className="ui-body-s muted">Seen · line {lineNo(current, c.lineId)}</span>
                        <span className="ui-body-strong">{l?.description}</span>
                        <span className="ui-body-s muted">
                          {roomName(site, l?.roomId)} · {l?.quantity && l.quantity > 1 ? `${l.quantity} counted` : categoryName(site, l?.categoryId)}
                        </span>
                      </div>
                    </div>
                    <div className="stack-xs">
                      <span className="ui-body-s muted">
                        In the books · <span className="data-s">{c.registerId}</span>
                      </span>
                      <span className="ui-body-strong">{r?.description}</span>
                      <span className="ui-body-s muted">
                        {r?.locationLabel} · {money(r?.bookValueKobo)} · score {c.score}
                      </span>
                      <span className="ui-body-s faint">{c.reasons.join(' · ')}</span>
                    </div>
                    <div className="row">
                      <Btn
                        variant="primary"
                        icon="found"
                        onClick={async () => {
                          await answerMatch(rt, current, { registerId: c.registerId, lineId: c.lineId, decision: 'confirmed', by: personId, score: c.score });
                          say(`Matched ${c.registerId}`);
                        }}
                      >
                        Same item
                      </Btn>
                      <Btn
                        variant="quiet"
                        onClick={async () => {
                          await answerMatch(rt, current, { registerId: c.registerId, lineId: c.lineId, decision: 'rejected', by: personId, score: c.score });
                          say('Marked as different items');
                        }}
                      >
                        Different
                      </Btn>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="stack-m" aria-label="Not seen on this walk">
          <div className="row row--between">
            <h2 className="ui-title-m">Not seen on this walk</h2>
            <span className="ui-body-s muted">Matched by tag, then serial, then description, category and room.</span>
          </div>
          {notSeen.length === 0 ? (
            <p className="ui-body muted">Nothing in the filmed rooms is unaccounted for.</p>
          ) : (
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 760 }}>
                <thead>
                  <tr>
                    <th scope="col">Register line</th>
                    <th scope="col">Description</th>
                    <th scope="col">In the books at</th>
                    <th scope="col">Last seen</th>
                    <th scope="col" className="num">
                      Book value, ₦
                    </th>
                    <th scope="col">
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {notSeen.map((i) => {
                    const r = reg(i.registerId);
                    const inv = current.followups.find((f) => f.kind === 'investigation' && f.registerId === i.registerId && f.status === 'open');
                    return (
                      <tr key={`${i.registerId}|${i.lineId ?? ''}`}>
                        <td className="data">{i.registerId}</td>
                        <td>{i.partOfGroup ? `${r?.description.replace(/\s*\(\d+\)$/, '')}, ${i.notSeenQuantity} of ${i.quantityInBooks}` : r?.description}</td>
                        <td>{r?.locationLabel}</td>
                        <td className="data muted">{i.partOfGroup ? fmtShortDate(current.walk.startedAt) || 'This walk' : lastSeen(i.registerId)}</td>
                        <td className="num">{amount(i.valueKobo)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <CameraHint roomId={i.bookRoomId} registerId={i.registerId} />
                          {inv ? (
                            <span className="ui-body-s">Assigned to {personName(site, inv.owner)}</span>
                          ) : (
                            <Btn
                              variant="quiet"
                              style={{ minHeight: 40 }}
                              onClick={async () => {
                                const owner = site.people.find((p) => p.role === 'site_manager')?.id ?? personId;
                                await addFollowup(rt, current, { kind: 'investigation', title: `${r?.description ?? i.registerId} not seen`, registerId: i.registerId, roomId: i.bookRoomId, owner, due: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) }, personId);
                                say(`Investigation assigned to ${personName(site, owner)}`);
                              }}
                            >
                              Investigate
                            </Btn>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>{plural(notSeen.length, 'line', 'lines')} not seen</td>
                    <td className="num">{money(result.notSeenValueKobo)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {result.notSeenWithoutValue ? <span className="ui-body-s muted">{plural(result.notSeenWithoutValue, 'line has', 'lines have')} no book value in the register.</span> : null}
        </section>

        {notFilmedRooms.length ? (
          <section aria-label="Rooms not filmed" style={{ padding: 16, background: 'var(--not-filmed-tint)', borderRadius: 'var(--radius-s)' }} className="stack-s">
            <Chip status="not-filmed" quiet>
              Room not filmed · {plural(notFilmed.length, 'line', 'lines')} · {money(result.roomNotFilmedValueKobo)}
            </Chip>
            <span className="ui-body-s" style={{ color: 'var(--not-filmed-text)' }}>
              {notFilmedRooms
                .map((roomId) => {
                  const items = notFilmed.filter((i) => i.bookRoomId === roomId);
                  return `${roomName(site, roomId)} (${plural(items.length, 'line', 'lines')}, ${money(items.reduce((s, i) => s + (i.valueKobo ?? 0), 0))})`;
                })
                .join(', ')}
              .{result.roomNotFilmedValueKobo > result.notSeenValueKobo ? ' More of the value at risk is in rooms nobody filmed than in lines not seen.' : ''}
            </span>
          </section>
        ) : null}

        {elsewhere.length ? (
          <section className="stack-m" aria-label="Found elsewhere">
            <h2 className="ui-title-m">Found elsewhere</h2>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th scope="col">Register line</th>
                    <th scope="col">Description</th>
                    <th scope="col">The books say</th>
                    <th scope="col">Seen in</th>
                    <th scope="col">Matched by</th>
                  </tr>
                </thead>
                <tbody>
                  {elsewhere.map((i) => {
                    const r = reg(i.registerId);
                    return (
                      <tr key={i.registerId}>
                        <td className="data">{i.registerId}</td>
                        <td>{r?.description}</td>
                        <td>{r?.locationLabel}</td>
                        <td>
                          {roomName(site, i.seenRoomId)} <span className="ui-body-s muted">· line {lineNo(current, i.lineId ?? '')}</span>
                        </td>
                        <td>{i.method === 'tag' ? 'Asset tag' : i.method === 'serial' ? 'Serial number' : `Description, confirmed (score ${i.score ?? ''})`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {unrecorded.length ? (
          <section className="stack-m" aria-label="Unrecorded">
            <div className="row row--between">
              <h2 className="ui-title-m">Unrecorded</h2>
              <span className="ui-body-s muted">Seen, approved and not in the books. Each is a new line in the corrections file.</span>
            </div>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Description</th>
                    <th scope="col">Category</th>
                    <th scope="col">Room</th>
                    <th scope="col" className="num">
                      Quantity
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {unrecorded.map((i) => {
                    const l = lines.get(i.lineId ?? '');
                    return (
                      <tr key={i.lineId}>
                        <td className="data">{lineNo(current, i.lineId ?? '')}</td>
                        <td>{l?.description}</td>
                        <td>{categoryName(site, l?.categoryId)}</td>
                        <td>{roomName(site, l?.roomId)}</td>
                        <td className="num">{l?.quantity}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="stack-s" aria-label="Found">
          <div className="row row--between" style={{ borderTop: '1px solid var(--rule-strong)', borderBottom: showFound ? undefined : '1px solid var(--rule-strong)', padding: '16px 0' }}>
            <span className="ui-body-strong">{plural(found.length, 'line', 'lines')} found where the books say</span>
            {found.length ? (
              <Btn variant="quiet" onClick={() => setShowFound((s) => !s)}>
                {showFound ? 'Hide' : 'Show'}
              </Btn>
            ) : null}
          </div>
          {showFound ? (
            <div className="table-wrap" style={{ borderTop: 0 }}>
              <table className="table" style={{ minWidth: 560 }}>
                <tbody>
                  {found.map((i) => {
                    const r = reg(i.registerId);
                    return (
                      <tr key={i.registerId}>
                        <td className="data">{i.registerId}</td>
                        <td>{r?.description}</td>
                        <td>{r?.locationLabel}</td>
                        <td className="ui-body-s muted">
                          line {lineNo(current, i.lineId ?? '')} · {i.method === 'tag' ? 'tag' : i.method === 'serial' ? 'serial' : 'description, confirmed'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <p className="ui-body-s muted" style={{ maxWidth: 760 }}>
          The corrections file lists {plural(corrections.filter((c) => c.kind === 'new_line').length, 'line', 'lines')} to add and {plural(corrections.filter((c) => c.kind === 'location_change').length, 'location', 'locations')} to change, one row each with the walk, the line
          number and the frames it came from. Nothing is proposed for write-off until an investigation records an outcome. Register: {register.fileName}, imported by {personName(site, register.importedBy)}.
        </p>
      </div>
    </main>
  );
}
