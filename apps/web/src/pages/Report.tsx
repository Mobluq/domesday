import {
  ChangeStatus,
  ConditionGrade,
  UI_COPY,
  canonicalReportText,
  capitalisationFlag,
  comparisonHeadline,
  formatVerificationCode,
  verificationCodeFromDigest,
  type CompareWalksResult,
  type ReconcileResult,
} from '@domesday/domain';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { sha256Text, toHex } from '../capture/fingerprint';
import { issueReport } from '../data/actions';
import {
  amount,
  approvedLines,
  categoryName,
  comparison,
  duration,
  fmtDate,
  fmtDateTime,
  fmtDayMonth,
  fmtTime,
  lineNo,
  money,
  personName,
  plural,
  reconciliation,
  registerEntry,
  roomName,
} from '../data/derive';
import { useData, usePersona, useToast, type WalkBundle } from '../data/store';
import type { Register, ReportRecord, Site } from '../data/types';
import { saveFile } from '../runtime/media';
import { Btn, Label, Note } from '../ui/bits';
import { Hallmark } from '../ui/brand';

/** The report's text, as hashed for the verification code: everything a reader sees except the code itself. */
export function reportText(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('[data-dms-code]').forEach((n) => n.remove());
  return canonicalReportText(clone.textContent ?? '');
}

export async function codeForText(text: string): Promise<{ code: string; digestHex: string }> {
  const digest = await sha256Text(text);
  return { code: verificationCodeFromDigest(digest), digestHex: toHex(digest) };
}

interface ReportModel {
  site: Site;
  current: WalkBundle;
  previous: WalkBundle | null;
  register: Register | null;
  cmp: CompareWalksResult | null;
  recon: ReconcileResult;
  number: string;
  issuedAt: string | null;
  issuedBy: string | null;
  code: string | null;
}

function Running({ m, page }: { m: ReportModel; page: number }): ReactElement {
  return (
    <header className="running">
      <span>
        {m.site.name} · Asset verification report · {fmtDate(m.current.walk.startedAt)}
      </span>
      <span>Page {page}</span>
    </header>
  );
}

function Foot({ m }: { m: ReportModel }): ReactElement {
  return (
    <footer className="foot">
      <span>{UI_COPY.evidenceBy}</span>
      <span style={{ fontFamily: 'var(--font-mono)' }} data-dms-code="">
        {m.code ? `Verification code ${formatVerificationCode(m.code)}` : 'Draft, not issued'}
      </span>
    </footer>
  );
}

function ReportSheets({ m }: { m: ReportModel }): ReactElement {
  const { site, current, previous, register, cmp, recon } = m;
  const rooms = site.rooms;
  const visits = rooms.map((r) => current.rooms.get(r.id));
  const filmed = visits.filter((v) => v?.status === 'filmed');
  const skipped = rooms.filter((r) => current.rooms.get(r.id)?.status === 'skipped');
  const lines = approvedLines(current);
  const allDecided = current.lines.filter((l) => l.status !== 'proposed');
  const proposed = current.lines.filter((l) => l.proposedBy.kind === 'recogniser').length;
  const lowDecided = current.lines.filter((l) => l.proposedBy.kind === 'recogniser' && l.band === 'low').length;
  const capturers = current.walk.capturedBy.map((p) => personName(site, p));
  const times = filmed.map((v) => v?.filmedAt).filter((t): t is string => Boolean(t)).sort();
  const minutes = filmed.reduce((s, v) => s + (v?.clip?.durationS ?? 0), 0);
  const devices = [...new Set(filmed.map((v) => (v?.clip?.source === 'sample' ? 'sample footage' : v?.clip?.device)).filter(Boolean))];
  const frames = filmed.reduce((s, v) => s + (v?.frames.length ?? 0), 0);
  const labels = filmed.reduce((s, v) => s + (v?.labelShots.length ?? 0), 0);
  const blurred = filmed.reduce((s, v) => s + (v?.analysis.privacy ? v.analysis.privacy.faces + v.analysis.privacy.screens + v.analysis.privacy.documents : 0), 0);
  const notSeen = recon.items.filter((i) => i.status === 'not_seen');
  const notFilmed = recon.items.filter((i) => i.status === 'room_not_filmed');
  const count = (s: string): number => recon.items.filter((i) => i.status === s).length;
  const changes = cmp ? cmp.items.filter((c) => c.status !== 'unchanged') : [];
  const lineById = new Map([...current.lines, ...(previous?.lines ?? [])].map((l) => [l.id, l]));

  return (
    <>
      <section className="sheet" aria-label="Cover">
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 24 }}>
          <div style={{ width: 168, height: 56, border: '1px dashed #636b61', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-sans)', fontSize: 12, color: '#545b53' }}>[Tenant logo]</div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#545b53' }}>Report {m.number}</span>
        </header>
        <section style={{ marginTop: 'clamp(48px, 14vw, 168px)', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <span className="eyebrow">ASSET VERIFICATION REPORT</span>
          <h1>
            {site.name}, walk of {fmtDate(current.walk.startedAt)}
          </h1>
          <p style={{ fontSize: 21, lineHeight: '30px', fontStyle: 'italic', color: '#383e37', maxWidth: 520 }}>{UI_COPY.reportCoverMethod}</p>
        </section>
        <dl className="cover-dl" style={{ marginTop: 56 }}>
          <dt>Scope</dt>
          <dd>
            One site, {plural(rooms.length, 'room', 'rooms')}. {filmed.length} filmed, {rooms.length - filmed.length} not filmed.
          </dd>
          <dt>Walk</dt>
          <dd>
            {fmtDate(current.walk.startedAt)}
            {times.length && fmtTime(times[0]) !== fmtTime(current.walk.finishedAt ?? times[times.length - 1]) ? `, ${fmtTime(times[0])} to ${fmtTime(current.walk.finishedAt ?? times[times.length - 1])}` : times.length ? `, at ${fmtTime(times[0])}` : ''}. {duration(minutes)} of video
            {capturers.length ? `, filmed by ${capturers.join(' and ')}` : ''}.
          </dd>
          <dt>Review</dt>
          <dd>
            {plural(allDecided.length, 'asset line', 'asset lines')}, each decided by a named reviewer.{' '}
            {current.walk.approvedBy ? `Walk approved by ${personName(site, current.walk.approvedBy)}.` : 'Walk not yet approved.'}
          </dd>
          <dt>Books</dt>
          <dd>Reconciled with the fixed asset register imported on {fmtDate(register?.importedAt)}.</dd>
          <dt>Issued</dt>
          <dd>{m.issuedAt ? `${fmtDateTime(m.issuedAt)}, by ${personName(site, m.issuedBy)}` : 'Not issued'}</dd>
        </dl>
        <footer style={{ marginTop: 'auto', paddingTop: 48, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 24 }}>
          <div className="dms-verify" data-dms-code="">
            <Hallmark size={48} title="Domesday hallmark" />
            <div>
              <span className="dms-verify__by" style={{ color: '#545b53' }}>
                {UI_COPY.evidenceBy}
              </span>
              <span className="dms-verify__code" style={{ color: '#141815' }}>
                {m.code ? formatVerificationCode(m.code) : '•••• •••• ••••'}
              </span>
            </div>
          </div>
          <p style={{ maxWidth: 300, fontSize: 13, lineHeight: '19px', color: '#545b53', textAlign: 'right' }}>
            Anyone with this code can confirm this report is genuine and unchanged, without seeing what it contains.
          </p>
        </footer>
      </section>

      <section className="sheet" aria-label="Method and findings">
        <Running m={m} page={2} />
        <section style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <h2>1. Method and limits</h2>
          <p>
            <strong style={{ fontWeight: 600 }}>What was filmed.</strong> {filmed.length} of {rooms.length} rooms were filmed on {fmtDate(current.walk.startedAt)}
            {times.length ? (fmtTime(times[0]) === fmtTime(times[times.length - 1]) ? ` at ${fmtTime(times[0])}` : ` between ${fmtTime(times[0])} and ${fmtTime(times[times.length - 1])}`) : ''}
            {capturers.length ? ` by ${capturers.join(' and ')}` : ''}
            {devices.length ? `, using ${devices.join(' and ')}` : ''}. Each clip was fingerprinted with SHA-256 on the phone the moment it was handed over. In this demo the clips stay on the phone; their
            fingerprints and the frames picked from them are kept with the walk.
          </p>
          <p>
            <strong style={{ fontWeight: 600 }}>What was not filmed.</strong>{' '}
            {skipped.length
              ? `${skipped.map((r) => `${r.name} ("${current.rooms.get(r.id)?.skipReason ?? ''}")`).join(', ')} ${skipped.length === 1 ? 'was' : 'were'} skipped, with the reason recorded at the time. The ${plural(notFilmed.length, 'register line', 'register lines')} in rooms not filmed ${notFilmed.length === 1 ? 'is' : 'are'} reported as room not filmed, and this report makes no claim about ${notFilmed.length === 1 ? 'it' : 'them'}.`
              : 'Every room on the site list was filmed.'}
          </p>
          <p>
            <strong style={{ fontWeight: 600 }}>How each line was confirmed.</strong> The recogniser proposed {plural(proposed, 'asset line', 'asset lines')} from {plural(frames, 'frame', 'frames')}
            {labels ? ` and ${plural(labels, 'label shot', 'label shots')}` : ''}. A named reviewer accepted, edited, merged, split or rejected every one
            {lowDecided ? (lowDecided === 1 ? ', and decided the one low-confidence line on its own' : `, and decided the ${lowDecided} low-confidence lines one at a time`) : ''}. No line appears here without a reviewer's decision. The person who filmed a
            room did not approve its lines.
          </p>
          <p>
            <strong style={{ fontWeight: 600 }}>What Domesday cannot prove.</strong> It shows what was seen, where, when and by whom, and that the footage has not changed since it was fingerprinted. It does not prove
            who owns an asset or what it is worth. Book values come from the register. Serial numbers and tags appear only where a plate or tag could be read in a frame.
          </p>
          <p>
            <strong style={{ fontWeight: 600 }}>Privacy.</strong> Every frame was checked for faces, screens and documents before anyone reviewed it{blurred ? `, and ${plural(blurred, 'region was', 'regions were')} blurred` : ', and none were found'}. Audio was not used.
          </p>
        </section>
        <section style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>2. Findings against the books</h2>
          <table className="rtable">
            <thead>
              <tr>
                <th scope="col">STATUS</th>
                <th scope="col" className="num">
                  LINES
                </th>
                <th scope="col" className="num">
                  BOOK VALUE, ₦
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Found where the books say</td>
                <td className="num">{count('found')}</td>
                <td className="num" style={{ color: '#545b53' }}>
                  in annex A
                </td>
              </tr>
              <tr>
                <td>Found elsewhere, in the books at another location</td>
                <td className="num">{count('found_elsewhere')}</td>
                <td className="num" style={{ color: '#545b53' }}>
                  in annex A
                </td>
              </tr>
              <tr>
                <td>Unrecorded, seen but not in the books</td>
                <td className="num">{count('unrecorded')}</td>
                <td className="num" style={{ color: '#545b53' }}>
                  none in the books
                </td>
              </tr>
              <tr>
                <td>Not seen on this walk</td>
                <td className="num">{count('not_seen')}</td>
                <td className="num">{amount(recon.notSeenValueKobo)}</td>
              </tr>
              <tr>
                <td>In rooms not filmed</td>
                <td className="num">{count('room_not_filmed')}</td>
                <td className="num">{amount(recon.roomNotFilmedValueKobo)}</td>
              </tr>
            </tbody>
          </table>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: 12, lineHeight: '18px', color: '#545b53' }}>
            "Not seen" is a question for the site, not a finding of loss. Each line stays "not seen on this walk" until someone investigates and records an outcome.
          </p>
        </section>
        <Foot m={m} />
      </section>

      <section className="sheet" aria-label="Not seen and changes">
        <Running m={m} page={3} />
        <section style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>3. Not seen on this walk</h2>
          {notSeen.length ? (
            <table className="rtable">
              <thead>
                <tr>
                  <th scope="col">REGISTER LINE</th>
                  <th scope="col">DESCRIPTION</th>
                  <th scope="col">IN THE BOOKS AT</th>
                  <th scope="col" className="num">
                    BOOK VALUE, ₦
                  </th>
                </tr>
              </thead>
              <tbody>
                {notSeen.map((i) => {
                  const r = registerEntry(register, i.registerId);
                  return (
                    <tr key={`${i.registerId}|${i.lineId ?? ''}`}>
                      <td className="mono">{i.registerId}</td>
                      <td>{i.partOfGroup ? `${r?.description.replace(/\s*\(\d+\)$/, '')}, ${i.notSeenQuantity} of ${i.quantityInBooks}` : r?.description}</td>
                      <td>{r?.locationLabel}</td>
                      <td className="num">{amount(i.valueKobo)}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={3} style={{ fontWeight: 600 }}>
                    {plural(notSeen.length, 'line', 'lines')} not seen
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {amount(recon.notSeenValueKobo)}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p>Every register line in a filmed room was found.</p>
          )}
        </section>
        {cmp && previous ? (
          <section style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2>4. Changes since the last walk</h2>
            <p>{comparisonHeadline(cmp.changeCount, new Date(previous.walk.startedAt ?? Date.now()))}. {plural(cmp.unchangedCount, 'asset line was', 'asset lines were')} unchanged.</p>
            <table className="rtable">
              <thead>
                <tr>
                  <th scope="col">STATUS</th>
                  <th scope="col">ASSET</th>
                  <th scope="col">ROOM</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => {
                  const b = c.beforeLineId ? lineById.get(c.beforeLineId) : undefined;
                  const a = c.afterLineId ? lineById.get(c.afterLineId) : undefined;
                  const l = a ?? b;
                  return (
                    <tr key={`${c.beforeLineId ?? ''}|${c.afterLineId ?? ''}`}>
                      <td>{ChangeStatus.label(c.status)}</td>
                      <td>
                        {categoryName(site, l?.categoryId)}
                        {c.quantityDelta && c.quantityBefore !== null && c.quantityAfter !== null ? `, ${c.quantityAfter}, was ${c.quantityBefore}` : ''}
                        {(c.status === 'condition_worse' || c.status === 'condition_better') && b && a ? `, ${ConditionGrade.label(b.condition).toLowerCase()} to ${ConditionGrade.label(a.condition).toLowerCase()}` : ''}
                      </td>
                      <td>{c.status === 'moved' ? `${roomName(site, c.from?.roomId)} to ${roomName(site, c.to?.roomId)}` : roomName(site, l?.roomId)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ) : null}
        <Foot m={m} />
      </section>

      <section className="sheet" aria-label="Annex A">
        <Running m={m} page={4} />
        <section style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>Annex A. Approved asset lines</h2>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: '19px', color: '#545b53' }}>
            Each line was decided by the named reviewer. Make, model, serial and tag appear only where they were read from a frame or entered by a reviewer. Capitalisation threshold {money(site.thresholdKobo)}.
          </p>
          <table className="rtable">
            <thead>
              <tr>
                <th scope="col">LINE</th>
                <th scope="col">ASSET</th>
                <th scope="col">ROOM</th>
                <th scope="col" className="num">
                  QTY
                </th>
                <th scope="col">CONDITION</th>
                <th scope="col">READ</th>
                <th scope="col">DECIDED BY</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const r = recon.items.find((i) => i.lineId === l.id && i.registerId);
                const entry = registerEntry(register, r?.registerId ?? null);
                const flag = capitalisationFlag({ unitCostKobo: entry && entry.costKobo !== null ? Math.round(entry.costKobo / Math.max(1, entry.quantity)) : null, thresholdKobo: site.thresholdKobo });
                const reads = [l.make?.value, l.model?.value, l.serial ? `SN ${l.serial.value}` : null, l.tagCode ? `Tag ${l.tagCode.value}` : null].filter(Boolean).join(' · ');
                return (
                  <tr key={l.id}>
                    <td className="mono">{lineNo(current, l.id)}</td>
                    <td>
                      {categoryName(site, l.categoryId)}
                      {entry ? <span style={{ color: '#545b53' }}> · {entry.registerId}</span> : null}
                      {flag.belowThreshold ? <span style={{ color: '#545b53' }}> · {flag.label}</span> : null}
                    </td>
                    <td>{roomName(site, l.roomId)}</td>
                    <td className="num">{l.quantity}</td>
                    <td>{ConditionGrade.label(l.condition)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {reads}
                    </td>
                    <td>{personName(site, l.decision?.by)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        <Foot m={m} />
      </section>
    </>
  );
}

const REPORT_CSS = `
:root{--font-display:"Newsreader",Georgia,serif;--font-sans:"Atkinson Hyperlegible Next",system-ui,sans-serif;--font-mono:"Atkinson Hyperlegible Mono",ui-monospace,monospace;--text:#141815;--surface:#ffffff;--rubric:#d4402a}
body{margin:0;background:#e9ebe6;color:#141815;font-family:var(--font-sans)}
main{display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px 12px}
.sheet{width:100%;max-width:794px;min-height:1123px;box-sizing:border-box;padding:64px 72px 56px;background:#fff;display:flex;flex-direction:column;font-family:var(--font-display);box-shadow:0 12px 32px rgba(20,24,21,.12)}
.sheet h1{font-weight:500;font-size:52px;line-height:1.07;letter-spacing:-.02em;margin:0}
.sheet h2{font-weight:500;font-size:26px;line-height:32px;margin:0 0 4px}
.sheet p{font-size:16px;line-height:24px;margin:0}
.eyebrow{font-family:var(--font-sans);font-size:12px;letter-spacing:.08em;font-weight:700;color:#545b53}
.running{display:flex;justify-content:space-between;gap:24px;padding-bottom:10px;border-bottom:1px solid #c9cec6;font-family:var(--font-sans);font-size:12px;color:#545b53}
.foot{margin-top:auto;padding-top:10px;border-top:1px solid #c9cec6;display:flex;justify-content:space-between;gap:24px;font-family:var(--font-sans);font-size:12px;color:#545b53}
.rtable{width:100%;border-collapse:collapse;font-size:14px;line-height:20px}
.rtable th{text-align:left;padding:8px 8px 8px 0;border-top:1px solid #141815;border-bottom:1px solid #141815;font-family:var(--font-sans);font-size:11px;letter-spacing:.06em;color:#545b53}
.rtable td{padding:8px 8px 8px 0;border-bottom:1px solid #c9cec6;vertical-align:top}
.num{text-align:right;font-family:var(--font-mono);font-size:13px;white-space:nowrap}
.rtable th.num{font-family:var(--font-sans);font-size:11px}
.mono{font-family:var(--font-mono);font-size:13px}
.cover-dl{display:grid;grid-template-columns:150px 1fr;border-top:1px solid #141815;margin:0}
.cover-dl dt{padding:12px 0;border-bottom:1px solid #c9cec6;font-family:var(--font-sans);font-size:13px;color:#545b53}
.cover-dl dd{margin:0;padding:12px 0;border-bottom:1px solid #c9cec6;font-size:16px;line-height:22px}
.dms-verify{display:inline-flex;align-items:center;gap:14px}
.dms-verify__by{display:block;font:700 11px/14px var(--font-sans);letter-spacing:.08em;text-transform:uppercase}
.dms-verify__code{display:block;font:500 20px/26px var(--font-mono);letter-spacing:.04em}
@page{size:A4;margin:0}
@media print{body{background:#fff}main{padding:0;gap:0}.sheet{box-shadow:none;page-break-after:always;max-width:none;width:210mm;min-height:297mm}}
`;

export function ReportPage(): ReactElement {
  const { site, current, previous, register, reports, rt } = useData();
  const { personId } = usePersona();
  const { say } = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<{ issuedAt: string; number: string } | null>(null);
  const [liveDigest, setLiveDigest] = useState<string | null>(null);
  const issuing = useRef(false);

  const cmp = useMemo(() => (site && current && previous ? comparison(site, current, previous) : null), [site, current, previous]);
  const recon = useMemo(() => (site && current ? reconciliation(site, register, current) : null), [site, register, current]);
  const issued = useMemo(() => (current ? [...reports].filter((r) => r.walkId === current.walk.id).sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1)) : []), [reports, current]);
  const latest = issued[0] ?? null;
  const approved = current?.walk.status === 'approved';
  const dateKey = (current?.walk.startedAt ?? new Date().toISOString()).slice(0, 10).replace(/-/g, '');
  const number = pending?.number ?? latest?.number ?? `DMS-${dateKey}-${String(issued.length + 1).padStart(3, '0')}`;
  const issuedAt = pending?.issuedAt ?? latest?.issuedAt ?? null;
  const issuedBy = pending ? personId : (latest?.issuedBy ?? null);
  const code = pending ? null : (latest?.code ?? null);

  // Hash what is on screen. When issuing, the digest becomes the report's code.
  useEffect(() => {
    if (!ref.current) return;
    const text = reportText(ref.current);
    let live = true;
    void codeForText(text).then(async ({ code: c, digestHex }) => {
      if (!live) return;
      setLiveDigest(digestHex);
      if (pending && site && current && !issuing.current) {
        issuing.current = true;
        const record: ReportRecord = { code: c, number: pending.number, walkId: current.walk.id, siteName: site.name, title: `${site.name}, walk of ${fmtDate(current.walk.startedAt)}`, issuedAt: pending.issuedAt, issuedBy: personId, digestHex, pages: 4 };
        try {
          await issueReport(rt, record);
          say(`Report issued. Verification code ${formatVerificationCode(c)}`);
        } catch (e) {
          say(`The report could not be issued: ${String((e as Error).message ?? e)}`, 'error');
        } finally {
          issuing.current = false;
          setPending(null);
        }
      }
    });
    return () => {
      live = false;
    };
  });

  if (!site || !current || !recon) return <main className="page" />;
  const m: ReportModel = { site, current, previous, register, cmp, recon, number, issuedAt, issuedBy, code };
  const changed = Boolean(latest && !pending && liveDigest && liveDigest !== latest.digestHex);

  const download = async (): Promise<void> => {
    if (!ref.current) return;
    const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${m.number} · ${site.name}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@400;500&family=Atkinson+Hyperlegible+Next:wght@400;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap"><style>${REPORT_CSS}</style></head><body><main id="dms-report" data-code="${code ?? ''}" data-number="${m.number}">${ref.current.innerHTML}</main></body></html>`;
    const name = `${m.number}-${site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`;
    const r = await saveFile(rt, name, html, 'text/html');
    if (r === 'saved') say(`${name} saved. Open it in a browser to print or save as PDF.`);
    else if (r === 'unavailable') say('Saving files is not available in this view', 'error');
  };

  return (
    <main className="page">
      <div className="page-head">
        <div className="page-head__text">
          <Label>ASSET VERIFICATION REPORT · {m.number}</Label>
          <h1 className="ui-title-l">
            {site.name}, walk of {current.walk.startedAt ? fmtDayMonth(current.walk.startedAt) : 'today'}
          </h1>
          <p className="ui-body-s muted">
            Method and limits come before the findings. The verification code is the SHA-256 of the report's text, so changing one word changes the code.
          </p>
        </div>
        <div className="page-head__actions">
          {latest && !pending ? (
            <span className="ui-body-s">
              Issued {fmtDateTime(latest.issuedAt)} · <span className="data-m">{formatVerificationCode(latest.code)}</span>
            </span>
          ) : null}
          <Btn
            variant={latest && !changed ? 'secondary' : 'primary'}
            icon="verified"
            disabled={!approved || Boolean(pending) || (Boolean(latest) && !changed)}
            onClick={() => setPending({ issuedAt: new Date().toISOString(), number: latest ? `DMS-${dateKey}-${String(issued.length + 1).padStart(3, '0')}` : number })}
          >
            {pending ? 'Issuing…' : latest ? 'Issue a new version' : 'Issue the report'}
          </Btn>
          <Btn icon="download" onClick={() => void download()} disabled={!latest || changed}>
            Download
          </Btn>
          {window.self === window.top ? (
            <Btn icon="report" onClick={() => window.print()}>
              Print or save as PDF
            </Btn>
          ) : null}
        </div>
      </div>
      {!approved ? (
        <div style={{ paddingBottom: 12 }}>
          <Note tone="warn" icon="info">
            A draft. The report can be issued once the walk is approved, so that every line in it has a named reviewer's decision.
          </Note>
        </div>
      ) : null}
      {changed ? (
        <div style={{ paddingBottom: 12 }}>
          <Note tone="warn" icon="info">
            The walk has changed since this report was issued, so its text no longer matches code {formatVerificationCode(latest?.code ?? '')}. Issue a new version.
          </Note>
        </div>
      ) : null}
      <div className="sheets">
        <div className="sheet-wrap" data-draft={!code ? '' : undefined} ref={ref} id="dms-report" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <ReportSheets m={m} />
        </div>
        <a href="#verify" className="ui-body-s">
          Check a code or a downloaded report
        </a>
      </div>
    </main>
  );
}
